export type StepsListEdit =
  | { kind: 'add'; step: string; after: string | null }
  | { kind: 'remove'; step: string };

export type StepsListResult =
  | { ok: true; text: string }
  | { ok: false; message: string };

const delimiter = /^---\r?\n?$/;
const terminator = /\r?\n$/;
const flowList = /^\s*\[([^\]]*)\]\s*(#.*)?$/;
const blockItem = /^(\s*)-\s+(\S.*?)\s*(#.*)?$/;
const unsupported =
  'The steps list uses a layout this command cannot edit. Edit the file directly, then run validate.';

function failure(message: string): StepsListResult {
  return { ok: false, message };
}

function unquote(token: string): string {
  const quoted = /^(['"])(.*)\1$/.exec(token);
  return quoted ? quoted[2]! : token;
}

function endOfLine(line: string): string {
  return terminator.exec(line)?.[0] ?? '';
}

function withoutEnd(line: string): string {
  return line.replace(terminator, '');
}

function checkEdit(names: string[], edit: StepsListEdit): string | null {
  if (edit.kind === 'remove')
    return names.includes(edit.step)
      ? null
      : `Step "${edit.step}" is not in the pipeline.`;
  if (names.includes(edit.step))
    return `Step "${edit.step}" is already in the pipeline.`;
  if (edit.after !== null && !names.includes(edit.after))
    return `Step "${edit.after}" is not in the pipeline.`;
  return null;
}

function applyToItems(
  items: string[],
  edit: StepsListEdit,
  token: string,
): string[] {
  const names = items.map(unquote);
  if (edit.kind === 'remove')
    return items.filter((_, index) => names[index] !== edit.step);
  const position =
    edit.after === null ? items.length : names.indexOf(edit.after) + 1;
  return [...items.slice(0, position), token, ...items.slice(position)];
}

function editFlow(
  lines: string[],
  index: number,
  flow: RegExpExecArray,
  edit: StepsListEdit,
): StepsListResult {
  const items = flow[1]!
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
  const problem = checkEdit(items.map(unquote), edit);
  if (problem) return failure(problem);
  const step = edit.step;
  const next = applyToItems(items, edit, step);
  const comment = flow[2] ? ` ${flow[2]}` : '';
  const line = lines[index]!;
  const edited = `${line.slice(0, line.indexOf(':') + 1)} [${next.join(', ')}]${comment}${endOfLine(line)}`;
  return {
    ok: true,
    text: [...lines.slice(0, index), edited, ...lines.slice(index + 1)].join(''),
  };
}

function editBlock(
  lines: string[],
  index: number,
  closing: number,
  edit: StepsListEdit,
): StepsListResult {
  const itemLines: { position: number; indent: string; name: string }[] = [];
  for (let position = index + 1; position < closing; position++) {
    const match = blockItem.exec(withoutEnd(lines[position]!));
    if (!match) break;
    itemLines.push({
      position,
      indent: match[1]!,
      name: unquote(match[2]!),
    });
  }
  if (!itemLines.length) return failure(unsupported);
  const problem = checkEdit(
    itemLines.map(item => item.name),
    edit,
  );
  if (problem) return failure(problem);
  if (edit.kind === 'remove') {
    const target = itemLines.find(item => item.name === edit.step)!;
    return {
      ok: true,
      text: [
        ...lines.slice(0, target.position),
        ...lines.slice(target.position + 1),
      ].join(''),
    };
  }
  const reference =
    edit.after === null
      ? itemLines[itemLines.length - 1]!
      : itemLines.find(item => item.name === edit.after)!;
  const added = `${reference.indent}- ${edit.step}${endOfLine(lines[reference.position]!)}`;
  return {
    ok: true,
    text: [
      ...lines.slice(0, reference.position + 1),
      added,
      ...lines.slice(reference.position + 1),
    ].join(''),
  };
}

export function editStepsList(
  source: string,
  edit: StepsListEdit,
): StepsListResult {
  const lines = source.split(/(?<=\n)/);
  if (!lines[0] || !delimiter.test(lines[0]))
    return failure('The pipeline needs YAML frontmatter between --- lines.');
  const closing = lines.findIndex(
    (line, position) => position > 0 && delimiter.test(line),
  );
  if (closing < 0)
    return failure('The pipeline frontmatter has no closing --- line.');
  const index = lines.findIndex(
    (line, position) => position > 0 && position < closing && /^steps\s*:/.test(line),
  );
  if (index < 0) return failure('The pipeline has no steps list.');
  const line = lines[index]!;
  const rest = withoutEnd(line.slice(line.indexOf(':') + 1));
  const flow = flowList.exec(rest);
  if (flow) return editFlow(lines, index, flow, edit);
  if (rest.trim() === '' || rest.trim().startsWith('#'))
    return editBlock(lines, index, closing, edit);
  return failure(unsupported);
}
