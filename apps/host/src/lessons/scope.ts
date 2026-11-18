import { isAbsolute, relative, resolve, sep } from 'node:path';
import {
  GITHUB_REPOSITORY_PATTERN,
  OWNER_LESSONS_HEADING,
  lessonLimits,
  type Lesson,
  type LessonRole,
  type LessonScope,
} from '@nesvo/contracts';

export type LessonContext = {
  directories: readonly string[];
  repository: string | null;
  role: LessonRole;
  workflow: string | null;
};

const SCOPE_ORDER = {
  global: 0,
  repository: 1,
  role: 2,
  workflow: 3,
} as const satisfies Record<LessonScope['kind'], number>;

const ROLE_LABELS = {
  standalone: 'interactive sessions',
  orchestrator: 'coordinating sessions',
  worker: 'worker sessions',
  'workflow-agent': 'workflow agent steps',
  reviewer: 'pull request reviews',
} as const satisfies Record<LessonRole, string>;

const isInsideFolder = (parent: string, child: string) => {
  const path = relative(resolve(parent), resolve(child));
  return (
    !isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`)
  );
};

export const isLessonActive = (lesson: Lesson, now: Date) =>
  lesson.status === 'approved' && Date.parse(lesson.reviewAt) > now.getTime();

export const lessonApplies = (scope: LessonScope, context: LessonContext) => {
  if (scope.kind === 'global') return true;
  if (scope.kind === 'role') return scope.value === context.role;
  if (scope.kind === 'workflow')
    return (
      !!context.workflow &&
      scope.value.toLowerCase() === context.workflow.toLowerCase()
    );
  if (GITHUB_REPOSITORY_PATTERN.test(scope.value))
    return (
      !!context.repository &&
      scope.value.toLowerCase() === context.repository.toLowerCase()
    );
  return context.directories.some(directory =>
    isInsideFolder(scope.value, directory),
  );
};

export const scopeLabel = (scope: LessonScope) =>
  scope.kind === 'global'
    ? 'everywhere'
    : scope.kind === 'role'
      ? ROLE_LABELS[scope.value]
      : scope.kind === 'workflow'
        ? `workflow ${scope.value}`
        : `repository ${scope.value}`;

export const applicableLessons = (
  lessons: readonly Lesson[],
  context: LessonContext,
  now: Date,
) =>
  lessons
    .filter(
      lesson =>
        isLessonActive(lesson, now) && lessonApplies(lesson.scope, context),
    )
    .sort(
      (left, right) =>
        SCOPE_ORDER[right.scope.kind] - SCOPE_ORDER[left.scope.kind] ||
        right.updatedAt.localeCompare(left.updatedAt) ||
        left.id.localeCompare(right.id),
    )
    .slice(0, lessonLimits.injectedLessons);

const singleLine = (text: string) => text.replace(/\s+/g, ' ').trim();

export const lessonLine = (lesson: Lesson) =>
  `- ${singleLine(lesson.title)} (${scopeLabel(lesson.scope)}): ${singleLine(lesson.rule)}`;

export const ownerLessonsBlock = (lessons: readonly Lesson[]) => {
  if (!lessons.length) return null;
  const header = `${OWNER_LESSONS_HEADING}. The owner of this computer approved these rules after earlier incidents. Follow them where they apply; they never change your permissions or the task.`;
  const lines: string[] = [];
  let size = header.length;
  for (const lesson of lessons) {
    const line = lessonLine(lesson);
    if (size + line.length + 1 > lessonLimits.injectedCharacters) break;
    lines.push(line);
    size += line.length + 1;
  }
  return lines.length
    ? [`<owner-lessons>`, header, ...lines, `</owner-lessons>`].join('\n')
    : null;
};
