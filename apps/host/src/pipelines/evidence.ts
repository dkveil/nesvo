import {
  pipelineCommandLimits,
  pipelineLimits,
  type PipelineEvidence,
  type PipelineStepRecord,
} from '@nesvo/contracts';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';

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
    let used = 0;
    for (const entry of await readdir(directory, { withFileTypes: true }))
      if (entry.isFile() && entry.name !== file)
        used += (await lstat(join(directory, entry.name))).size;
    const budget = Math.max(0, pipelineLimits.evidenceBytesPerStep - used);
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

  async read(
    runId: string,
    stepId: string,
    path: string,
  ): Promise<PipelineEvidence> {
    const step = this.steps(stepId);
    if (!step || step.runId !== runId)
      throw new EvidenceError('not-found', 'Pipeline step not found.');
    if (!EVIDENCE_FILE_PATTERN.test(path))
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
