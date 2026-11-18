import type { WorkflowShareBundle } from '@nesvo/contracts/workflow-share';

export const NON_SHELL_STEP_TYPES = [
  'agent',
  'human',
  'wait-ci',
  'probe',
] as const;

export type OutlinedStep = {
  fileName: string;
  name: string;
  type: string;
  content: string;
  isListed: boolean;
  runsShell: boolean;
};

export type WorkflowOutline = {
  steps: OutlinedStep[];
  shellStepCount: number;
};

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

const unquote = (value: string): string =>
  value.trim().replace(/^(['"])(.*)\1$/, '$2');

export const readFrontmatter = (content: string): string[] =>
  FRONTMATTER_PATTERN.exec(content)?.[1]?.split(/\r?\n/) ?? [];

const fieldPattern = (field: string): RegExp =>
  new RegExp(`^\\s*['"]?${field}['"]?\\s*:(.*)$`);

export const readFieldValues = (lines: string[], field: string): string[] => {
  const pattern = fieldPattern(field);
  return lines.flatMap(line => {
    const value = pattern.exec(line)?.[1];
    return value == null ? [] : [unquote(value.replace(/\s+#.*$/, ''))];
  });
};

export const readField = (lines: string[], field: string): string | null =>
  readFieldValues(lines, field).at(-1) || null;

const isNonShellType = (type: string): boolean =>
  (NON_SHELL_STEP_TYPES as readonly string[]).includes(type);

export const mayRunShell = (types: string[]): boolean =>
  types.length !== 1 || !types.every(isNonShellType);

export const readListField = (lines: string[], field: string): string[] => {
  const prefix = `${field}:`;
  const index = lines.findIndex(candidate => candidate.startsWith(prefix));
  if (index < 0) return [];
  const inline = (lines[index] ?? '').slice(prefix.length).trim();
  if (inline.startsWith('[')) {
    return inline
      .replace(/^\[|\]$/g, '')
      .split(',')
      .map(unquote)
      .filter(Boolean);
  }
  const items: string[] = [];
  for (const line of lines.slice(index + 1)) {
    const item = /^\s+-\s+(.+)$/.exec(line);
    if (!item?.[1]) break;
    items.push(unquote(item[1]));
  }
  return items;
};

const stepNameOf = (fileName: string): string => fileName.replace(/\.md$/, '');

export const outlineWorkflow = (
  bundle: WorkflowShareBundle,
): WorkflowOutline => {
  const order = readListField(
    readFrontmatter(bundle.workflow.content),
    'steps',
  );
  const steps = bundle.steps.map(step => {
    const frontmatter = readFrontmatter(step.content);
    const types = readFieldValues(frontmatter, 'type');
    const type = types.at(-1) || 'unknown';
    const name = stepNameOf(step.fileName);
    return {
      fileName: step.fileName,
      name,
      type,
      content: step.content,
      isListed: order.includes(name),
      runsShell: mayRunShell(types),
    };
  });
  const position = (step: OutlinedStep) => {
    const index = order.indexOf(step.name);
    return index < 0 ? order.length : index;
  };
  const sorted = [...steps].sort(
    (left, right) => position(left) - position(right),
  );
  return {
    steps: sorted,
    shellStepCount: sorted.filter(step => step.runsShell).length,
  };
};
