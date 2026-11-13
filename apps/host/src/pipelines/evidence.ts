import {
  pipelineCommandLimits,
  pipelineLimits,
  type PipelineEvidence,
  type PipelineStepRecord,
} from '@nesvo/contracts';
import { constants } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { processCreatedAt } from '../process/process-created-at';
import { processStartTime } from '../providers/process-tree';

const PROCESS_FILE = 'process.json';
const SPAWN_MATCH_TOLERANCE_MS = 3_000;

const isRecordedProcess = async (
  pid: number,
  startTime: unknown,
  spawnedAt: unknown,
): Promise<boolean> => {
  if (process.platform === 'linux')
    return typeof startTime === 'number' && processStartTime(pid) === startTime;
  if (process.platform === 'win32' || typeof spawnedAt !== 'number')
    return false;
  const createdAt = await processCreatedAt(pid);
  return (
    createdAt != null &&
    Math.abs(createdAt - spawnedAt) <= SPAWN_MATCH_TOLERANCE_MS
  );
};

export const EVIDENCE_FILE_PATTERN = /^[a-z0-9][a-z0-9-]*(?:\.[a-z0-9]+)?$/;

const SECRET_PREFIX =
  /(?<![A-Za-z0-9])(?:sk-ant-|sk-|ghp_|github_pat_|xox[baprs]-)[A-Za-z0-9_-]+/g;
const MIN_SECRET_VALUE_LENGTH = 8;

