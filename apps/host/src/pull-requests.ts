import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import {
  githubRepositorySchema,
  parsePullRequestUrl,
  pullRequestLimits as limits,
  type actOnPullRequestSchema,
  type listPullRequestsSchema,
  type PullRequest,
  type PullRequestActionResult,
  type PullRequestFiles,
  type PullRequestList,
  type PullRequestReference,
  type PullRequestThreads,
  type Session,
} from '@nesvo/contracts';
import { z } from 'zod';
import { GitHubCli, PullRequestError } from './process/github-cli';
import { resolveFolder } from './workspace/folder';
import {
  isGitHubRepositoryRoot,
  WorkspaceIsolationError,
} from './workspace/isolation';
import {
  detail,
  detailFields,
  detailSchema,
  file,
  fileSchema,
  mergeMethodsSchema,
  permissionSchema,
  shaSchema,
  summary,
  summaryFields,
  summarySchema,
  thread,
  threadsPageSchema,
  viewerSchema,
} from './pull-request-data';

const repositorySchema = z.object({ nameWithOwner: githubRepositorySchema });
const currentPullRequestSchema = z
  .object({ number: z.number().int().positive(), url: z.url() })
  .nullable();
const headSchema = z.object({ headRefOid: shaSchema, baseRefOid: shaSchema });
const threadReferenceSchema = z.object({
  data: z.object({
    node: z
      .object({
        pullRequest: z.object({
          number: z.number().int().positive(),
          repository: repositorySchema,
        }),
      })
      .nullable(),
  }),
});

const threadPageSize = 10;
const maxThreadBytes = 16 * 1024 * 1024;
const reviewThreadsQuery = `
  query($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        reviewThreads(first: ${threadPageSize}, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id path line diffSide isResolved isOutdated
            viewerCanResolve viewerCanUnresolve viewerCanReply
            comments(first: ${limits.threadComments}) {
              pageInfo { hasNextPage }
              nodes { id author { login __typename } body createdAt url }
            }
          }
        }
      }
    }
  }
`;
const threadReferenceQuery = `
  query($thread: ID!) {
    node(id: $thread) {
      ... on PullRequestReviewThread { pullRequest { number repository { nameWithOwner } } }
    }
  }
`;
const replyQuery = `
  mutation($thread: ID!, $body: String!) {
    addPullRequestReviewThreadReply(input: {pullRequestReviewThreadId: $thread, body: $body}) {
      comment { id }
    }
  }
`;
const replySchema = z.object({
  data: z.object({
    addPullRequestReviewThreadReply: z.object({
      comment: z.object({ id: z.string().min(1) }),
    }),
  }),
});

function validateRepository(repository: string) {
  if (repository.endsWith('/.') || repository.endsWith('/..'))
    throw new PullRequestError(
      'invalid-request',
      'Use a GitHub repository in owner/name format.',
    );
  return repository;
}

const referenceArgs = ({ number, repository }: PullRequestReference) => [
  String(number),
  '--repo',
  validateRepository(repository),
];

type Checkout = (
  sessionId: string,
  run: (session: Session) => Promise<void>,
) => Promise<void>;

const maxActions = 4096;
type ActionRequest = z.output<typeof actOnPullRequestSchema>;
type ActionRecord = {
  fingerprint: string;
  result: Promise<PullRequestActionResult>;
  settled: boolean;
};

export class PullRequests {
  private readonly gh: GitHubCli;
  private readonly actions = new Map<string, ActionRecord>();

  constructor(
    private readonly signal: AbortSignal,
    private readonly getSession: (id: string) => Session | undefined,
    private readonly checkoutWorkspace: Checkout,
  ) {
    this.gh = new GitHubCli(signal);
  }

