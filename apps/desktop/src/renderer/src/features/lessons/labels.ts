import {
  lessonIsDue,
  type Lesson,
  type LessonIncidentKind,
  type RuleEntryRole,
  type RuleEntryScope,
} from '@nesvo/contracts';

export const lessonRoleLabels: Record<RuleEntryRole, string> = {
  standalone: 'Interactive sessions',
  orchestrator: 'Coordinating sessions',
  worker: 'Workers',
  'workflow-agent': 'Workflow agent steps',
  reviewer: 'Pull request reviews',
};

export const incidentKindLabels: Record<LessonIncidentKind, string> = {
  'step-retries-exhausted': 'Step out of retries',
  'session-stuck': 'Session stuck',
  'plan-rejected': 'Plan rejected',
  'plan-corrected': 'Plan corrected repeatedly',
  'probe-sensitive-data': 'Sensitive data in a diff',
  'cost-over-norm': 'Turn above the cost norm',
  'stage-remarks': 'Stage report remarks',
};

export const scopeFilters = [
  'all',
  'global',
  'project',
  'roles',
  'workflows',
  'paths',
] as const;
export type ScopeFilter = (typeof scopeFilters)[number];

export const scopeFilterLabels: Record<ScopeFilter, string> = {
  all: 'All scopes',
  global: 'Global folder',
  project: 'Project folder',
  roles: 'By role',
  workflows: 'By workflow or step',
  paths: 'By path',
};

export const matchesScopeFilter = (lesson: Lesson, filter: ScopeFilter) => {
  if (filter === 'all') return true;
  if (filter === 'global') return !lesson.project;
  if (filter === 'project') return !!lesson.project;
  if (filter === 'roles') return !!lesson.scope.roles;
  if (filter === 'workflows')
    return !!lesson.scope.workflows || !!lesson.scope.steps;
  return !!lesson.scope.paths;
};

const folderName = (path: string) =>
  path
    .replace(/[\\/]+$/, '')
    .split(/[\\/]/)
    .at(-1) || path;

const scopeParts = (scope: RuleEntryScope) => [
  ...(scope.providers ? [scope.providers.join(', ')] : []),
  ...(scope.roles
    ? [scope.roles.map(role => lessonRoleLabels[role]).join(', ')]
    : []),
  ...(scope.workflows ? [`workflows ${scope.workflows.join(', ')}`] : []),
  ...(scope.steps ? [`steps ${scope.steps.join(', ')}`] : []),
  ...(scope.paths ? [`paths ${scope.paths.join(', ')}`] : []),
];

export const lessonScopeText = (lesson: Lesson) => {
  const place = lesson.project ? folderName(lesson.project) : 'Everywhere';
  const parts = scopeParts(lesson.scope);
  return parts.length ? `${place} · ${parts.join(' · ')}` : place;
};

const dateFormat = new Intl.DateTimeFormat('en', {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  timeZone: 'UTC',
});

export const lessonDate = (date: string) =>
  dateFormat.format(new Date(`${date.slice(0, 10)}T00:00:00Z`));

export const lessonStatusText = (lesson: Lesson, today: string) => {
  if (lessonIsDue(lesson, today)) return 'Review due';
  return { proposed: 'Proposed', active: 'Active', retired: 'Retired' }[
    lesson.state
  ];
};
