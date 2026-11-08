import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import { constants } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  mobileDeviceSchema,
  mobileLimits,
  type MobileDevice,
  type MobilePairResponse,
} from '@nesvo/contracts';

type StoredDevice = MobileDevice & { tokenHash: string };
type StoredState = { version: 1; serverId: string; devices: StoredDevice[] };
const storageLimit = 64 * 1024;
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;

function hash(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

function matches(value: string, expected: string) {
  return timingSafeEqual(
    Buffer.from(hash(value), 'hex'),
    Buffer.from(expected, 'hex'),
  );
}

function metadata(device: StoredDevice): MobileDevice {
  return {
    id: device.id,
    name: device.name,
    createdAt: device.createdAt,
    lastSeenAt: device.lastSeenAt,
  };
}

export class MobilePairingStore {
  private writing: Promise<void> = Promise.resolve();
  private readonly revoked = new Set<string>();
  private readonly touched = new Map<string, number>();
  private pairing: { hash: string; expiresAt: number } | undefined;

  private constructor(
    private readonly directory: string,
    private state: StoredState,
  ) {}

  static async open(directory: string) {
    const path = resolve(directory);
    try {
      await mkdir(path, { recursive: true, mode: 0o700 });
      const info = await lstat(path);
      const canonical = await realpath(path);
      if (
        !info.isDirectory() ||
        info.isSymbolicLink() ||
        (process.getuid && info.uid !== process.getuid()) ||
        (process.platform !== 'win32' && (info.mode & 0o077) !== 0) ||
        (process.platform === 'win32'
          ? canonical.toLowerCase() !== path.toLowerCase()
          : canonical !== path)
      )
        throw new Error('Private directory required.');
      const destination = join(path, 'pairing.json');
      let state: StoredState;
      try {
        const fileInfo = await lstat(destination);
        if (
          !fileInfo.isFile() ||
          fileInfo.isSymbolicLink() ||
          (process.getuid && fileInfo.uid !== process.getuid()) ||
          (process.platform !== 'win32' && (fileInfo.mode & 0o077) !== 0)
        )
          throw new Error('Private file required.');
        const file = await open(
          destination,
          constants.O_RDONLY |
            (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW),
        );
        let content: string;
        try {
          const bytes = Buffer.alloc(storageLimit + 1);
          const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
          if (bytesRead > storageLimit)
            throw new Error('Storage limit exceeded.');
          content = new TextDecoder('utf-8', { fatal: true }).decode(
            bytes.subarray(0, bytesRead),
          );
        } finally {
          await file.close();
        }
        const saved = JSON.parse(content) as StoredState;
        if (
          saved.version !== 1 ||
          typeof saved.serverId !== 'string' ||
          !/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i.test(
            saved.serverId,
          ) ||
          !Array.isArray(saved.devices) ||
          saved.devices.length > mobileLimits.devices
        )
          throw new Error('Invalid stored identity.');
        const devices = saved.devices.map(device => {
          const entry = mobileDeviceSchema.parse(metadata(device));
          if (
            typeof device.tokenHash !== 'string' ||
            !/^[\da-f]{64}$/.test(device.tokenHash)
          )
            throw new Error('Invalid stored token hash.');
          return { ...entry, tokenHash: device.tokenHash };
        });
        if (
          new Set(devices.map(device => device.id)).size !== devices.length ||
          new Set(devices.map(device => device.tokenHash)).size !==
            devices.length
        )
          throw new Error('Duplicate stored device.');
        state = { version: 1, serverId: saved.serverId, devices };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        state = { version: 1, serverId: randomUUID(), devices: [] };
      }
      const store = new MobilePairingStore(path, state);
      await store.save(state);
      return store;
    } catch {
      throw new Error(
        'Mobile pairing storage must be private, owned and readable. Restore its saved identity before enabling mobile access.',
      );
    }
  }

  get serverId() {
    return this.state.serverId;
  }
  list() {
    return this.state.devices
      .filter(device => !this.revoked.has(device.id))
      .map(metadata);
  }

  createPairing() {
    if (this.list().length >= mobileLimits.devices)
      throw new Error('Revoke a mobile device before pairing another.');
    const secret = randomBytes(32).toString('base64url');
    const expiresAt = Date.now() + mobileLimits.pairingMs;
    this.pairing = { hash: hash(secret), expiresAt };
    return { secret, expiresAt: new Date(expiresAt).toISOString() };
  }

  clearPairing() {
    this.pairing = undefined;
  }

  async pair(secret: string, name: string): Promise<MobilePairResponse | null> {
    const pairing = this.pairing;
    if (
      !tokenPattern.test(secret) ||
      !pairing ||
      Date.now() >= pairing.expiresAt ||
      !matches(secret, pairing.hash)
    )
      return null;
    this.pairing = undefined;
    const token = randomBytes(32).toString('base64url');
    const device: StoredDevice = {
      id: randomUUID(),
      name,
      createdAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
      tokenHash: hash(token),
    };
    await this.change(state => {
      if (state.devices.length >= mobileLimits.devices)
        throw new Error('Mobile device limit reached.');
      state.devices.push(device);
    });
    return { serverId: this.serverId, deviceId: device.id, token };
  }

  authenticate(token: string): MobileDevice | null {
    if (!tokenPattern.test(token)) return null;
    const device = this.state.devices.find(
      entry => !this.revoked.has(entry.id) && matches(token, entry.tokenHash),
    );
    if (!device) return null;
    if (Date.now() >= (this.touched.get(device.id) ?? 0)) {
      this.touched.set(device.id, Date.now() + 60_000);
      void this.change(state => {
        const current = state.devices.find(entry => entry.id === device.id);
        if (current) current.lastSeenAt = new Date().toISOString();
      }).catch(() => undefined);
    }
    return metadata(device);
  }

  active(deviceId: string) {
    return (
      !this.revoked.has(deviceId) &&
      this.state.devices.some(device => device.id === deviceId)
    );
  }

  async revoke(deviceId: string) {
    if (!this.state.devices.some(device => device.id === deviceId)) return;
    this.revoked.add(deviceId);
    await this.change(state => {
      state.devices = state.devices.filter(device => device.id !== deviceId);
    });
    this.revoked.delete(deviceId);
    this.touched.delete(deviceId);
  }

  async flush() {
    await this.writing;
  }

  private change(update: (state: StoredState) => void) {
    const pending = this.writing
      .catch(() => undefined)
      .then(async () => {
        const next = structuredClone(this.state);
        update(next);
        await this.save(next);
        this.state = next;
      });
    this.writing = pending;
    return pending;
  }

  private async save(state: StoredState) {
    const temporary = join(this.directory, `pairing.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, JSON.stringify(state), {
        mode: 0o600,
        flag: 'wx',
        flush: true,
      });
      await rename(temporary, join(this.directory, 'pairing.json'));
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }
}
