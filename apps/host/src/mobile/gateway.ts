import {
  createServer as httpServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { createServer as httpsServer } from 'node:https';
import { type Socket } from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';
import {
  mobileAuthenticateSchema,
  mobileCommandResponseSchema,
  mobileCommandSchema,
  mobileComputerSchema,
  mobileGatewayStatusSchema,
  mobileLimits,
  mobilePairRequestSchema,
  mobileServerMessageSchema,
  mobileSnapshotSchema,
  type DesktopApi,
  type MobileComputer,
  type MobileError,
  type MobileGatewayStatus,
  type MobilePairing,
  type MobileSnapshot,
  type WorkspaceEvent,
} from '@nesvo/contracts';
import { MobilePairingStore } from './pairing';

export type MobileGatewayWorkspace = Pick<
  DesktopApi,
  | 'listComputers'
  | 'listSessions'
  | 'sendMessage'
  | 'stopRun'
  | 'respondApproval'
  | 'decideDelegation'
  | 'subscribe'
>;
export type MobileGatewayOptions = {
  directory: string;
  workspace: MobileGatewayWorkspace;
  network?: {
    host?: string;
    port?: number;
    publicUrl?: string;
    tls?: { cert: string; key: string };
    trustedProxy?: boolean;
  };
};
type Client = {
  ws: WebSocket;
  deviceId?: string;
  buffering: boolean;
  buffered: string[];
  bytes: number;
  alive: boolean;
};
type HttpRequest = { deviceId: string; response: ServerResponse };
class GatewayError extends Error {
  constructor(
    readonly code: MobileError['code'],
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}
const loopbacks = new Set(['127.0.0.1', '::1', 'localhost']);
function publicComputer(
  computer: Awaited<ReturnType<DesktopApi['listComputers']>>[number],
): MobileComputer {
  return mobileComputerSchema.parse({
    id: computer.id,
    name: computer.name,
    kind: computer.kind,
    status: computer.status,
    lastSyncedAt: computer.lastSyncedAt,
  });
}
function json(value: unknown) {
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text) > mobileLimits.responseBytes)
    throw new GatewayError(
      'too-large',
      'This workspace exceeds the mobile transport limit. Open it on desktop.',
      413,
    );
  return text;
}
async function deadline<T>(operation: Promise<T>, timeout = 25000) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new GatewayError(
                'unavailable',
                'The response could not be confirmed. Refresh state before retrying; the operation may have completed.',
                503,
              ),
            ),
          timeout,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function body(request: IncomingMessage) {
  if (
    request.headers['content-type']?.split(';')[0]?.trim() !==
    'application/json'
  )
    throw new GatewayError(
      'invalid-request',
      'Use an application/json request.',
    );
  const content = Buffer.alloc(mobileLimits.requestBytes);
  let size = 0;
  for await (const data of request) {
    const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data as string);
    if (size + bytes.length > mobileLimits.requestBytes)
      throw new GatewayError('too-large', 'The request is too large.', 413);
    bytes.copy(content, size);
    size += bytes.length;
  }
  try {
    return JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(
        content.subarray(0, size),
      ),
    ) as unknown;
  } catch {
    throw new GatewayError(
      'invalid-request',
      'The request must contain valid JSON.',
    );
  }
}

export class MobileGateway {
  private server: ReturnType<typeof httpServer> | undefined;
  private websockets: WebSocketServer | undefined;
  private readonly sockets = new Set<Socket>();
  private readonly clients = new Set<Client>();
  private readonly requests = new Set<HttpRequest>();
  private readonly rates = new Map<
    string,
    { expiresAt: number; count: number }
  >();
  private unsubscribe: (() => void) | undefined;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private transition: Promise<unknown> = Promise.resolve();
  private accepting = false;
  private sequence = 0;
  private url: string | null = null;
  private readonly host: string;
  private readonly port: number;
  private readonly configuredUrl: URL | undefined;

