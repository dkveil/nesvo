import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import {
  LESSON_FILE_KIND,
  LESSON_FOLDER,
  lessonEvidenceSchema,
  lessonIncidentKindSchema,
  lessonLimits,
  lessonRoleSchema,
  lessonScopeSchema,
  type DefinitionScope,
  type Lesson,
  type LessonEvidence,
  type LessonScope,
} from '@nesvo/contracts';
import { z } from 'zod';
import { loadBoundedYaml } from '../skills/yaml-limits';

const FILE_BYTES = 64 * 1024;
const ANCESTOR_DEPTH = 64;
const DEFINITIONS_FOLDER = ['.agents', 'workflows'] as const;

export type LessonFileDocument = {
  id: string;
  title: string;
  rule: string;
  scope: LessonScope;
  status: 'approved' | 'retired';
  reviewAt: string;
  approvedAt: string;
  proposalId: string | null;
  evidence: LessonEvidence[];
};

export type LessonRoot = { scope: DefinitionScope; root: string };

const timestampSchema = z.iso.datetime();
const nullableId = z.uuid().nullable().default(null);

const incidentFieldsSchema = z.strictObject({
  id: z.uuid(),
  kind: lessonIncidentKindSchema,
  at: timestampSchema,
  summary: z.string().min(1).max(lessonLimits.incidentSummary),
  session: nullableId,
  run: nullableId,
  workflowRun: nullableId,
});

const frontMatterSchema = z.strictObject({
  kind: z.literal(LESSON_FILE_KIND),
  id: z.uuid(),
  title: z.string().trim().min(1).max(lessonLimits.title),
  scope: z.enum(['global', 'repository', 'role', 'workflow']),
  target: z.string().trim().min(1).max(lessonLimits.scopeValue).optional(),
  status: z.enum(['approved', 'retired']),
  review: timestampSchema,
  approved: timestampSchema,
  source: z
    .strictObject({
      proposal: nullableId,
      incidents: z
        .array(incidentFieldsSchema)
        .max(lessonLimits.evidence)
        .default([]),
    })
    .default({ proposal: null, incidents: [] }),
});

const quoted = (value: string) => JSON.stringify(value);

const samePath = (left: string, right: string) =>
  process.platform === 'win32'
    ? left.replaceAll('\\', '/').toLowerCase() ===
      right.replaceAll('\\', '/').toLowerCase()
    : left === right;

export const lessonFileHash = (text: string) =>
  createHash('sha256').update(text).digest('hex');

export const lessonFileName = (title: string, id: string) => {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '');
  return `${slug ? `${slug}-` : 'lesson-'}${id.slice(0, 8)}`;
};

export const serializeLesson = (
  lesson: LessonFileDocument,
  projectRoot: string | null = null,
): string => {
  const impliedTarget =
    !!projectRoot &&
    lesson.scope.kind === 'repository' &&
    samePath(lesson.scope.value, projectRoot);
  const lines = [
    '---',
    `kind: ${LESSON_FILE_KIND}`,
    `id: ${lesson.id}`,
    `title: ${quoted(lesson.title)}`,
    `scope: ${lesson.scope.kind}`,
    ...(lesson.scope.kind === 'global' || impliedTarget
      ? []
      : [`target: ${quoted(lesson.scope.value)}`]),
    `status: ${lesson.status}`,
    `review: ${quoted(lesson.reviewAt)}`,
    `approved: ${quoted(lesson.approvedAt)}`,
    'source:',
    `  proposal: ${lesson.proposalId ?? 'null'}`,
    lesson.evidence.length ? '  incidents:' : '  incidents: []',
    ...lesson.evidence.flatMap(item => [
      `    - id: ${item.incidentId}`,
      `      kind: ${item.kind}`,
      `      at: ${quoted(item.at)}`,
      `      summary: ${quoted(item.summary)}`,
      `      session: ${item.sessionId ?? 'null'}`,
      `      run: ${item.runId ?? 'null'}`,
      `      workflowRun: ${item.workflowRunId ?? 'null'}`,
    ]),
    '---',
    lesson.rule.trim(),
    '',
  ];
  return lines.join('\n');
};

const splitDocument = (text: string) => {
  const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n([\s\S]*))?$/.exec(
    text,
  );
  return match ? { yaml: match[1]!, body: (match[2] ?? '').trim() } : null;
};

const scopeOf = (
  kind: z.infer<typeof frontMatterSchema>['scope'],
  target: string | undefined,
  root: LessonRoot | null,
): LessonScope | string => {
  if (kind === 'global') return { kind };
  if (kind === 'repository' && !target && root?.scope === 'project')
    return { kind, value: root.root };
  if (!target) return 'Field "target" is required for this scope.';
  if (kind === 'role' && !lessonRoleSchema.safeParse(target).success)
    return `Use one of these roles: ${lessonRoleSchema.options.join(', ')}.`;
  const parsed = lessonScopeSchema.safeParse({ kind, value: target });
  return parsed.success ? parsed.data : 'Field "target" is not valid.';
};

