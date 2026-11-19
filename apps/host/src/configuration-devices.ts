import {
  configurationDeviceSchema,
  configurationFileAreaSchema,
  configurationFrameLimit,
  configurationLimits,
  configurationRequestSchema,
  configurationRevision,
  externalInboxLimits,
  type ConfigurationArea,
  type ConfigurationDevice,
  type ConfigurationEnroll,
  type ConfigurationError,
  type ConfigurationListInput,
  type ConfigurationResult,
  type ConfigurationTarget,
} from '@nesvo/contracts';
import { randomBytes, randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { configurationEndpoint } from './external-inbox-endpoint';
import { listenForDeviceRequests } from './external-inbox';
import {
  configurationHash,
  configurationText,
  ConfigurationRefusal,
  type ConfigurationChanges,
  type ConfigurationPrincipal,
  type ConfigurationVerb,
} from './workflows/configuration-changes';

const maxDeviceRequests = 60;
const maxDeviceMutations = 12;
const maxHostRequests = 300;

type Activity = { expires: number; reads: number; mutations: number };
type TargetCatalog = (
  area: ConfigurationArea,
  project: string | undefined,
  signal: AbortSignal,
) => Promise<ConfigurationTarget[]>;

function fromRow(row: Record<string, unknown>): ConfigurationDevice {
  return configurationDeviceSchema.parse({
    ...row,
    grants: JSON.parse(String(row.grants)),
  });
}

function scopeFor(target: ConfigurationTarget): string | undefined {
  return 'scope' in target && target.scope.kind === 'project'
    ? target.scope.root
    : undefined;
}

function hasGrant(
  device: ConfigurationDevice,
  verb: ConfigurationVerb,
  area: ConfigurationArea,
  project?: string,
) {
  return device.grants.some(
    grant =>
      grant.area === area &&
      grant.verbs.includes(verb) &&
      (project === undefined ? grant.global : grant.projects.includes(project)),
  );
}

export function configurationFailure(error: unknown): ConfigurationError {
  if (error instanceof ConfigurationRefusal)
    return {
      ok: false,
      code: error.code,
      message: error.message,
      issues: error.issues,
    };
  return {
    ok: false,
    code: 'unavailable',
    message: 'The configuration is unavailable.',
    issues: [],
  };
}

export class ConfigurationDevices {
  private readonly activity = new Map<string, Activity>();
  private hostActivity: Activity = { expires: 0, reads: 0, mutations: 0 };

  constructor(
    private readonly database: DatabaseSync,
    private readonly changes: ConfigurationChanges,
    private readonly instanceId: string,
    private readonly supported: readonly ConfigurationArea[],
    private readonly directTargets: readonly ConfigurationTarget[],
    private readonly catalog: TargetCatalog,
    private readonly resolveProject: (
      path: string,
      signal: AbortSignal,
    ) => Promise<string>,
  ) {}

  list() {
    return this.database
      .prepare(
        `
      SELECT id, name, created_at AS createdAt, grants FROM configuration_devices
      ORDER BY created_at, id
    `,
      )
      .all()
      .map(fromRow);
  }

  async enroll(input: ConfigurationEnroll, signal: AbortSignal) {
    if (configurationText(input.name) !== input.name)
      throw new ConfigurationRefusal(
        'invalid-request',
        'Choose a device name without credential-like text.',
      );
    const grants = [];
    for (const grant of input.grants) {
      const projects = [];
      if (!this.supported.includes(grant.area))
        throw new ConfigurationRefusal(
          'unsupported',
          'This computer does not support the requested area.',
        );
      for (const project of grant.projects) {
        if (
          !configurationFileAreaSchema.safeParse(grant.area).success ||
          !isAbsolute(project)
        )
          throw new ConfigurationRefusal(
            'invalid-request',
            'Choose a supported absolute project folder.',
          );
        projects.push(await this.resolveProject(project, signal));
      }
      grants.push({
        ...grant,
        projects: [...new Set(projects)],
        verbs: [...new Set(grant.verbs)],
      });
    }
    if (this.list().length >= externalInboxLimits.devices)
      throw new ConfigurationRefusal(
        'pending-limit',
        'Revoke a configuration device before enrolling another.',
      );
    const device = {
      id: randomUUID(),
      name: input.name,
      createdAt: new Date().toISOString(),
      grants,
    };
    const token = `${this.instanceId}.${randomBytes(32).toString('base64url')}`;
    this.database
      .prepare(
        `
      INSERT INTO configuration_devices (id, name, created_at, token_hash, grants) VALUES (?, ?, ?, ?, ?)
    `,
      )
      .run(
        device.id,
        device.name,
        device.createdAt,
        configurationHash(token),
        JSON.stringify(grants),
      );
    return { device, token };
  }

  revoke(id: string) {
    this.database
      .prepare('DELETE FROM configuration_devices WHERE id = ?')
      .run(id);
    this.activity.delete(id);
    return this.list();
  }

  canPropose(id: string, target: ConfigurationTarget) {
    const row = this.database
      .prepare(
        `
      SELECT id, name, created_at AS createdAt, grants FROM configuration_devices WHERE id = ?
    `,
      )
      .get(id);
    return (
      !!row && hasGrant(fromRow(row), 'propose', target.area, scopeFor(target))
    );
  }

  async execute(
    raw: unknown,
    signal: AbortSignal,
  ): Promise<ConfigurationResult> {
    try {
      const parsed = configurationRequestSchema.safeParse(raw);
      if (!parsed.success)
        throw new ConfigurationRefusal(
          'invalid-request',
          'The configuration request is invalid.',
        );
      const { token, command } = parsed.data;
      const select = this.database.prepare(`
        SELECT id, name, created_at AS createdAt, grants FROM configuration_devices WHERE token_hash = ?
      `);
      const fingerprint = configurationHash(token);
      const lookup = () => {
        const row = select.get(fingerprint);
        if (!row || signal.aborted || !token.startsWith(`${this.instanceId}.`))
          throw new ConfigurationRefusal(
            'unauthorized',
            'The configuration device grant is unavailable.',
          );
        return fromRow(row);
      };
      const device = lookup();
      const authorize = (
        verb: ConfigurationVerb,
        area: ConfigurationArea,
        project?: string,
      ) => {
        if (!this.supported.includes(area))
          throw new ConfigurationRefusal(
            'unsupported',
            'This computer does not support the requested area.',
          );
        if (!hasGrant(lookup(), verb, area, project))
          throw new ConfigurationRefusal(
            'unauthorized',
            'The device does not have this configuration grant.',
          );
      };
      const principal: ConfigurationPrincipal = {
        source: { kind: 'device', deviceId: device.id, name: device.name },
        authorize: (verb, target) =>
          authorize(verb, target.area, scopeFor(target)),
      };
      this.limit(
        device.id,
        command.operation === 'propose' || command.operation === 'apply',
      );
      switch (command.operation) {
        case 'capabilities':
          return {
            ok: true,
            kind: 'capabilities',
            capabilities: {
              instanceId: this.instanceId,
              revision: configurationRevision,
              grants: device.grants,
              directApply: this.directTargets.filter(target =>
                hasGrant(device, 'apply', target.area, scopeFor(target)),
              ),
              nameOnlyGroupRename: hasGrant(device, 'apply', 'session-groups'),
            },
          };
        case 'list':
          authorize('read', command.input.area, command.input.project);
          return {
            ok: true,
            kind: 'list',
            page: await this.page(principal, command.input, signal),
          };
        case 'get':
          return {
            ok: true,
            kind: 'read',
            target: await this.changes.get(principal, command.target),
          };
        case 'apply':
        case 'propose':
          return {
            ok: true,
            kind: 'submission',
            ...(await this.changes.submit(
              principal,
              command.operation,
              command.mutation,
            )),
          };
        case 'status':
          return {
            ok: true,
            kind: 'receipt',
            receipt: this.changes.status(principal, command.id),
          };
      }
    } catch (error) {
      return configurationFailure(error);
    }
  }

  listen() {
    return listenForDeviceRequests(
      configurationEndpoint(this.instanceId),
      configurationFrameLimit,
      (value, signal) => this.execute(value, signal),
    );
  }

  private limit(id: string, mutation: boolean) {
    const time = Date.now();
    const fresh = () => ({ expires: time + 60_000, reads: 0, mutations: 0 });
    const prior = this.activity.get(id);
    const device = prior && prior.expires > time ? prior : fresh();
    if (this.hostActivity.expires <= time) this.hostActivity = fresh();
    const hostRequests = this.hostActivity.reads + this.hostActivity.mutations;
    if (
      hostRequests >= maxHostRequests ||
      device.reads >= maxDeviceRequests ||
      (mutation && device.mutations >= maxDeviceMutations)
    )
      throw new ConfigurationRefusal(
        'rate-limit',
        'The configuration request limit was reached.',
      );
    if (mutation) {
      device.mutations++;
      this.hostActivity.mutations++;
    } else {
      device.reads++;
      this.hostActivity.reads++;
    }
    this.activity.set(id, device);
  }

  private async page(
    principal: ConfigurationPrincipal,
    input: ConfigurationListInput,
    signal: AbortSignal,
  ) {
    const catalog = await this.catalog(input.area, input.project, signal);
    const key = (target: ConfigurationTarget) =>
      'scope' in target
        ? target.name
        : 'key' in target
          ? target.key
          : target.id;
    const ordered = catalog
      .filter(target => key(target) > (input.cursor ?? ''))
      .sort((left, right) =>
        key(left) < key(right) ? -1 : key(left) > key(right) ? 1 : 0,
      );
    const slice = ordered.slice(0, configurationLimits.page);
    const targets = [];
    for (const target of slice) {
      const { version, withheld } = await this.changes.get(principal, target);
      targets.push({ target, version, withheld });
    }
    return {
      targets,
      next: ordered.length > slice.length ? key(slice.at(-1)!) : null,
    };
  }
}