  async list(
    input: z.output<typeof listPullRequestsSchema>,
  ): Promise<PullRequestList> {
    const signal = AbortSignal.timeout(20_000);
    const repository = validateRepository(
      input.repository ??
        (
          await this.gh.json(
            repositorySchema,
            ['repo', 'view', '--json', 'nameWithOwner'],
            { cwd: await resolveFolder(input.directory!, this.signal), signal },
          )
        ).nameWithOwner,
    );
    const search = [
      input.scope === 'review-requested' ? 'review-requested:@me' : '',
      input.query,
    ]
      .filter(Boolean)
      .join(' ');
    const rows = await this.gh.json(
      z.array(summarySchema),
      [
        'pr',
        'list',
        '--repo',
        repository,
        '--state',
        'open',
        '--limit',
        String(limits.listItems),
        '--json',
        summaryFields,
        ...(input.scope === 'authored' ? ['--author', '@me'] : []),
        ...(search ? ['--search', search] : []),
      ],
      { signal },
    );
    return {
      repository,
      items: rows
        .slice(0, limits.listItems)
        .map(row => summary(row, repository)),
      truncated: rows.length >= limits.listItems,
    };
  }

  async read(reference: PullRequestReference): Promise<PullRequest> {
    const { repository, number } = reference;
    const prArgs = referenceArgs(reference);
    const [raw, permission, methods, viewer] = await Promise.allSettled([
      this.gh.json(detailSchema, [
        'pr',
        'view',
        ...prArgs,
        '--json',
        detailFields,
      ]),
      this.gh.json(permissionSchema, [
        'repo',
        'view',
        repository,
        '--json',
        'viewerPermission',
      ]),
      this.gh.json(mergeMethodsSchema, ['api', `repos/${repository}`]),
      this.gh.json(viewerSchema, ['api', 'user']),
    ]);
    if (raw.status === 'rejected') throw raw.reason;
    if (permission.status === 'rejected') throw permission.reason;
    if (methods.status === 'rejected') throw methods.reason;
    if (viewer.status === 'rejected') throw viewer.reason;
    if (raw.value.number !== number)
      throw new PullRequestError(
        'unavailable',
        'The GitHub CLI returned a different pull request.',
      );
    return detail(
      raw.value,
      repository,
      viewer.value.login,
      permission.value.viewerPermission,
      methods.value,
    );
  }

  async files(reference: PullRequestReference): Promise<PullRequestFiles> {
    const { repository, number } = reference;
    const signal = AbortSignal.timeout(20_000);
    const head = () =>
      this.gh.json(
        headSchema,
        [
          'pr',
          'view',
          ...referenceArgs(reference),
          '--json',
          'headRefOid,baseRefOid',
        ],
        { signal },
      );
    const before = await head();
    const pages = await this.gh.json(
      z.array(z.array(fileSchema)),
      [
        'api',
        '--paginate',
        '--slurp',
        `repos/${repository}/pulls/${number}/files?per_page=100`,
      ],
      { maxOutputBytes: 32 * 1024 * 1024, signal },
    );
    const after = await head();
    if (
      before.headRefOid !== after.headRefOid ||
      before.baseRefOid !== after.baseRefOid
    )
      throw new PullRequestError(
        'unavailable',
        'The pull request changed while reading files. Refresh and try again.',
      );
    const rows = pages.flat();
    return {
      reference,
      headSha: before.headRefOid,
      files: rows.slice(0, limits.files).map(file),
      truncated: rows.length > limits.files,
    };
  }

