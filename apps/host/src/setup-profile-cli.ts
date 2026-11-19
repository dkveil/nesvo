import { randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseArgs } from 'node:util';
import {
  setupProfileDigestSchema,
  setupProfileInputSchema,
  type SetupProfileReview,
} from '@nesvo/contracts';
import { dump } from 'js-yaml';
import { lockDataDirectory, openDatabaseSync } from './database';
import { SetupProfileService } from './setup-profile-service';
import {
  defaultSetupProfilePath,
  SetupProfileFileError,
} from './setup-profile-file';
import { ConfigurationChangeStore } from './workflows/assistant-change-store';
import {
  ConfigurationChanges,
  ConfigurationRefusal,
} from './workflows/configuration-changes';

export const profileUsage =
  '  nesvo profile validate|diff|apply|export [file] [--data-dir <local host directory>] [--json]\n  Profile apply accepts --expect <digest> --effective-revision <revision> --action-id <id>.';
const localDirectory = () => {
  if (process.env.NESVO_DATA_DIR) return process.env.NESVO_DATA_DIR;
  const home = homedir();
  const support =
    process.platform === 'darwin'
      ? join(home, 'Library', 'Application Support')
      : process.platform === 'win32'
        ? (process.env.APPDATA ?? join(home, 'AppData', 'Roaming'))
        : (process.env.XDG_CONFIG_HOME ?? join(home, '.config'));
  return join(support, 'Nesvo', 'host');
};

function printable(view: SetupProfileReview) {
  return {
    ...view,
    runtimeChecks: view.declarations
      .filter(item => item.state === 'pending')
      .map(item => ({
        key: item.key,
        state: 'not checked',
        reason: 'Review identities and capabilities on the owning computer.',
      })),
  };
}

export async function runSetupProfileCli(args: string[]) {
  const print = (value: unknown) =>
    process.stdout.write(
      JSON.stringify(value, null, args.includes('--json') ? undefined : 2) +
        '\n',
    );
  let ownership: DatabaseSync | undefined;
  let database: DatabaseSync | undefined;
  try {
    const {
      values,
      positionals: [operation, file, ...extra],
    } = parseArgs({
      args,
      allowPositionals: true,
      options: {
        json: { type: 'boolean' },
        'data-dir': { type: 'string' },
        expect: { type: 'string' },
        'effective-revision': { type: 'string' },
        'action-id': { type: 'string' },
      },
    });
    const guarded =
      values.expect !== undefined || values['effective-revision'] !== undefined;
    if (
      extra.length ||
      !operation ||
      !['validate', 'diff', 'apply', 'export'].includes(operation) ||
      (operation !== 'apply' && (guarded || values['action-id'])) ||
      (guarded &&
        (!setupProfileDigestSchema.safeParse(values.expect).success ||
          !/^\d+$/.test(values['effective-revision'] ?? ''))) ||
      (values['data-dir'] && !isAbsolute(values['data-dir']))
    )
      throw new ConfigurationRefusal(
        'invalid-request',
        'Run nesvo --help for profile command usage.',
      );
    const directory = resolve(values['data-dir'] ?? localDirectory());
    if (operation === 'validate') {
      const view = new SetupProfileService(directory).inspect(file);
      print(printable(view));
      return view.revision ? 0 : 1;
    }
    if (existsSync(directory) || operation === 'apply') {
      if (existsSync(directory) && relative(realpathSync(directory), directory))
        throw new ConfigurationRefusal(
          'unauthorized',
          'Use a verified local data directory without symbolic links.',
        );
      try {
        ownership = lockDataDirectory(directory);
      } catch {
        throw new ConfigurationRefusal(
          'busy',
          'The local computer is in use or its data directory is unavailable.',
        );
      }
    }
    const store = join(directory, 'nesvo.sqlite');
    if (existsSync(store)) {
      if (!lstatSync(store).isFile() || relative(realpathSync(store), store))
        throw new ConfigurationRefusal(
          'unauthorized',
          'Use the local Nesvo store without symbolic links.',
        );
      database = new DatabaseSync(store, { readOnly: true });
    }
    const effective = new SetupProfileService(directory, database);
    const preview = effective.inspect(
      operation === 'export' ? undefined : file,
    );
    if (operation === 'diff') {
      print(printable(preview));
      return preview.status === 'invalid' || preview.status === 'unsupported'
        ? 1
        : 0;
    }
    if (operation === 'export') {
      const path = resolve(file ?? defaultSetupProfilePath(directory));
      const root = dirname(path);
      if (!existsSync(root) && !file)
        mkdirSync(root, { recursive: true, mode: 0o700 });
      if (relative(realpathSync(root), root))
        throw new ConfigurationRefusal(
          'unauthorized',
          'Choose an export directory without symbolic links.',
        );
      writeFileSync(
        path,
        dump({
          version: 1,
          inbox: { defaultRoute: preview.routing.effective },
        }),
        { flag: 'wx', mode: 0o600, flush: true },
      );
      print({
        path,
        activePath: preview.activePath,
        routing: preview.routing,
        omitted: preview.declarations
          .filter(row => row.key !== 'inbox.defaultRoute')
          .map(row => ({
            key: row.key,
            reason: 'This entry has no portable export in the current build.',
          })),
      });
      return 0;
    }
    if (!preview.revision) {
      print(printable(preview));
      return 1;
    }
    if (
      guarded &&
      (values.expect !== preview.revision ||
        Number(values['effective-revision']) !== preview.effectiveRevision)
    )
      throw new ConfigurationRefusal(
        'conflict',
        'The profile or its effective settings changed. Preview it again.',
      );
    database?.close();
    database = undefined;
    database = openDatabaseSync(directory);
    const changes = new ConfigurationChanges(
      new ConfigurationChangeStore(database),
      () => undefined,
      () => false,
    );
    const service = new SetupProfileService(directory, database, changes);
    const current = service.inspect(preview.path);
    if (
      current.revision !== preview.revision ||
      current.effectiveRevision !== preview.effectiveRevision ||
      (preview.instanceId && current.instanceId !== preview.instanceId)
    )
      throw new ConfigurationRefusal(
        'conflict',
        'The local configuration changed while opening the store.',
      );
    if (current.status === 'current' && !values['action-id']) {
      print({ review: printable(current), receipt: null });
      return 0;
    }
    const input = setupProfileInputSchema.parse({
      action: 'apply',
      file: current.path,
      instanceId: current.instanceId,
      revision: preview.revision,
      effectiveRevision: preview.effectiveRevision,
      actionId: values['action-id'] ?? randomUUID(),
    });
    if (input.action !== 'apply')
      throw new ConfigurationRefusal(
        'invalid-request',
        'Choose a profile to apply.',
      );
    const { receipt } = await service.apply(input);
    print({ review: printable(service.inspect(preview.path)), receipt });
    return 0;
  } catch (error) {
    const result =
      error instanceof SetupProfileFileError ||
      error instanceof ConfigurationRefusal
        ? {
            error: error.message,
            code:
              error instanceof ConfigurationRefusal ? error.code : 'conflict',
          }
        : {
            error: 'The local profile operation could not be completed.',
            code: 'unavailable',
          };
    print(result);
    return 1;
  } finally {
    database?.close();
    ownership?.close();
  }
}
