import { formatEdge, parseEdge, type GraphEdge } from '@nesvo/contracts';

export type StepsListEdit =
  | { kind: 'add'; step: string; after: string | null; connect: boolean }
  | { kind: 'remove'; step: string };

export type StepsListResult =
  | { ok: true; text: string; notes: string[] }
  | { ok: false; message: string };

type ListField = 'steps' | 'edges';

type BlockItem = {
  position: number;
  indent: string;
  token: string;
  comment: string;
};

type FoundList =
  | { kind: 'missing' }
  | { kind: 'unsupported' }
  | { kind: 'flow'; index: number; tokens: string[]; comment: string }
  | { kind: 'block'; index: number; items: BlockItem[] };

const delimiter = /^---\r?\n?$/;
const terminator = /\r?\n$/;
const flowList = /^\s*\[([^\]]*)\]\s*(#.*)?$/;
const blockItem = /^(\s*)-\s+(\S.*?)\s*(#.*)?$/;
const unsupported = (field: ListField) =>
  `The ${field} list uses a layout this command cannot edit. Edit the file directly, then run validate.`;

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

function frontmatter(
  lines: string[],
): { closing: number } | { message: string } {
  if (!lines[0] || !delimiter.test(lines[0]))
    return { message: 'The pipeline needs YAML frontmatter between --- lines.' };
  const closing = lines.findIndex(
    (line, position) => position > 0 && delimiter.test(line),
  );
  return closing < 0
    ? { message: 'The pipeline frontmatter has no closing --- line.' }
    : { closing };
}

function findList(
  lines: string[],
  closing: number,
  field: ListField,
): FoundList {
  const key = new RegExp(`^${field}\\s*:`);
  const index = lines.findIndex(
    (line, position) => position > 0 && position < closing && key.test(line),
  );
  if (index < 0) return { kind: 'missing' };
  const line = lines[index]!;
  const rest = withoutEnd(line.slice(line.indexOf(':') + 1));
  const flow = flowList.exec(rest);
  if (flow)
    return {
      kind: 'flow',
      index,
      tokens: flow[1]!
        .split(',')
        .map(item => item.trim())
        .filter(Boolean),
      comment: flow[2] ? ` ${flow[2]}` : '',
    };
  if (rest.trim() !== '' && !rest.trim().startsWith('#'))
    return { kind: 'unsupported' };
  const items: BlockItem[] = [];
  for (let position = index + 1; position < closing; position++) {
    const item = withoutEnd(lines[position]!);
    if (/^\s*(#.*)?$/.test(item)) continue;
    const match = blockItem.exec(item);
    if (!match) break;
    items.push({
      position,
      indent: match[1]!,
      token: match[2]!,
      comment: match[3] ? ` ${match[3]}` : '',
    });
  }
  return items.length ? { kind: 'block', index, items } : { kind: 'unsupported' };
}

function replaceLine(lines: string[], index: number, line: string): string {
  return [...lines.slice(0, index), line, ...lines.slice(index + 1)].join('');
}

function flowLine(
  lines: string[],
  list: { index: number; comment: string },
  tokens: string[],
): string {
  const line = lines[list.index]!;
  return `${line.slice(0, line.indexOf(':') + 1)} [${tokens.join(', ')}]${list.comment}${endOfLine(line)}`;
}

function editSteps(source: string, edit: StepsListEdit): StepsListResult {
  const lines = source.split(/(?<=\n)/);
  const bounds = frontmatter(lines);
  if ('message' in bounds) return failure(bounds.message);
  const list = findList(lines, bounds.closing, 'steps');
  if (list.kind === 'missing') return failure('The pipeline has no steps list.');
  if (list.kind === 'unsupported') return failure(unsupported('steps'));
  if (list.kind === 'flow') {
    const problem = checkEdit(list.tokens.map(unquote), edit);
    if (problem) return failure(problem);
    const tokens = applyToItems(list.tokens, edit, edit.step);
    return {
      ok: true,
      text: replaceLine(lines, list.index, flowLine(lines, list, tokens)),
      notes: [],
    };
  }
  const problem = checkEdit(
    list.items.map(item => unquote(item.token)),
    edit,
  );
  if (problem) return failure(problem);
  if (edit.kind === 'remove') {
    const target = list.items.find(item => unquote(item.token) === edit.step)!;
    return {
      ok: true,
      text: [
        ...lines.slice(0, target.position),
        ...lines.slice(target.position + 1),
      ].join(''),
      notes: [],
    };
  }
  const reference =
    edit.after === null
      ? list.items[list.items.length - 1]!
      : list.items.find(item => unquote(item.token) === edit.after)!;
  const added = `${reference.indent}- ${edit.step}${endOfLine(lines[reference.position]!)}`;
  return {
    ok: true,
    text: [
      ...lines.slice(0, reference.position + 1),
      added,
      ...lines.slice(reference.position + 1),
    ].join(''),
    notes: [],
  };
}

type EdgeChange = {
  keep: (edge: GraphEdge | null) => boolean;
  rewrite: (edge: GraphEdge) => GraphEdge | null;
  added: GraphEdge | null;
  notes: string[];
};

const unchanged = {
  keep: () => true,
  rewrite: () => null,
  added: null,
};

function edgeChange(edit: StepsListEdit): EdgeChange {
  if (edit.kind === 'remove')
    return {
      ...unchanged,
      keep: edge => !edge || (edge.from !== edit.step && edge.to !== edit.step),
      notes: [],
    };
  const after = edit.after;
  if (after !== null && edit.connect)
    return {
      ...unchanged,
      rewrite: edge =>
        edge.from === after && edge.when === 'success'
          ? { ...edge, from: edit.step }
          : null,
      added: { from: after, to: edit.step, when: 'success' },
      notes: [],
    };
  return {
    ...unchanged,
    notes: [
      ...(after === null
        ? []
        : [
            `No edge was added because "${after}" and "${edit.step}" are in different phases`,
          ]),
      `Step "${edit.step}" has no incoming edge and starts when its phase begins`,
    ],
  };
}

function edgeNotes(
  edit: StepsListEdit,
  removed: number,
  rewired: [GraphEdge, GraphEdge][],
  added: GraphEdge | null,
  sources: string[],
): string[] {
  const notes = rewired.map(
    ([before, after]) =>
      `Rewired "${formatEdge(before)}" to "${formatEdge(after)}"`,
  );
  if (added) notes.push(`Added edge "${formatEdge(added)}"`);
  if (removed)
    notes.push(
      `Removed ${removed} ${removed === 1 ? 'edge' : 'edges'} that named "${edit.step}"`,
    );
  for (const name of sources)
    notes.push(
      `Step "${name}" has no incoming edge now and starts when its phase begins`,
    );
  return notes;
}

function newSources(
  before: readonly string[],
  after: readonly string[],
  edit: StepsListEdit,
): string[] {
  const parsed = (tokens: readonly string[]) =>
    tokens.flatMap(token => parseEdge(unquote(token)) ?? []);
  const targets = new Set(parsed(after).map(edge => edge.to));
  return [...new Set(parsed(before).map(edge => edge.to))].filter(
    name => name !== edit.step && !targets.has(name),
  );
}

function editEdges(source: string, edit: StepsListEdit): StepsListResult {
  const change = edgeChange(edit);
  const lines = source.split(/(?<=\n)/);
  const bounds = frontmatter(lines);
  if ('message' in bounds) return failure(bounds.message);
  const list = findList(lines, bounds.closing, 'edges');
  if (list.kind === 'missing') return { ok: true, text: source, notes: [] };
  const untouched = { ok: true as const, text: source, notes: change.notes };
  if (edit.kind === 'add' && !change.added) return untouched;
  if (list.kind === 'unsupported') return failure(unsupported('edges'));
  const rewired: [GraphEdge, GraphEdge][] = [];
  let removed = 0;
  const transform = (token: string): string | null => {
    const edge = parseEdge(unquote(token));
    if (!change.keep(edge)) {
      removed++;
      return null;
    }
    const rewritten = edge ? change.rewrite(edge) : null;
    if (!edge || !rewritten) return token;
    rewired.push([edge, rewritten]);
    return formatEdge(rewritten);
  };
  const before =
    list.kind === 'flow' ? list.tokens : list.items.map(item => item.token);
  const after = before.flatMap(token => transform(token) ?? []);
  if (change.added) after.push(formatEdge(change.added));
  const notes = [
    ...edgeNotes(
      edit,
      removed,
      rewired,
      change.added,
      newSources(before, after, edit),
    ),
    ...change.notes,
  ];
  if (!removed && !rewired.length && !change.added) return untouched;
  if (list.kind === 'flow')
    return {
      ok: true,
      text: replaceLine(lines, list.index, flowLine(lines, list, after)),
      notes,
    };
  const edited = [...lines];
  const dropped = new Set<number>();
  for (const item of list.items) {
    const edge = parseEdge(unquote(item.token));
    if (!change.keep(edge)) {
      dropped.add(item.position);
      continue;
    }
    const rewritten = edge ? change.rewrite(edge) : null;
    if (rewritten)
      edited[item.position] =
        `${item.indent}- ${formatEdge(rewritten)}${item.comment}${endOfLine(lines[item.position]!)}`;
  }
  const last = list.items[list.items.length - 1]!;
  if (change.added)
    edited[last.position] +=
      `${last.indent}- ${formatEdge(change.added)}${endOfLine(lines[last.position]!)}`;
  if (!change.added && dropped.size === list.items.length) {
    const header = lines[list.index]!;
    const comment = withoutEnd(header.slice(header.indexOf(':') + 1)).trim();
    edited[list.index] =
      `${header.slice(0, header.indexOf(':') + 1)} []${comment ? ` ${comment}` : ''}${endOfLine(header)}`;
  }
  return {
    ok: true,
    text: edited.filter((_, position) => !dropped.has(position)).join(''),
    notes,
  };
}

export function editStepsList(
  source: string,
  edit: StepsListEdit,
): StepsListResult {
  const steps = editSteps(source, edit);
  if (!steps.ok) return steps;
  return editEdges(steps.text, edit);
}