  async threads(reference: PullRequestReference): Promise<PullRequestThreads> {
    const [owner, repo] = validateRepository(reference.repository).split('/');
    const signal = AbortSignal.timeout(20_000);
    const result: PullRequestThreads = {
      reference,
      threads: [],
      truncated: false,
    };
    let cursor: string | null = null;
    let bytes = 0;
    for (let offset = 0; offset < limits.threads; offset += threadPageSize) {
      const page: z.infer<typeof threadsPageSchema> = await this.gh.json(
        threadsPageSchema,
        [
          'api',
          'graphql',
          '-f',
          `query=${reviewThreadsQuery}`,
          '-f',
          `owner=${owner}`,
          '-f',
          `repo=${repo}`,
          '-F',
          `number=${reference.number}`,
          ...(cursor ? ['-f', `cursor=${cursor}`] : []),
        ],
        { signal, maxOutputBytes: 16 * 1024 * 1024 },
      );
      const connection = page.data.repository?.pullRequest?.reviewThreads;
      if (!connection)
        throw new PullRequestError(
          'not-found',
          'The GitHub repository or pull request was not found.',
        );
      const remaining = limits.threads - result.threads.length;
      for (const raw of connection.nodes.slice(0, remaining)) {
        const mapped = thread(raw);
        bytes += Buffer.byteLength(JSON.stringify(mapped));
        if (bytes > maxThreadBytes) return { ...result, truncated: true };
        result.threads.push(mapped);
      }
      result.truncated ||=
        connection.nodes.length > remaining ||
        connection.nodes.some(
          value =>
            value.comments.pageInfo.hasNextPage ||
            value.comments.nodes.length > limits.threadComments,
        );
      const { hasNextPage, endCursor } = connection.pageInfo;
      if (!hasNextPage) return result;
      if (result.threads.length >= limits.threads) break;
      if (!endCursor || endCursor === cursor || !connection.nodes.length)
        throw new PullRequestError(
          'unavailable',
          'The GitHub CLI returned invalid review thread pagination.',
        );
      cursor = endCursor;
    }
    return { ...result, truncated: true };
  }

  async find(sessionId: string): Promise<PullRequestReference | null> {
    const session = this.getSession(sessionId);
    if (!session) throw new PullRequestError('not-found', 'Session not found.');
    const result = await this.gh.json(
      currentPullRequestSchema,
      ['pr', 'view', '--json', 'number,url'],
      {
        cwd: await this.sessionFolder(session),
        inferHost: true,
        noCurrentPullRequest: true,
      },
    );
    if (result === null) return null;
    const reference = parsePullRequestUrl(result.url);
    if (!reference || reference.number !== result.number)
      throw new PullRequestError(
        'unavailable',
        'The branch pull request URL is not supported.',
      );
    return reference;
  }

  private sessionFolder(session: Session): Promise<string> {
    if (!isAbsolute(session.directory))
      throw new PullRequestError(
        'unavailable',
        'The session workspace is unavailable.',
      );
    return resolveFolder(session.directory, this.signal);
  }

