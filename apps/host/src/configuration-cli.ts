import { parseArgs } from 'node:util';
import {
  configurationCommandSchema,
  configurationFileAreaSchema,
  configurationRecordAreaSchema,
  configurationFrameLimit,
  configurationTargetSchema,
  type ConfigurationCommand,
} from '@nesvo/contracts';
import {
  createConfigurationClient,
  InboxClientError,
  readSmallInboxFile,
} from './external-inbox-client';

export const configurationUsage = `  nesvo config capabilities
  nesvo config list <area> [--project <root>] [--cursor <cursor>]
  nesvo config get <area> <target> [--project <root>]
  nesvo config propose|apply <area> <target> --op <operation> --action-id <uuid>
    --base <absent|hash|revision> [--project <root>] [--input-file <path>]
  nesvo config status <id>

Configuration commands accept --computer <id> and --json. Drafts use JSON from stdin or --input-file.
`;

const options = {
  computer: { type: 'string' },
  project: { type: 'string' },
  cursor: { type: 'string' },
  json: { type: 'boolean' },
  op: { type: 'string' },
  'action-id': { type: 'string' },
  base: { type: 'string' },
  'input-file': { type: 'string' },
} as const;

const invalid = () =>
  new InboxClientError(
    'Check the configuration command. Run nesvo --help for usage.',
  );

function baseVersion(value?: string) {
  if (value === 'absent') return { type: 'absent' };
  if (value && /^[a-f0-9]{64}$/.test(value))
    return { type: 'hash', hash: value };
  if (value && /^\d+$/.test(value))
    return { type: 'revision', revision: Number(value) };
  throw invalid();
}

async function readDraft(file?: string) {
  if (file)
    return JSON.parse(await readSmallInboxFile(file, configurationFrameLimit));
  if (process.stdin.isTTY) throw invalid();
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > configurationFrameLimit) throw invalid();
    chunks.push(buffer);
  }
  return JSON.parse(
    new TextDecoder('utf8', { fatal: true }).decode(Buffer.concat(chunks)),
  );
}

export async function runConfigurationCli(args: string[]) {
  const write = (value: unknown) =>
    process.stdout.write(
      JSON.stringify(value, null, args.includes('--json') ? undefined : 2) +
        '\n',
    );
  try {
    const {
      values,
      positionals: [operation, area, name, ...extra],
    } = parseArgs({ args, options, allowPositionals: true });
    const mutation = operation === 'propose' || operation === 'apply';
    const allowed = ['computer', 'json'];
    if (operation === 'list' || operation === 'get' || mutation)
      allowed.push('project');
    if (operation === 'list') allowed.push('cursor');
    if (mutation) allowed.push('op', 'action-id', 'base', 'input-file');
    if (extra.length || Object.keys(values).some(key => !allowed.includes(key)))
      throw invalid();
    let command: ConfigurationCommand;
    if (operation === 'capabilities' && area === undefined)
      command = { operation };
    else if (operation === 'status' && area && name === undefined)
      command = { operation, id: area };
    else if (operation === 'list' && name === undefined)
      command = configurationCommandSchema.parse({
        operation,
        input: { area, project: values.project, cursor: values.cursor },
      });
    else if (operation === 'get' || mutation) {
      const file = configurationFileAreaSchema.safeParse(area).success;
      if (!file && values.project) throw invalid();
      const target = configurationTargetSchema.parse(
        file
          ? {
              area,
              name,
              scope: values.project
                ? { kind: 'project', root: values.project }
                : { kind: 'global' },
            }
          : configurationRecordAreaSchema.safeParse(area).success
            ? { area, id: name }
            : { area, key: name },
      );
      command =
        operation === 'get'
          ? { operation, target }
          : configurationCommandSchema.parse({
              operation,
              mutation: {
                target,
                actionId: values['action-id'],
                operation: values.op,
                baseVersion: baseVersion(values.base),
                draft:
                  values.op === 'delete' && !values['input-file']
                    ? null
                    : await readDraft(values['input-file']),
              },
            });
    } else throw invalid();
    const client = await createConfigurationClient(
      process.env,
      values.computer,
    );
    const result = await client(configurationCommandSchema.parse(command));
    write(result);
    return result.ok ? 0 : 3;
  } catch (error) {
    const detail = error instanceof InboxClientError ? error : invalid();
    if (args.includes('--json'))
      write({
        ok: false,
        code: detail.code,
        message: detail.message,
        issues: [],
      });
    else process.stderr.write(detail.message + '\n');
    return 3;
  }
}
