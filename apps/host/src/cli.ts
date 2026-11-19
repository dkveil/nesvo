#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import {
  externalInboxLimits,
  externalInboxPostSchema,
  externalInboxWaitSchema,
  externalSessionMessageSchema,
} from '@nesvo/contracts';
import {
  createInboxClient,
  createSessionMessageClient,
  InboxClientError,
  inboxDecisionExitCode,
  readSmallInboxFile,
  waitForInboxDecision,
} from './external-inbox-client';
import { serveInboxMcp } from './external-inbox-mcp';
import { configurationUsage, runConfigurationCli } from './configuration-cli';
import { profileUsage, runSetupProfileCli } from './setup-profile-cli';

const usage = `Usage:
  nesvo inbox post --title <text> [--body <text> | --body-file <path>]
    [--actions approve,reject] [--source <label>] [--session <id>]
    [--wait [--timeout <seconds>]] [--idempotency-key <key>]
  nesvo inbox status <id>
  nesvo inbox cancel <id>
  nesvo session send|notify (--session <id> | --title <exact title> --group <id or name>)
    (--text <text> | --text-file <path>) --source <label> --idempotency-key <key>
  nesvo mcp

Inbox commands accept --computer <id> and --json.
${configurationUsage}
${profileUsage}
`;

const options = {
  title: { type: 'string' },
  body: { type: 'string' },
  'body-file': { type: 'string' },
  actions: { type: 'string' },
  source: { type: 'string' },
  session: { type: 'string' },
  group: { type: 'string' },
  text: { type: 'string' },
  'text-file': { type: 'string' },
  wait: { type: 'boolean' },
  timeout: { type: 'string' },
  'idempotency-key': { type: 'string' },
  computer: { type: 'string' },
  json: { type: 'boolean' },
} as const;

const sessionOptions = new Set([
  'session',
  'group',
  'title',
  'text',
  'text-file',
  'source',
  'idempotency-key',
  'computer',
  'json',
]);
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

async function main(args: string[]) {
  if (!args.length || args.includes('--help')) {
    process.stdout.write(usage);
    return 0;
  }
  if (args.length === 1 && args[0] === 'mcp') {
    serveInboxMcp();
    return 0;
  }
  if (args[0] === 'config') return runConfigurationCli(args.slice(1));
  if (args[0] === 'profile') return runSetupProfileCli(args.slice(1));
  let id: string | undefined;
  try {
    const {
      values,
      positionals: [namespace, operation, itemId, ...extra],
    } = parseArgs({ args, options, allowPositionals: true });
    if (namespace === 'session') {
      if (
        (operation !== 'send' && operation !== 'notify') ||
        itemId ||
        extra.length ||
        Object.keys(values).some(key => !sessionOptions.has(key))
      )
        throw new InboxClientError('Run nesvo --help for session usage.');
      const group = values.group;
      if (
        (values.session && (values.title || group)) ||
        (!values.session && (!values.title || !group)) ||
        (values.text !== undefined) === (values['text-file'] !== undefined)
      )
        throw new InboxClientError(
          'Use a session ID or exact title and group, and supply one text source.',
        );
      const text =
        values['text-file'] === undefined
          ? values.text
          : await readSmallInboxFile(values['text-file'], 8192);
      const parsed = externalSessionMessageSchema.safeParse({
        kind: operation,
        source: values.source,
        target: values.session
          ? { kind: 'id', sessionId: values.session }
          : {
              kind: 'title',
              title: values.title,
              group: uuid.test(group!)
                ? { kind: 'id', id: group }
                : { kind: 'name', name: group },
            },
        text,
        idempotencyKey: values['idempotency-key'],
      });
      if (!parsed.success)
        throw new InboxClientError(
          'Check the target, source, text and idempotency key.',
        );
      const client = await createSessionMessageClient(
        process.env,
        values.computer,
      );
      const receipt = await client(parsed.data);
      process.stdout.write(
        values.json
          ? JSON.stringify(receipt) + '\n'
          : `${receipt.id} ${receipt.status}${receipt.reason ? ` (${receipt.reason})` : ''}\n`,
      );
      return receipt.status === 'rejected' ? 3 : 0;
    }
    if (namespace !== 'inbox' || extra.length)
      throw new InboxClientError('Run nesvo --help for usage.');
    const print = (value: unknown) =>
      process.stdout.write(JSON.stringify(value) + '\n');
    if (operation === 'status' || operation === 'cancel') {
      if (
        !itemId ||
        Object.keys(values).some(key => key !== 'computer' && key !== 'json')
      )
        throw new InboxClientError(
          'Specify an item ID and optional --computer or --json.',
        );
      const client = await createInboxClient(process.env, values.computer);
      const item = await client({ operation, itemId });
      if (values.json) print(item);
      else process.stdout.write(`${item.id} ${item.action ?? item.status}\n`);
      return 0;
    }
    if (
      operation !== 'post' ||
      itemId ||
      (values.body !== undefined && values['body-file'] !== undefined)
    )
      throw new InboxClientError(
        'Use inbox post with a title and either --body or --body-file.',
      );
    const timeout = values.timeout;
    if (timeout !== undefined && !/^\d+$/.test(timeout))
      throw new InboxClientError(
        'Provide a whole number of seconds for --timeout.',
      );
    const wait = externalInboxWaitSchema.safeParse({
      wait: values.wait,
      timeout: timeout === undefined ? undefined : Number(timeout),
    });
    if (!wait.success)
      throw new InboxClientError(
        'Use --wait with a timeout between 1 and 3600 seconds.',
      );
    const body =
      values['body-file'] === undefined
        ? values.body
        : await readSmallInboxFile(
            values['body-file'],
            externalInboxLimits.body * 4,
          ).catch(() => {
            throw new InboxClientError(
              'The body file must be readable, bounded UTF-8 text.',
            );
          });
    const post = externalInboxPostSchema.safeParse({
      title: values.title,
      body,
      actions: values.actions?.split(','),
      source: values.source,
      sessionId: values.session,
      idempotencyKey: values['idempotency-key'] ?? randomUUID(),
    });
    if (!post.success)
      throw new InboxClientError(
        'Check the title, body, actions, source, session ID and idempotency key limits.',
      );
    const client = await createInboxClient(process.env, values.computer);
    const item = await client({ operation: 'post', item: post.data });
    id = item.id;
    if (!values.json || wait.data.wait) {
      const output = values.json ? process.stderr : process.stdout;
      output.write(item.id + '\n');
    }
    const final = wait.data.wait
      ? await waitForInboxDecision(client, item, wait.data.timeout ?? 300)
      : item;
    if (values.json) print(final);
    return wait.data.wait ? inboxDecisionExitCode(final) : 0;
  } catch (error) {
    const detail =
      error instanceof InboxClientError
        ? { code: error.code, message: error.message }
        : {
            code: 'invalid-request',
            message: 'Invalid Nesvo command. Run nesvo --help for usage.',
          };
    if (args.includes('--json'))
      process.stdout.write(
        JSON.stringify({ ...(id ? { id } : {}), error: detail }) + '\n',
      );
    else process.stderr.write(detail.message + '\n');
    return 3;
  }
}

process.exitCode = await main(process.argv.slice(2));
