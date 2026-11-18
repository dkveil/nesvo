#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import {
  externalInboxLimits,
  externalInboxPostSchema,
  externalInboxWaitSchema,
} from '@nesvo/contracts';
import {
  createInboxClient,
  InboxClientError,
  inboxDecisionExitCode,
  readSmallInboxFile,
  waitForInboxDecision,
} from './external-inbox-client';
import { serveInboxMcp } from './external-inbox-mcp';

const usage = `Usage:
  nesvo inbox post --title <text> [--body <text> | --body-file <path>]
    [--actions approve,reject] [--source <label>] [--session <id>]
    [--wait [--timeout <seconds>]] [--idempotency-key <key>]
  nesvo inbox status <id>
  nesvo inbox cancel <id>
  nesvo mcp

Inbox commands accept --computer <id> and --json.
`;

const options = {
  title: { type: 'string' },
  body: { type: 'string' },
  'body-file': { type: 'string' },
  actions: { type: 'string' },
  source: { type: 'string' },
  session: { type: 'string' },
  wait: { type: 'boolean' },
  timeout: { type: 'string' },
  'idempotency-key': { type: 'string' },
  computer: { type: 'string' },
  json: { type: 'boolean' },
} as const;

async function main(args: string[]) {
  if (!args.length || args.includes('--help')) {
    process.stdout.write(usage);
    return 0;
  }
  if (args.length === 1 && args[0] === 'mcp') {
    serveInboxMcp();
    return 0;
  }
  let id: string | undefined;
  try {
    const {
      values,
      positionals: [namespace, operation, itemId, ...extra],
    } = parseArgs({ args, options, allowPositionals: true });
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
            message: 'Invalid Inbox command. Run nesvo --help for usage.',
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