export type ParsedLessonFile =
  | { valid: true; lesson: LessonFileDocument }
  | { valid: false; issues: string[] };

export const parseLessonDocument = (
  text: string,
  root: LessonRoot | null,
): ParsedLessonFile => {
  const split = splitDocument(text);
  if (!split)
    return {
      valid: false,
      issues: ['A lesson needs YAML front matter between --- lines.'],
    };
  let fields: unknown;
  try {
    fields = loadBoundedYaml(split.yaml);
  } catch (error) {
    return {
      valid: false,
      issues: [
        error instanceof Error
          ? error.message.slice(0, 300)
          : 'The YAML is invalid.',
      ],
    };
  }
  const parsed = frontMatterSchema.safeParse(fields);
  if (!parsed.success)
    return {
      valid: false,
      issues: parsed.error.issues
        .slice(0, 5)
        .map(
          issue =>
            `${issue.path.join('.') || 'front matter'}: ${issue.message}`,
        ),
    };
  const rule = split.body;
  if (!rule || rule.length > lessonLimits.rule)
    return {
      valid: false,
      issues: [
        `Write the rule below the front matter in at most ${lessonLimits.rule} characters.`,
      ],
    };
  const scope = scopeOf(parsed.data.scope, parsed.data.target, root);
  if (typeof scope === 'string') return { valid: false, issues: [scope] };
  const evidence = parsed.data.source.incidents.map(item =>
    lessonEvidenceSchema.parse({
      incidentId: item.id,
      kind: item.kind,
      summary: item.summary,
      at: item.at,
      sessionId: item.session,
      runId: item.run,
      workflowRunId: item.workflowRun,
    }),
  );
  return {
    valid: true,
    lesson: {
      id: parsed.data.id,
      title: parsed.data.title,
      rule,
      scope,
      status: parsed.data.status,
      reviewAt: parsed.data.review,
      approvedAt: parsed.data.approved,
      proposalId: parsed.data.source.proposal,
      evidence,
    },
  };
};

const realDirectory = (path: string) => {
  try {
    return realpathSync.native(path);
  } catch {
    return null;
  }
};

export const globalLessonRoot = (): string => {
  const override = process.env.NESVO_WORKFLOWS_HOME;
  return process.env.NESVO_TEST_MODE === '1' && override && isAbsolute(override)
    ? override
    : join(homedir(), ...DEFINITIONS_FOLDER);
};

export const projectRootSync = (directory: string): string | null => {
  let current = realDirectory(directory);
  if (!current) return null;
  const start = current;
  for (let depth = 0; depth < ANCESTOR_DEPTH; depth++) {
    if (existsSync(join(current, '.git'))) return current;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return start;
};

export const projectLessonRoot = (projectRoot: string) =>
  join(projectRoot, ...DEFINITIONS_FOLDER);

export type StoredLessonFile = {
  lesson: Lesson;
  text: string;
  document: LessonFileDocument;
};

export type LessonFolderRead = {
  lessons: StoredLessonFile[];
  issues: string[];
};

const readLessonFile = (path: string) => {
  const status = lstatSync(path);
  if (!status.isFile() || status.size > FILE_BYTES) return null;
  return readFileSync(path, 'utf8');
};

export const readLessonFolder = (
  root: LessonRoot,
  projectRoot: string | null,
): LessonFolderRead => {
  const folder = join(root.root, LESSON_FOLDER);
  let entries: string[];
  try {
    const status = lstatSync(folder);
    if (!status.isDirectory()) return { lessons: [], issues: [] };
    entries = readdirSync(folder)
      .filter(entry => entry.endsWith('.md'))
      .sort()
      .slice(0, lessonLimits.lessonsPerRoot);
  } catch {
    return { lessons: [], issues: [] };
  }
  const lessons: StoredLessonFile[] = [];
  const issues: string[] = [];
  const scopeRoot: LessonRoot =
    root.scope === 'project' && projectRoot
      ? { scope: 'project', root: projectRoot }
      : root;
  for (const entry of entries) {
    const path = join(folder, entry);
    let text: string | null;
    try {
      text = readLessonFile(path);
    } catch {
      continue;
    }
    if (text === null) continue;
    const parsed = parseLessonDocument(text, scopeRoot);
    if (!parsed.valid) {
      issues.push(`${path}: ${parsed.issues.join(' ')}`.slice(0, 1000));
      continue;
    }
    const document = parsed.lesson;
    lessons.push({
      text,
      document,
      lesson: {
        id: document.id,
        version: lessonFileHash(text),
        status: document.status,
        location: {
          scope: root.scope,
          root: root.root,
          path,
          name: entry.slice(0, -3),
          changeId: null,
        },
        title: document.title,
        rule: document.rule,
        scope: document.scope,
        evidence: document.evidence,
        reviewAt: document.reviewAt,
        proposalId: document.proposalId,
        createdAt: document.approvedAt,
        updatedAt: document.approvedAt,
        decidedAt: document.approvedAt,
      },
    });
  }
  return { lessons, issues };
};
