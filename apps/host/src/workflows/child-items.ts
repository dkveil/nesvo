import {
  readWorkflowOutput,
  STEP_OUTPUT_REFERENCE,
  workflowItemsSchema,
  type WorkflowItem,
  type WorkflowItemSource,
} from '@nesvo/contracts';
import { open, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { StepExecution } from './runner';

const MAX_FILE_BYTES = 65_536;

function cells(line: string): string[] {
  return line
    .trim()
    .replace(/^\||\|$/g, '')
    .split(/(?<!\\)\|/)
    .map(cell => cell.trim().replaceAll('\\|', '|'));
}

function markdownItems(text: string): unknown {
  const lines = text.split(/\r?\n/);
  const separator = lines.findIndex(
    (line, index) =>
      index > 0 &&
      lines[index - 1]!.includes('|') &&
      cells(line).length > 1 &&
      cells(line).every(cell => /^:?-{3,}:?$/.test(cell)),
  );
  if (separator < 0) throw new Error('The items file has no Markdown table.');
  const headings = cells(lines[separator - 1]!);
  if (
    headings.some(heading => !heading) ||
    new Set(headings).size !== headings.length
  )
    throw new Error('The items table needs unique column names.');
  const rows: Record<string, string>[] = [];
  for (const line of lines.slice(separator + 1)) {
    if (!line.includes('|')) break;
    const values = cells(line);
    if (values.length !== headings.length)
      throw new Error('An items table row has the wrong number of columns.');
    rows.push(
      Object.fromEntries(
        headings.flatMap((heading, index) =>
          heading === 'on_fail' && !values[index]
            ? []
            : [[heading, values[index]!]],
        ),
      ),
    );
  }
  return rows;
}

async function fileItems(
  root: string,
  path: string,
  signal: AbortSignal,
): Promise<unknown> {
  const file = await realpath(resolve(root, path));
  const rel = relative(await realpath(root), file);
  if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`))
    throw new Error('The items file must be inside the run folder.');
  const handle = await open(
    file,
    constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES)
      throw new Error('The items file must be a regular file up to 64 KiB.');
    const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const read = await handle.read(
        buffer,
        bytesRead,
        buffer.length - bytesRead,
        bytesRead,
      );
      if (!read.bytesRead) break;
      bytesRead += read.bytesRead;
      signal.throwIfAborted();
    }
    signal.throwIfAborted();
    if (bytesRead > MAX_FILE_BYTES)
      throw new Error('The items file is larger than 64 KiB.');
    const text = buffer
      .subarray(0, bytesRead)
      .toString('utf8')
      .replace(/^\uFEFF/, '');
    return file.toLowerCase().endsWith('.md')
      ? markdownItems(text)
      : parseItemsJson(text);
  } finally {
    await handle.close();
  }
}

function parseItemsJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('The items source must contain a JSON list.');
  }
}

export async function loadChildItems(
  execution: StepExecution,
  source: WorkflowItemSource,
): Promise<WorkflowItem[]> {
  let input: unknown;
  if (source.kind === 'inline') input = source.values;
  else if (source.kind === 'file') {
    try {
      input = await fileItems(
        execution.run.directory,
        source.path,
        execution.signal,
      );
    } catch (error) {
      if (error instanceof Error && 'code' in error)
        throw new Error('Could not read the items file inside the run folder.');
      throw error;
    }
  } else {
    const match = STEP_OUTPUT_REFERENCE.exec(source.reference)!;
    const value = readWorkflowOutput(execution.outputs, match[1]!, match[2]!);
    if (value === undefined)
      throw new Error(`No upstream output named ${source.reference}.`);
    input = parseItemsJson(value);
  }
  const items = workflowItemsSchema.safeParse(input);
  if (!items.success)
    throw new Error(
      `Invalid fan-out items. ${items.error.issues[0]?.message ?? ''}`,
    );
  return items.data;
}

export function renderChildTemplate(
  template: string,
  execution: StepExecution,
  item: WorkflowItem,
  index: number,
  maxLength: number,
): string {
  const text = template
    .replace(/\{\{\s*([^{}]*?)\s*\}\}/g, (_, expression: string) => {
      if (expression === 'index') return String(index + 1);
      if (expression === 'item')
        return typeof item === 'string' ? item : JSON.stringify(item);
      if (expression.startsWith('item.') && typeof item === 'object') {
        const key = expression.slice(5);
        if (Object.hasOwn(item, key)) return String(item[key] ?? '');
      }
      const ref = STEP_OUTPUT_REFERENCE.exec(expression);
      if (ref) {
        const output = readWorkflowOutput(execution.outputs, ref[1]!, ref[2]!);
        if (output !== undefined) return output;
      }
      throw new Error(
        `No value for template expression "${expression.slice(0, 100)}".`,
      );
    })
    .trim();
  if (!text || text.length > maxLength)
    throw new Error(
      `The rendered value must contain between 1 and ${maxLength} characters.`,
    );
  return text;
}