  constructor(
    private readonly options: MobileGatewayOptions,
    private readonly store: MobilePairingStore,
  ) {
    this.host = options.network?.host ?? '127.0.0.1';
    this.port = options.network?.port ?? 0;
    if (!Number.isInteger(this.port) || this.port < 0 || this.port > 65535)
      throw new Error('Use a valid mobile gateway port.');
    if (options.network?.publicUrl) {
      const url = new URL(options.network.publicUrl);
      if (
        !['http:', 'https:'].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        url.pathname !== '/'
      )
        throw new Error(
          'The mobile public URL must be an HTTP(S) origin without credentials or a path.',
        );
      this.configuredUrl = url;
    }
    const tls = options.network?.tls;
    if (
      !loopbacks.has(this.host) &&
      (!tls || this.configuredUrl?.protocol !== 'https:')
    )
      throw new Error(
        'An external mobile listener requires TLS and an explicit HTTPS public URL.',
      );
    if (tls && this.configuredUrl && this.configuredUrl.protocol !== 'https:')
      throw new Error('Use an HTTPS public URL with a TLS listener.');
    if (
      !tls &&
      this.configuredUrl?.protocol === 'https:' &&
      (!loopbacks.has(this.host) || options.network?.trustedProxy !== true)
    )
      throw new Error(
        'A trusted HTTPS proxy must be explicitly configured over a loopback listener.',
      );
    if (
      !tls &&
      this.configuredUrl?.protocol === 'http:' &&
      !loopbacks.has(this.configuredUrl.hostname.replace(/^\[|\]$/g, ''))
    )
      throw new Error('Plain HTTP mobile access is limited to loopback.');
  }

  status(): MobileGatewayStatus {
    return mobileGatewayStatusSchema.parse({
      enabled: this.accepting,
      serverId: this.store.serverId,
      url: this.accepting ? this.url : null,
      clients: [...this.clients].filter(
        client => client.deviceId && client.ws.readyState === WebSocket.OPEN,
      ).length,
      devices: this.store.list(),
    });
  }

  start(): Promise<MobileGatewayStatus> {
    return this.serialize(async () => {
      if (this.accepting) return this.status();
      const server = this.options.network?.tls
        ? httpsServer({ ...this.options.network.tls, handshakeTimeout: 5000 })
        : httpServer();
      this.server = server;
      const websockets = new WebSocketServer({
        noServer: true,
        maxPayload: 4096,
        perMessageDeflate: false,
        clientTracking: false,
      });
      this.websockets = websockets;
      server.headersTimeout = 5000;
      server.requestTimeout = 10000;
      server.keepAliveTimeout = 5000;
      server.maxConnections = 32;
      server.setTimeout(35000, socket => socket.destroy());
      server.on('connection', socket => {
        this.sockets.add(socket);
        socket.once('close', () => this.sockets.delete(socket));
      });
      server.on('clientError', (_error, socket) => socket.destroy());
      server.on('request', (request, response) => {
        void this.handle(request, response);
      });
      server.on('upgrade', (request, socket, head) => {
        try {
          this.checkRequest(request);
          if (
            request.url !== '/v1/events' ||
            this.clients.size >= mobileLimits.clients ||
            !this.rate(`ws:${request.socket.remoteAddress}`, 20)
          ) {
            socket.destroy();
            return;
          }
          websockets.handleUpgrade(request, socket, head, ws =>
            this.accept(ws),
          );
        } catch {
          socket.destroy();
        }
      });
      server.on('error', () => undefined);
      try {
        await new Promise<void>((resolve, reject) => {
          server.once('error', reject);
          server.listen(this.port, this.host, () => {
            server.off('error', reject);
            resolve();
          });
        });
        const address = server.address();
        if (!address || typeof address === 'string')
          throw new Error('No mobile listener address.');
        const host = this.host === '::1' ? '[::1]' : this.host;
        this.url =
          this.configuredUrl?.origin ??
          `${this.options.network?.tls ? 'https' : 'http'}://${host}:${address.port}`;
        this.accepting = true;
        this.unsubscribe = this.options.workspace.subscribe(event =>
          this.publish(event),
        );
        this.heartbeat = setInterval(() => {
          for (const client of this.clients) {
            if (client.ws.readyState !== WebSocket.OPEN) continue;
            if (!client.alive) {
              client.ws.terminate();
              continue;
            }
            client.alive = false;
            client.ws.ping();
          }
        }, 30000);
        this.heartbeat.unref();
        return this.status();
      } catch {
        await this.closeServer();
        throw new Error(
          'Mobile access could not start. Check its address and TLS configuration.',
        );
      }
    });
  }

  stop(): Promise<MobileGatewayStatus> {
    this.accepting = false;
    this.store.clearPairing();
    return this.serialize(async () => {
      await this.closeServer();
      await this.store.flush().catch(() => undefined);
      return this.status();
    });
  }

