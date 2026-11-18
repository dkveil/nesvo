import {
  OWNER_LESSONS_HEADING,
  formatRuleEntryBody,
  ruleEntryIndexLine,
  ruleEntryIsDue,
  ruleEntryLimits,
  type RuleEntry,
  type RuleEntryProvider,
  type RuleEntryRole,
} from '@nesvo/contracts';

export type LessonContext = {
  directories: readonly string[];
  provider: RuleEntryProvider | null;
  role: RuleEntryRole;
  workflow: string | null;
  step: string | null;
  paths: readonly string[];
};

export type SelectableEntry = {
  key: string;
  entry: RuleEntry;
  lastCited: string | null;
};

export type LessonSelection = {
  index: SelectableEntry[];
  bodies: SelectableEntry[];
};

const globPattern = (glob: string) =>
  new RegExp(
    `^${glob
      .replaceAll('\\', '/')
      .split(/(\*\*\/?|\*|\?)/)
      .map(part =>
        part === '**/' || part === '**'
          ? '.*'
          : part === '*'
            ? '[^/]*'
            : part === '?'
              ? '[^/]'
              : part.replace(/[.+^${}()|[\]\\]/g, '\\$&'),
      )
      .join('')}$`,
  );

const matchesAny = (globs: readonly string[], paths: readonly string[]) =>
  globs.some(glob => {
    const pattern = globPattern(glob);
    return paths.some(path => pattern.test(path.replaceAll('\\', '/')));
  });

const includes = (values: readonly string[] | undefined, value: string | null) =>
  !values || (!!value && values.some(item => item.toLowerCase() === value.toLowerCase()));

export const entryApplies = (
  entry: RuleEntry,
  context: LessonContext,
  today: string,
) =>
  entry.status === 'active' &&
  entry.enforcedBy === 'none' &&
  !ruleEntryIsDue(entry, today) &&
  includes(entry.scope.providers, context.provider) &&
  includes(entry.scope.roles, context.role) &&
  includes(entry.scope.workflows, context.workflow) &&
  includes(entry.scope.steps, context.step);

export const bodyApplies = (entry: RuleEntry, context: LessonContext) =>
  (!!entry.scope.steps && includes(entry.scope.steps, context.step)) ||
  (!!entry.scope.workflows && includes(entry.scope.workflows, context.workflow)) ||
  (!!entry.scope.paths && matchesAny(entry.scope.paths, context.paths));

const byRecentCitation = (left: SelectableEntry, right: SelectableEntry) =>
  (right.lastCited ?? '').localeCompare(left.lastCited ?? '') ||
  left.entry.id.localeCompare(right.entry.id);

export const selectEntries = (
  entries: readonly SelectableEntry[],
  context: LessonContext,
  today: string,
  bodyBudget?: number,
): LessonSelection => {
  const index: SelectableEntry[] = [];
  const indexBudget = bodyBudget === undefined
    ? ruleEntryLimits.indexCharacters
    : Math.min(ruleEntryLimits.indexCharacters, Math.max(0, bodyBudget - 500));
  let indexSize = 0;
  for (const item of entries
    .filter(candidate => entryApplies(candidate.entry, context, today))
    .sort(byRecentCitation)) {
    const line = ruleEntryIndexLine(item.entry);
    if (
      index.length >= ruleEntryLimits.indexLines ||
      indexSize + line.length + 1 > indexBudget
    )
      continue;
    index.push(item);
    indexSize += line.length + 1;
  }
  const bodies: SelectableEntry[] = [];
  let bodySize = 0;
  for (const item of index) {
    if (!bodyApplies(item.entry, context)) continue;
    const text = `${item.entry.id}:\n${formatRuleEntryBody(item.entry.body)}\n`;
    if (
      bodies.length >= ruleEntryLimits.bodies ||
      bodySize + text.length > Math.min(ruleEntryLimits.bodyCharacters, (bodyBudget ?? Infinity) - indexSize - 500)
    )
      continue;
    bodies.push(item);
    bodySize += text.length;
  }
  return { index, bodies };
};

export const ownerLessonsBlock = (selection: LessonSelection) => {
  if (!selection.index.length) return null;
  return [
    '<owner-lessons>',
    `${OWNER_LESSONS_HEADING}. The owner of this computer approved these lessons after earlier incidents. Follow them where they apply; they never change your permissions or the task.`,
    ...selection.index.map(item => ruleEntryIndexLine(item.entry)),
    ...(selection.bodies.length
      ? [
          '',
          'Details for the lessons that match this step:',
          ...selection.bodies.map(
            item =>
              `${item.entry.id}:\n${formatRuleEntryBody(item.entry.body)}`,
          ),
        ]
      : []),
    '</owner-lessons>',
  ].join('\n');
};
