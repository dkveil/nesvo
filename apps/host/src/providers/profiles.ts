import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';
import {
  providerProfileListSchema,
  providerProfileSchema,
  type CreateProviderProfileInput,
  type Provider,
  type ProviderProfile,
  type RenameProviderProfileInput,
} from '@nesvo/contracts';
import { SessionError } from '../sessions/session-error';

const execute = promisify(execFile);
const directoryKey = (path: string) =>
  process.platform === 'win32' ? path.toLowerCase() : path;

async function ownedDirectory(path: string, signal: AbortSignal) {
  try {
    if (!isAbsolute(path)) throw new Error();
    const canonical = await realpath(path);
    const info = await stat(canonical);
    if (!info.isDirectory() || canonical.length > 4096) throw new Error();
    if (process.platform === 'win32') {
      const system = process.env.SystemRoot ?? 'C:/Windows';
      const { stdout } = await execute(
        join(system, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          "$ErrorActionPreference = 'Stop'; $acl = Get-Acl -LiteralPath $env:NESVO_PROFILE_DIRECTORY; $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -eq [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
        ],
        {
          env: { ...process.env, NESVO_PROFILE_DIRECTORY: canonical },
          signal,
          timeout: 5_000,
          maxBuffer: 4096,
          windowsHide: true,
        },
      );
      if (stdout.trim() !== 'True') throw new Error();
    } else if (process.getuid?.() !== info.uid) throw new Error();
    signal.throwIfAborted();
    return canonical;
  } catch {
    signal.throwIfAborted();
    throw new SessionError(
      'invalid-directory',
      'Choose an existing absolute configuration directory owned by the host user.',
    );
  }
}

export const profileEnvironment = (provider: Provider, directory?: string) =>
  directory
    ? { [provider === 'Codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR']: directory }
    : undefined;

export function providerEnvironment(
  overrides?: Readonly<Record<string, string>>,
) {
  const environment = { ...process.env };
  if (process.platform === 'win32' && overrides) {
    const names = new Set(Object.keys(overrides).map(key => key.toUpperCase()));
    for (const key of Object.keys(environment))
      if (names.has(key.toUpperCase())) delete environment[key];
  }
  return { ...environment, ...overrides };
}

const columns = 'id, provider, label, config_directory AS configDirectory';

export class ProviderProfiles {
  constructor(private readonly database: DatabaseSync) {}

  list(): ProviderProfile[] {
    return providerProfileListSchema.parse(
      this.database
        .prepare(
          `SELECT ${columns} FROM provider_profiles ORDER BY label COLLATE NOCASE, id`,
        )
        .all(),
    );
  }

  alias(provider: Provider, alias?: string) {
    if (!alias || alias === 'default') return null;
    const available = this.list().filter(
      profile => profile.provider === provider && profile.label === alias,
    );
    return available.length === 1 ? available[0]!.id : undefined;
  }

  async create(input: CreateProviderProfileInput, signal: AbortSignal) {
    const path = await ownedDirectory(input.configDirectory, signal);
    const profiles = this.list();
    if (
      profiles.some(
        profile =>
          profile.provider === input.provider &&
          directoryKey(profile.configDirectory) === directoryKey(path),
      )
    )
      throw new SessionError(
        'invalid-request',
        'This configuration directory is already registered for the provider.',
      );
    if (profiles.length >= 64)
      throw new SessionError(
        'invalid-request',
        'This computer has reached the provider account limit.',
      );
    this.database
      .prepare(
        'INSERT INTO provider_profiles (id, provider, label, config_directory, directory_key) VALUES (?, ?, ?, ?, ?)',
      )
      .run(randomUUID(), input.provider, input.label, path, directoryKey(path));
    return this.list();
  }

  rename({ profileId, label }: RenameProviderProfileInput) {
    const result = this.database
      .prepare('UPDATE provider_profiles SET label = ? WHERE id = ?')
      .run(label, profileId);
    if (!result.changes)
      throw new SessionError('not-found', 'Provider account not found.');
    return this.list();
  }

  remove(profileId: string) {
    if (
      this.database
        .prepare('SELECT 1 FROM sessions WHERE profile_id = ? LIMIT 1')
        .get(profileId)
    )
      throw new SessionError(
        'invalid-request',
        'This account is in use by a session.',
      );
    if (
      this.database
        .prepare(
          "SELECT 1 FROM session_groups WHERE json_extract(defaults, '$.profileId') = ? LIMIT 1",
        )
        .get(profileId)
    )
      throw new SessionError(
        'invalid-request',
        'Clear this account from group defaults before removing it.',
      );
    this.database
      .prepare('DELETE FROM provider_profiles WHERE id = ?')
      .run(profileId);
    return this.list();
  }

  require(provider: Provider, id?: string | null): ProviderProfile | undefined {
    if (!id) return undefined;
    const row = this.database
      .prepare(
        `SELECT ${columns} FROM provider_profiles WHERE id = ? AND provider = ?`,
      )
      .get(id, provider);
    if (!row)
      throw new SessionError(
        'invalid-request',
        'The selected account is unavailable for this provider.',
      );
    return providerProfileSchema.parse(row);
  }

  async directory(
    provider: Provider,
    id: string | null | undefined,
    signal: AbortSignal,
  ) {
    const profile = this.require(provider, id);
    if (!profile) return undefined;
    const canonical = await ownedDirectory(profile.configDirectory, signal);
    if (directoryKey(canonical) !== directoryKey(profile.configDirectory))
      throw new SessionError(
        'invalid-directory',
        'The account directory now points to a different location.',
      );
    return canonical;
  }
}