  async createPairing(): Promise<MobilePairing> {
    if (!this.accepting || !this.url)
      throw new Error('Enable mobile access before creating a pairing link.');
    const pairing = this.store.createPairing();
    const fragment = new URLSearchParams({
      url: this.url,
      serverId: this.store.serverId,
      secret: pairing.secret,
    });
    return {
      serverId: this.store.serverId,
      link: `nesvo://pair#${fragment}`,
      expiresAt: pairing.expiresAt,
    };
  }

  async revoke(deviceId: string): Promise<MobileGatewayStatus> {
    for (const client of this.clients)
      if (client.deviceId === deviceId)
        this.rejectClient(
          client,
          'revoked',
          'This mobile device was revoked.',
          4001,
        );
    for (const request of this.requests)
      if (request.deviceId === deviceId) request.response.destroy();
    await this.store.revoke(deviceId);
    return this.status();
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.transition.catch(() => undefined).then(operation);
    this.transition = pending;
    return pending;
  }

  private async closeServer() {
    this.accepting = false;
    this.store.clearPairing();
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    clearInterval(this.heartbeat);
    for (const client of this.clients) client.ws.terminate();
    for (const socket of this.sockets) socket.destroy();
    if (this.server)
      await new Promise<void>(resolve => this.server!.close(() => resolve()));
    this.websockets?.close();
    this.websockets = undefined;
    this.server = undefined;
    this.url = null;
  }

  private rate(key: string, limit: number) {
    const now = Date.now();
    for (const [id, entry] of this.rates)
      if (entry.expiresAt <= now) this.rates.delete(id);
    let state = this.rates.get(key);
    if (!state) {
      if (this.rates.size >= 128) return false;
      state = { expiresAt: now + 60000, count: 0 };
      this.rates.set(key, state);
    }
    return ++state.count <= limit;
  }

  private checkRequest(request: IncomingMessage) {
    if (!this.accepting || !this.url)
      throw new GatewayError('unavailable', 'Mobile access is disabled.', 503);
    const origin = request.headers.origin;
    if (origin && origin !== new URL(this.url).origin)
      throw new GatewayError(
        'unauthorized',
        'This origin is not allowed.',
        403,
      );
    const host = request.headers.host;
    const address = this.server?.address();
    const localHost =
      address && typeof address !== 'string'
        ? `${this.host === '::1' ? '[::1]' : this.host}:${address.port}`
        : '';
    if (!host || ![new URL(this.url).host, localHost].includes(host))
      throw new GatewayError('unauthorized', 'This host is not allowed.', 403);
    if (!this.rate(`http:${request.socket.remoteAddress}`, 180))
      throw new GatewayError(
        'busy',
        'Too many requests. Wait before retrying.',
        429,
      );
  }

  private authenticate(request: IncomingMessage) {
    const match = /^Bearer ([A-Za-z0-9_-]{43})$/i.exec(
      request.headers.authorization ?? '',
    );
    const device = match ? this.store.authenticate(match[1]!) : null;
    if (!device)
      throw new GatewayError(
        'unauthorized',
        'Pair this device again to connect.',
        401,
      );
    return device;
  }