export function filterResultText(
  value: string,
  secrets: readonly string[] = [],
): string {
  let text = value
    .replace(/\r\n?/g, '\n')
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
  for (const secret of secrets)
    if (secret.length >= MIN_SECRET_VALUE_LENGTH)
      text = text.split(secret).join('[redacted]');
  return text
    .replace(SECRET_PREFIX, '[redacted]')
    .replace(/Bearer\s+[^\s"']+/gi, 'Bearer [redacted]')
    .replace(
      /((?:[\w-]*(?:api[_-]?key|token|password|secret)[\w-]*)["']?[ \t]*[:=][ \t]*["']?)[^\s,"';]+/gi,
      '$1[redacted]',
    );
}

export class EvidenceError extends Error {
  constructor(
    readonly code: 'invalid-request' | 'not-found' | 'unavailable',
    message: string,
  ) {
    super(message);
  }
}

type StepLookup = (id: string) => PipelineStepRecord | undefined;

const inside = (root: string, path: string) => {
  const suffix = relative(root, path);
  return (
    suffix !== '' &&
    !isAbsolute(suffix) &&
    suffix !== '..' &&
    !suffix.startsWith(`..${sep}`)
  );
};

export class EvidenceStore {
  readonly root: string;

  constructor(
    dataDirectory: string,
    private readonly steps: StepLookup,
  ) {
    this.root = join(dataDirectory, 'pipeline-evidence');
  }

  stepDirectory(step: Pick<PipelineStepRecord, 'runId' | 'index' | 'name'>) {
    return join(this.root, step.runId, `${step.index}-${step.name}`);
  }

  async write(
    step: Pick<PipelineStepRecord, 'runId' | 'index' | 'name'>,
    file: string,
    text: string,
  ): Promise<string> {
    if (!EVIDENCE_FILE_PATTERN.test(file))
      throw new EvidenceError('invalid-request', 'Invalid evidence file name.');
    const directory = this.stepDirectory(step);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const budget = pipelineLimits.evidenceBytesPerStep;
    let bytes = Buffer.from(text, 'utf8');
    if (bytes.length > budget) bytes = bytes.subarray(bytes.length - budget);
    const handle = await open(
      join(directory, file),
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_TRUNC |
        (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW),
      0o600,
    );
    try {
      await handle.writeFile(bytes);
    } finally {
      await handle.close();
    }
    return file;
  }

  async recordProcess(
    step: Pick<PipelineStepRecord, 'runId' | 'index' | 'name'>,
    pid: number,
    spawnedAt: number = Date.now(),
  ): Promise<void> {
    const startTime = processStartTime(pid);
    const directory = this.stepDirectory(step);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(
      join(directory, PROCESS_FILE),
      JSON.stringify({ pid, startTime, spawnedAt }),
      { mode: 0o600 },
    );
  }

  async clearProcess(
    step: Pick<PipelineStepRecord, 'runId' | 'index' | 'name'>,
  ): Promise<void> {
    await rm(join(this.stepDirectory(step), PROCESS_FILE), { force: true });
  }

  async stopOrphans(): Promise<number> {
    let stopped = 0;
    let runs: string[];
    try {
      runs = await readdir(this.root);
    } catch {
      return stopped;
    }
    for (const run of runs) {
      let steps: string[];
      try {
        steps = await readdir(join(this.root, run));
      } catch {
        continue;
      }
      for (const step of steps) {
        const path = join(this.root, run, step, PROCESS_FILE);
        let record: { pid?: unknown; startTime?: unknown; spawnedAt?: unknown };
        try {
          record = JSON.parse(await readFile(path, 'utf8'));
        } catch {
          continue;
        }
        const { pid, startTime, spawnedAt } = record;
        if (
          typeof pid === 'number' &&
          Number.isInteger(pid) &&
          pid > 1 &&
          (await isRecordedProcess(pid, startTime, spawnedAt))
        )
          try {
            process.kill(-pid, 'SIGKILL');
            stopped++;
          } catch {}
        await rm(path, { force: true });
      }
    }
    return stopped;
  }

  async read(
    runId: string,
    stepId: string,
    path: string,
  ): Promise<PipelineEvidence> {
    const step = this.steps(stepId);
    if (!step || step.runId !== runId)
      throw new EvidenceError('not-found', 'Pipeline step not found.');
    if (!EVIDENCE_FILE_PATTERN.test(path) || path === PROCESS_FILE)
      throw new EvidenceError(
        'invalid-request',
        'Use the evidence file name recorded in the step result.',
      );
    const missing: PipelineEvidence = { status: 'missing', text: null, bytes: 0 };
    let directory: string;
    try {
      const root = await realpath(this.root);
      directory = await realpath(this.stepDirectory(step));
      if (!inside(root, directory))
        throw new EvidenceError(
          'invalid-request',
          'The evidence folder leads outside the evidence store.',
        );
    } catch (error) {
      if (error instanceof EvidenceError) throw error;
      return missing;
    }
    const target = join(directory, path);
    let handle;
    try {
      const stat = await lstat(target);
      if (!stat.isFile())
        throw new EvidenceError(
          'invalid-request',
          'Evidence must be a regular file.',
        );
      handle = await open(
        target,
        constants.O_RDONLY |
          (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW),
      );
    } catch (error) {
      if (error instanceof EvidenceError) throw error;
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return missing;
      throw new EvidenceError(
        'unavailable',
        'The evidence file could not be read.',
      );
    }
    try {
      const size = (await handle.stat()).size;
      const limit = pipelineCommandLimits.evidencePreviewBytes;
      const length = Math.min(size, limit);
      const buffer = Buffer.alloc(length);
      let offset = 0;
      while (offset < length) {
        const { bytesRead } = await handle.read(
          buffer,
          offset,
          length - offset,
          size - length + offset,
        );
        if (!bytesRead) break;
        offset += bytesRead;
      }
      const content = buffer.subarray(0, offset);
      if (content.includes(0)) return { status: 'binary', text: null, bytes: size };
      const text = content.toString('utf8').slice(-limit);
      return {
        status: size > limit ? 'too-large' : 'text',
        text,
        bytes: size,
      };
    } catch {
      throw new EvidenceError(
        'unavailable',
        'The evidence file could not be read.',
      );
    } finally {
      await handle.close();
    }
  }
}