  act(input: ActionRequest): Promise<PullRequestActionResult> {
    const { action, reference } = input;
    const id = input.actionId.toLowerCase();
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify([reference.repository.toLowerCase(), reference.number]),
      )
      .update(JSON.stringify(action, Object.keys(action).sort()))
      .digest('hex');
    const existing = this.actions.get(id);
    if (existing) {
      if (existing.fingerprint !== fingerprint)
        throw new PullRequestError(
          'invalid-request',
          'This action ID was already used for a different request.',
        );
      return existing.result;
    }
    if (this.actions.size >= maxActions) {
      for (const [key, record] of this.actions) {
        if (!record.settled) continue;
        this.actions.delete(key);
        break;
      }
    }
    if (this.actions.size >= maxActions)
      throw new PullRequestError(
        'busy',
        'Too many GitHub actions are in progress. Try again shortly.',
      );
    const record: ActionRecord = {
      fingerprint,
      settled: false,
      result: this.runAction(input).finally(() => {
        record.settled = true;
      }),
    };
    this.actions.set(id, record);
    return record.result;
  }

  private async runAction({
    action,
    actionId,
    reference,
  }: ActionRequest): Promise<PullRequestActionResult> {
    const prArgs = referenceArgs(reference);
    const endpoint = `repos/${reference.repository}/pulls/${reference.number}`;
    const signal = AbortSignal.timeout(60_000);
    const options = { mutation: true, signal, maxOutputBytes: 64 * 1024 };
    let detail: string;
    switch (action.action) {
      case 'comment':
        await this.gh.run(['pr', 'comment', ...prArgs, '--body-file', '-'], {
          ...options,
          stdin: action.body,
        });
        detail = 'Comment posted.';
        break;
      case 'review':
        if (action.event !== 'approve' && !action.body)
          throw new PullRequestError(
            'invalid-request',
            'Enter a review comment.',
          );
        await this.gh.run(
          [
            'pr',
            'review',
            ...prArgs,
            `--${action.event}`,
            ...(action.body ? ['--body-file', '-'] : []),
          ],
          { ...options, ...(action.body ? { stdin: action.body } : {}) },
        );
        detail = 'Review submitted.';
        break;
      case 'reply-thread':
      case 'resolve-thread': {
        const variables = { thread: action.threadId };
        const { data } = await this.gh.json(
          threadReferenceSchema,
          [
            'api',
            'graphql',
            '-f',
            `query=${threadReferenceQuery}`,
            '-f',
            `thread=${variables.thread}`,
          ],
          { signal },
        );
        if (
          data.node?.pullRequest.number !== reference.number ||
          data.node.pullRequest.repository.nameWithOwner.toLowerCase() !==
            reference.repository.toLowerCase()
        )
          throw new PullRequestError(
            'not-found',
            'The review thread was not found on this pull request.',
          );
        if (action.action === 'reply-thread') {
          await this.gh.json(replySchema, ['api', 'graphql', '--input', '-'], {
            ...options,
            stdin: JSON.stringify({
              query: replyQuery,
              variables: { ...variables, body: action.body },
            }),
          });
          detail = 'Reply posted.';
        } else {
          const field = action.resolved
            ? 'resolveReviewThread'
            : 'unresolveReviewThread';
          const query = `mutation($thread: ID!) { ${field}(input: {threadId: $thread}) { thread { id isResolved } } }`;
          const schema = z.object({
            data: z.object({
              [field]: z.object({
                thread: z.object({
                  id: z.literal(variables.thread),
                  isResolved: z.literal(action.resolved),
                }),
              }),
            }),
          });
          await this.gh.json(
            schema,
            [
              'api',
              'graphql',
              '-f',
              `query=${query}`,
              '-f',
              `thread=${variables.thread}`,
            ],
            options,
          );
          detail = action.resolved ? 'Thread resolved.' : 'Thread reopened.';
        }
        break;
      }
      case 'line-comment': {
        const side = action.side.toUpperCase();
        await this.gh.run(
          [
            'api',
            '--method',
            'POST',
            `${endpoint}/comments`,
            '--input',
            '-',
            '--silent',
          ],
          {
            ...options,
            apiAction: 'line-comment',
            stdin: JSON.stringify({
              body: action.body,
              commit_id: action.commitId,
              path: action.path,
              side,
              line: action.line,
              ...(action.startLine === null
                ? {}
                : { start_line: action.startLine, start_side: side }),
            }),
          },
        );
        detail = 'Line comment posted.';
        break;
      }
      case 'merge':
        await this.gh.json(
          z.object({ merged: z.literal(true) }),
          [
            'api',
            '--method',
            'PUT',
            `${endpoint}/merge`,
            '-f',
            `merge_method=${action.method}`,
            '-f',
            `sha=${action.expectedHeadSha}`,
          ],
          { ...options, apiAction: 'merge' },
        );
        detail = 'Pull request merged.';
        break;
      case 'checkout':
        await this.checkoutWorkspace(action.sessionId, async session => {
          const cwd = await this.sessionFolder(session);
          const valid = await isGitHubRepositoryRoot(
            cwd,
            reference.repository,
            AbortSignal.any([this.signal, signal]),
          ).catch((error: unknown) => {
            if (error instanceof WorkspaceIsolationError)
              throw new PullRequestError('unavailable', error.message);
            throw error;
          });
          if (!valid)
            throw new PullRequestError(
              'invalid-request',
              `This session folder is not the root of a checkout of ${reference.repository}.`,
            );
          await this.gh.run(['pr', 'checkout', ...prArgs], { ...options, cwd });
        });
        detail = 'Pull request checked out.';
        break;
    }
    return { actionId, action: action.action, detail };
  }
}