  private reply(response: ServerResponse, status: number, value: unknown) {
    if (response.destroyed || response.writableEnded) return;
    const payload = json(value);
    response.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
    });
    response.end(payload);
  }

  private async handle(request: IncomingMessage, response: ServerResponse) {
    let active: HttpRequest | undefined;
    let commandId: string | null = null;
    try {
      this.checkRequest(request);
      if (request.method === 'GET' && request.url === '/health') {
        this.reply(response, 200, {
          serverId: this.store.serverId,
          protocolVersion: 1,
        });
        return;
      }
      if (request.method === 'POST' && request.url === '/v1/pair') {
        if (!this.rate(`pair:${request.socket.remoteAddress}`, 10))
          throw new GatewayError(
            'busy',
            'Wait before trying to pair again.',
            429,
          );
        const parsed = mobilePairRequestSchema.safeParse(
          await deadline(body(request), 10000),
        );
        if (!parsed.success || parsed.data.serverId !== this.store.serverId)
          throw new GatewayError(
            'unauthorized',
            'The pairing link is invalid or expired.',
            401,
          );
        const paired = await deadline(
          this.store.pair(parsed.data.secret, parsed.data.name),
        );
        if (!paired)
          throw new GatewayError(
            'unauthorized',
            'The pairing link is invalid or expired.',
            401,
          );
        if (!this.accepting)
          throw new GatewayError(
            'unavailable',
            'Mobile access is disabled.',
            503,
          );
        this.reply(response, 200, paired);
        return;
      }
      const device = this.authenticate(request);
      if (
        this.requests.size >= 16 ||
        [...this.requests].filter(entry => entry.deviceId === device.id)
          .length >= 2
      )
        throw new GatewayError(
          'busy',
          'This connection is busy. Wait before retrying.',
          429,
        );
      active = { deviceId: device.id, response };
      this.requests.add(active);
      if (request.method === 'GET' && request.url === '/v1/snapshot') {
        if (!this.rate(`read:${device.id}`, 30))
          throw new GatewayError('busy', 'Wait before refreshing again.', 429);
        const snapshot = await deadline(this.snapshot());
        this.checkDevice(device.id);
        this.reply(response, 200, snapshot);
        return;
      }
      if (request.method !== 'POST' || request.url !== '/v1/command')
        throw new GatewayError(
          'invalid-request',
          'This mobile endpoint is not available.',
          404,
        );
      if (!this.rate(`command:${device.id}`, 60))
        throw new GatewayError(
          'busy',
          'Wait before sending another command.',
          429,
        );
      const parsed = mobileCommandSchema.safeParse(
        await deadline(body(request), 10000),
      );
      if (!parsed.success)
        throw new GatewayError(
          'invalid-request',
          'This mobile command is not supported.',
        );
      commandId = parsed.data.id;
      this.checkDevice(device.id);
      const command = parsed.data;
      const workspace = this.options.workspace;
      const operation =
        command.method === 'send-message'
          ? workspace.sendMessage(command.input, command.hostId)
          : command.method === 'stop-run'
            ? workspace.stopRun(command.input, command.hostId)
            : command.method === 'respond-approval'
              ? workspace.respondApproval(command.input, command.hostId)
              : workspace.decideDelegation(command.input, command.hostId);
      const session = await deadline(operation);
      this.checkDevice(device.id);
      this.reply(
        response,
        200,
        mobileCommandResponseSchema.parse({
          type: 'session',
          id: command.id,
          session,
        }),
      );
    } catch (error) {
      const known =
        error instanceof GatewayError
          ? error
          : new GatewayError(
              'unavailable',
              'The request could not be confirmed. Refresh state before retrying.',
              503,
            );
      this.reply(response, known.status, {
        type: 'error',
        id: commandId,
        code: known.code,
        message: known.message,
      });
    } finally {
      if (active) this.requests.delete(active);
    }
  }

  private checkDevice(deviceId: string) {
    if (!this.accepting)
      throw new GatewayError('unavailable', 'Mobile access is disabled.', 503);
    if (!this.store.active(deviceId))
      throw new GatewayError('revoked', 'This mobile device was revoked.', 401);
  }

  private async snapshot(): Promise<MobileSnapshot> {
    const sequence = this.sequence;
    const [computers, sessions] = await Promise.all([
      this.options.workspace.listComputers(),
      this.options.workspace.listSessions(),
    ]);
    if (sessions.length > mobileLimits.sessions || computers.length > 9)
      throw new GatewayError(
        'too-large',
        'This workspace exceeds the mobile snapshot limit. Open it on desktop.',
        413,
      );
    const snapshot = mobileSnapshotSchema.parse({
      serverId: this.store.serverId,
      sequence,
      computers: computers.map(publicComputer),
      sessions,
    });
    json(snapshot);
    return snapshot;
  }

  private send(client: Client, payload: string) {
    if (client.ws.readyState !== WebSocket.OPEN) return;
    if (
      client.ws.bufferedAmount + Buffer.byteLength(payload) >
      mobileLimits.responseBytes
    ) {
      this.rejectClient(
        client,
        'too-large',
        'The connection is too far behind. Reconnect to refresh its state.',
        1009,
      );
      return;
    }
    client.ws.send(payload);
  }

  private rejectClient(
    client: Client,
    code: MobileError['code'],
    message: string,
    closeCode = 1008,
  ) {
    if (client.ws.readyState !== WebSocket.OPEN) {
      client.ws.terminate();
      return;
    }
    if (client.ws.bufferedAmount < 4096)
      client.ws.send(
        JSON.stringify({ type: 'error', id: null, code, message }),
      );
    client.ws.close(closeCode);
    const timer = setTimeout(() => client.ws.terminate(), 250);
    timer.unref();
    client.ws.once('close', () => clearTimeout(timer));
  }

  private accept(ws: WebSocket) {
    const client: Client = {
      ws,
      buffering: true,
      buffered: [],
      bytes: 0,
      alive: true,
    };
    this.clients.add(client);
    const timeout = setTimeout(
      () =>
        this.rejectClient(
          client,
          'unauthorized',
          'Authenticate before receiving workspace data.',
        ),
      5000,
    );
    ws.on('error', () => ws.terminate());
    ws.on('pong', () => {
      client.alive = true;
    });
    ws.once('close', () => {
      clearTimeout(timeout);
      this.clients.delete(client);
    });
    let authenticating = false;
    ws.on('message', (data, binary) => {
      if (client.deviceId || authenticating || binary) {
        this.rejectClient(
          client,
          'invalid-request',
          'Use HTTP for mobile commands.',
        );
        return;
      }
      let value: unknown;
      try {
        value = JSON.parse(
          new TextDecoder('utf-8', { fatal: true }).decode(
            Buffer.from(data as Buffer),
          ),
        );
      } catch {
        this.rejectClient(
          client,
          'invalid-request',
          'Invalid authentication frame.',
        );
        return;
      }
      const parsed = mobileAuthenticateSchema.safeParse(value);
      if (!parsed.success) {
        this.rejectClient(
          client,
          'protocol-mismatch',
          'Use a compatible mobile client.',
        );
        return;
      }
      if (parsed.data.serverId !== this.store.serverId) {
        this.rejectClient(
          client,
          'server-mismatch',
          'This is a different mobile gateway. Pair it explicitly.',
        );
        return;
      }
      const device = this.store.authenticate(parsed.data.token);
      if (!device) {
        this.rejectClient(
          client,
          'unauthorized',
          'Pair this device again to connect.',
        );
        return;
      }
      authenticating = true;
      client.deviceId = device.id;
      clearTimeout(timeout);
      void deadline(this.snapshot())
        .then(snapshot => {
          if (
            !this.accepting ||
            !this.store.active(device.id) ||
            ws.readyState !== WebSocket.OPEN
          )
            return;
          this.send(client, json({ type: 'snapshot', ...snapshot }));
          for (const event of client.buffered) this.send(client, event);
          client.buffered = [];
          client.bytes = 0;
          client.buffering = false;
        })
        .catch(error => {
          this.rejectClient(
            client,
            error instanceof GatewayError ? error.code : 'unavailable',
            'The workspace snapshot could not be delivered. Reconnect to refresh.',
          );
        });
    });
  }

  private publish(event: WorkspaceEvent) {
    if (!this.accepting || event.type === 'review-changed') return;
    try {
      const sequence = ++this.sequence;
      const value =
        event.type === 'computers-changed'
          ? {
              ...event,
              sequence,
              computers: event.computers.map(publicComputer),
            }
          : event.type === 'host-snapshot'
            ? {
                type: event.type,
                sequence,
                hostId: event.hostId,
                sessions: event.sessions,
              }
            : { ...event, sequence };
      const payload = json(mobileServerMessageSchema.parse(value));
      for (const client of this.clients) {
        if (!client.deviceId || !this.store.active(client.deviceId)) continue;
        if (client.buffering) {
          client.bytes += Buffer.byteLength(payload);
          if (
            client.buffered.length >= 128 ||
            client.bytes > mobileLimits.responseBytes
          )
            this.rejectClient(
              client,
              'too-large',
              'Too many changes arrived during synchronization. Reconnect.',
            );
          else client.buffered.push(payload);
        } else this.send(client, payload);
      }
    } catch {
      for (const client of this.clients)
        if (client.deviceId)
          this.rejectClient(
            client,
            'too-large',
            'This workspace update exceeds the mobile transport limit. Open it on desktop.',
            1009,
          );
    }
  }
}

export async function createMobileGateway(
  options: MobileGatewayOptions,
): Promise<MobileGateway> {
  return new MobileGateway(
    options,
    await MobilePairingStore.open(options.directory),
  );
}
