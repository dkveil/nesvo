import type { DatabaseSync } from 'node:sqlite';
import {
  directCommandSchema,
  type setupProfileDirectCommandSchema,
} from '@nesvo/contracts';
import type { z } from 'zod';
import { activeSetupProfile } from './setup-profile-service';
import {
  readSetupProfile,
  type LoadedSetupProfile,
} from './setup-profile-file';

type Binding = {
  profile: string;
  declaration: string;
  revision: string;
  fingerprint: string;
  generation: number;
  revoked: number;
};

export function nativeProfileCommand(
  input: z.infer<typeof setupProfileDirectCommandSchema>,
) {
  const { environment, ...command } = input;
  if (environment?.length)
    throw new Error(
      'This domain cannot bind the requested command environment references.',
    );
  return directCommandSchema.parse(command);
}

export function installSetupNativeBindings(database: DatabaseSync) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS setup_native_bindings (
      domain TEXT NOT NULL,
      id TEXT NOT NULL,
      profile TEXT NOT NULL,
      declaration TEXT NOT NULL,
      revision TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      generation INTEGER NOT NULL DEFAULT 0,
      revoked INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (domain, id)
    )
  `);
}

export class SetupNativeBindings {
  constructor(
    private readonly database: DatabaseSync,
    private readonly domain: string,
  ) {}

  get(id: string) {
    return this.database
      .prepare(
        'SELECT * FROM setup_native_bindings WHERE domain = ? AND id = ?',
      )
      .get(this.domain, id) as Binding | undefined;
  }

  passes(id: string) {
    const binding = this.get(id);
    if (!binding) return true;
    const selected = activeSetupProfile(this.database);
    if (!this.matches(binding, selected)) return false;
    try {
      return this.matches(binding, readSetupProfile(binding.profile));
    } catch {
      return false;
    }
  }

  private matches(binding: Binding, profile: LoadedSetupProfile | undefined) {
    return (
      !binding.revoked &&
      profile?.path === binding.profile &&
      profile.declarations.some(
        entry =>
          entry.key === binding.declaration &&
          entry.revision === binding.revision,
      )
    );
  }

  bind(
    id: string,
    profile: LoadedSetupProfile,
    declaration: string,
    revision: string,
    fingerprint: string,
    generation = 0,
  ) {
    this.database
      .prepare(
        `
      INSERT INTO setup_native_bindings (domain, id, profile, declaration, revision, fingerprint, generation)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(domain, id) DO UPDATE SET profile = excluded.profile,
        declaration = excluded.declaration, revision = excluded.revision,
        fingerprint = excluded.fingerprint, revoked = 0
    `,
      )
      .run(
        this.domain,
        id,
        profile.path,
        declaration,
        revision,
        fingerprint,
        generation,
      );
  }

  revoke(id: string) {
    this.database
      .prepare(
        `
      UPDATE setup_native_bindings SET revoked = 1, generation = generation + 1
      WHERE domain = ? AND id = ? AND revoked = 0
    `,
      )
      .run(this.domain, id);
  }

  reconcile(profile: LoadedSetupProfile | null) {
    const rows = this.database
      .prepare(
        'SELECT * FROM setup_native_bindings WHERE domain = ? AND revoked = 0',
      )
      .all(this.domain);
    const retired: string[] = [];
    for (const row of rows) {
      const binding = row as unknown as Binding & { id: string };
      if (!this.matches(binding, profile ?? undefined)) {
        this.revoke(binding.id);
        retired.push(binding.id);
      }
    }
    return retired;
  }
}
