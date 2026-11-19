import { execFile } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { lstat, mkdtemp, realpath, rm } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import type { SetupDiagnosticsBatch } from '@nesvo/contracts';
import { ConfigurationRefusal } from './workflows/configuration-changes';

export type DiagnosticProvider = 'claude' | 'codex';
export type DiagnosticExecutable = {
  path: string;
  size: number;
  changed: number;
};

const labels = { claude: 'Claude Code', codex: 'Codex' } as const;
const run = promisify(execFile);
const maximumBytes = 512 * 1024 * 1024;
const nativeHeaders = new Set([
  '7f454c46',
  'feedface',
  'cefaedfe',
  'feedfacf',
  'cffaedfe',
  'cafebabe',
  'bebafeca',
  'cafebabf',
  'bfbafeca',
]);

async function signature(file: DiagnosticExecutable, signal: AbortSignal) {
  const before = await lstat(file.path);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.size !== file.size ||
    before.mtimeMs !== file.changed ||
    before.size > maximumBytes ||
    (await realpath(file.path)) !== file.path
  )
    throw new ConfigurationRefusal(
      'conflict',
      'The diagnostic executable changed.',
    );
  const stream = createReadStream(file.path, { signal, end: maximumBytes });
  const hash = createHash('sha256');
  let header = true;
  for await (const chunk of stream) {
    if (header) {
      const prefix = Buffer.from(chunk).subarray(0, 4).toString('hex');
      if (!prefix.startsWith('4d5a') && !nativeHeaders.has(prefix))
        throw new ConfigurationRefusal(
          'unsupported',
          'Version checks require a native executable.',
        );
      header = false;
    }
    hash.update(chunk);
  }
  if (header)
    throw new ConfigurationRefusal(
      'unsupported',
      'Version checks require a native executable.',
    );
  const after = await lstat(file.path);
  if (
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    before.ctimeMs !== after.ctimeMs
  )
    throw new ConfigurationRefusal(
      'conflict',
      'The diagnostic executable changed.',
    );
  return hash.digest('hex');
}

type Candidate = {
  provider: DiagnosticProvider;
  file: DiagnosticExecutable;
  digest: string;
};

export class SetupToolDiagnostics {
  private pending?: {
    batch: SetupDiagnosticsBatch;
    candidates: Candidate[];
  };
  private readonly results = new Map<
    DiagnosticProvider,
    { file: DiagnosticExecutable; version: string | null }
  >();
  private running = false;

  constructor(
    private readonly directory: string,
    private readonly lifetime: AbortSignal,
    private readonly find: (
      provider: DiagnosticProvider,
      signal: AbortSignal,
    ) => Promise<DiagnosticExecutable | undefined>,
  ) {}

  async preview(): Promise<SetupDiagnosticsBatch> {
    if (this.running)
      throw new ConfigurationRefusal(
        'busy',
        'Wait for tool verification to finish.',
      );
    const signal = AbortSignal.any([this.lifetime, AbortSignal.timeout(9000)]);
    const candidates: Candidate[] = [];
    for (const provider of ['claude', 'codex'] as const) {
      const file = await this.find(provider, signal);
      if (!file || /\.(?:cmd|bat|ps1)$/iu.test(file.path)) continue;
      try {
        candidates.push({
          provider,
          file,
          digest: await signature(file, signal),
        });
      } catch (error) {
        if (
          !(error instanceof ConfigurationRefusal) ||
          error.code !== 'unsupported'
        )
          throw error;
      }
    }
    const batch: SetupDiagnosticsBatch = {
      digest: createHash('sha256')
        .update(JSON.stringify([randomUUID(), candidates]))
        .digest('hex'),
      expiresAt: new Date(Date.now() + 120000).toISOString(),
      tools: candidates.map(({ provider, file, digest }) => ({
        label: labels[provider],
        executable: file.path,
        digest,
        argument: '--version',
      })),
    };
    this.pending = { batch, candidates };
    return batch;
  }

  result(provider: DiagnosticProvider, file: DiagnosticExecutable) {
    const recorded = this.results.get(provider);
    return recorded?.file.path === file.path &&
      recorded.file.changed === file.changed &&
      recorded.file.size === file.size
      ? recorded
      : undefined;
  }

  async verify(digest: string) {
    const reviewed = this.pending;
    if (
      !reviewed ||
      reviewed.batch.digest !== digest ||
      Date.parse(reviewed.batch.expiresAt) <= Date.now()
    )
      throw new ConfigurationRefusal(
        'conflict',
        'Review the current diagnostic batch before running it.',
      );
    this.pending = undefined;
    this.running = true;
    const signal = AbortSignal.any([this.lifetime, AbortSignal.timeout(16000)]);
    try {
      for (const tool of reviewed.candidates) await this.recheck(tool, signal);
      const root = await realpath(this.directory);
      const cwd = await mkdtemp(join(root, 'setup-diagnostics-'));
      try {
        for (const tool of reviewed.candidates) {
          await this.recheck(tool, signal);
          let version: string | null = null;
          try {
            const { stdout } = await run(tool.file.path, ['--version'], {
              cwd,
              env: {
                SystemRoot: process.env.SystemRoot,
                PATH: dirname(tool.file.path),
                CLAUDE_CONFIG_DIR: cwd,
                CODEX_HOME: cwd,
              },
              signal,
              timeout: 2500,
              maxBuffer: 4096,
              windowsHide: true,
              shell: false,
            });
            version =
              /\bv?(\d+\.\d+\.\d+(?:[-+][\w.-]{1,40})?)\b/u.exec(stdout)?.[1] ??
              null;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOSPC') throw error;
          }
          await this.recheck(tool, signal);
          this.results.set(tool.provider, { file: tool.file, version });
        }
      } finally {
        if (dirname(cwd) === root)
          await rm(cwd, { recursive: true, force: true });
      }
    } finally {
      this.running = false;
    }
  }

  private async recheck(candidate: Candidate, signal: AbortSignal) {
    const current = await this.find(candidate.provider, signal);
    if (
      !current ||
      current.path !== candidate.file.path ||
      (await signature(current, signal)) !== candidate.digest
    )
      throw new ConfigurationRefusal(
        'conflict',
        'A diagnostic tool changed. Review the batch again.',
      );
  }
}
