import { z } from 'zod';

export const workflowShareLimits = {
  requestBytes: 262_144,
  fileBytes: 65_536,
  contentBytes: 196_608,
  steps: 32,
  name: 64,
  description: 400,
  fileName: 68,
  appVersion: 64,
} as const;

export const WORKFLOW_SHARE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const WORKFLOW_SHARE_ID_PATTERN = /^[A-Za-z0-9_-]{32}$/;
export const WORKFLOW_SHARE_REVOKE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
export const WORKFLOW_SHARE_FILE_NAME_PATTERN =
  /^[a-z0-9]+(?:-[a-z0-9]+)*\.md$/;
export const WORKFLOW_SHARE_DEEP_LINK_PREFIX = 'nesvo://import-workflow';

export const utf8ByteLength = (value: string): number => {
  let bytes = 0;
  for (const char of value) {
    const codePoint = char.codePointAt(0) ?? 0;
    if (codePoint < 0x80) bytes += 1;
    else if (codePoint < 0x800) bytes += 2;
    else if (codePoint < 0x10000) bytes += 3;
    else bytes += 4;
  }
  return bytes;
};

const shareFileSchema = z
  .object({
    fileName: z
      .string()
      .max(workflowShareLimits.fileName)
      .regex(
        WORKFLOW_SHARE_FILE_NAME_PATTERN,
        'Use a lowercase Markdown file name such as lint.md.',
      ),
    content: z
      .string()
      .min(1)
      .refine(
        value => utf8ByteLength(value) <= workflowShareLimits.fileBytes,
        `A file can be at most ${workflowShareLimits.fileBytes / 1024} KiB.`,
      ),
  })
  .strict();

export const workflowShareFileSchema = shareFileSchema;

export const workflowShareBundleSchema = z
  .object({
    version: z.literal(1),
    name: z.string().trim().min(1).max(workflowShareLimits.name),
    description: z.string().max(workflowShareLimits.description).optional(),
    workflow: shareFileSchema,
    steps: z.array(shareFileSchema).max(workflowShareLimits.steps),
    createdWith: z
      .object({
        app: z.literal('nesvo'),
        version: z.string().trim().min(1).max(workflowShareLimits.appVersion),
      })
      .strict(),
  })
  .strict()
  .superRefine((bundle, context) => {
    const names = new Set<string>();
    bundle.steps.forEach((step, index) => {
      if (names.has(step.fileName)) {
        context.addIssue({
          code: 'custom',
          path: ['steps', index, 'fileName'],
          message: `Step file ${step.fileName} appears more than once.`,
        });
      }
      names.add(step.fileName);
    });
    const contentBytes = [bundle.workflow, ...bundle.steps].reduce(
      (total, file) => total + utf8ByteLength(file.content),
      0,
    );
    if (contentBytes > workflowShareLimits.contentBytes) {
      context.addIssue({
        code: 'custom',
        path: ['steps'],
        message: `Shared files can be at most ${workflowShareLimits.contentBytes / 1024} KiB together.`,
      });
    }
  });

export type WorkflowShareFile = z.infer<typeof workflowShareFileSchema>;
export type WorkflowShareBundle = z.infer<typeof workflowShareBundleSchema>;

export const workflowShareBundleByteLength = (
  bundle: WorkflowShareBundle,
): number => utf8ByteLength(JSON.stringify(bundle));

export const workflowShareIdSchema = z
  .string()
  .regex(WORKFLOW_SHARE_ID_PATTERN, 'Unknown share.');

export const workflowShareCreatedSchema = z
  .object({
    id: workflowShareIdSchema,
    url: z.string().min(1),
    revokeToken: z.string().regex(WORKFLOW_SHARE_REVOKE_TOKEN_PATTERN),
    expiresAt: z.iso.datetime(),
  })
  .strict();

export type WorkflowShareCreated = z.infer<typeof workflowShareCreatedSchema>;

export const WORKFLOW_SHARE_EXPIRES_HEADER = 'Nesvo-Share-Expires-At';

export const workflowShareErrorCodeSchema = z.enum([
  'invalid_request',
  'unsupported_media_type',
  'payload_too_large',
  'secret_detected',
  'rate_limited',
  'not_found',
  'expired',
  'unauthorized',
  'forbidden',
  'unavailable',
]);

export type WorkflowShareErrorCode = z.infer<
  typeof workflowShareErrorCodeSchema
>;

export const workflowShareSecretKindSchema = z.enum([
  'private-key',
  'access-token',
  'credential-assignment',
  'bearer-credential',
  'url-credential',
]);

export type WorkflowShareSecretKind = z.infer<
  typeof workflowShareSecretKindSchema
>;

export const workflowShareSecretFindingSchema = z
  .object({
    fileName: z.string(),
    kind: workflowShareSecretKindSchema,
    line: z.number().int().positive(),
  })
  .strict();

export type WorkflowShareSecretFinding = z.infer<
  typeof workflowShareSecretFindingSchema
>;

export const workflowShareErrorSchema = z
  .object({
    error: workflowShareErrorCodeSchema,
    message: z.string(),
    issues: z
      .array(z.object({ path: z.string(), message: z.string() }).strict())
      .optional(),
    secrets: z.array(workflowShareSecretFindingSchema).optional(),
  })
  .strict();

export type WorkflowShareError = z.infer<typeof workflowShareErrorSchema>;

const secretPatterns: readonly {
  kind: WorkflowShareSecretKind;
  value: RegExp;
}[] = [
  {
    kind: 'private-key',
    value: /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY-----/,
  },
  {
    kind: 'access-token',
    value:
      /\b(?:sk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9_]{30,}|github_pat_[A-Za-z0-9_]{22,}|glpat-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|(?:AKIA|ASIA)[A-Z0-9]{16}|AIza[0-9A-Za-z_-]{35}|npm_[A-Za-z0-9]{36}|[rs]k_live_[A-Za-z0-9]{16,}|eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/,
  },
  {
    kind: 'credential-assignment',
    value:
      /\b[\w.-]*(?:api[_-]?key|access[_-]?key|client[_-]?secret|token|password|secret)[\w.-]*["']?\s*[:=]\s*["'][^"'$\r\n{}<>]{12,}["']/i,
  },
  {
    kind: 'credential-assignment',
    value:
      /\b[\w.-]*(?:api[_-]?key|access[_-]?key|client[_-]?secret|token|password|secret)[\w.-]*\s*=\s*[A-Za-z0-9_./+~-]{12,}/i,
  },
  {
    kind: 'bearer-credential',
    value: /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/i,
  },
  {
    kind: 'url-credential',
    value: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@$]+:[^\s/@$]{3,}@/i,
  },
];

export const workflowShareSecretLabels: Record<
  WorkflowShareSecretKind,
  string
> = {
  'private-key': 'Private key',
  'access-token': 'Access token',
  'credential-assignment': 'Credential assignment',
  'bearer-credential': 'Bearer credential',
  'url-credential': 'Credentials in a URL',
};

export const findWorkflowShareFileSecrets = (
  file: WorkflowShareFile,
): WorkflowShareSecretFinding[] =>
  file.content.split(/\r?\n/).flatMap((text, index) =>
    secretPatterns
      .filter(pattern => pattern.value.test(text))
      .map(pattern => ({
        fileName: file.fileName,
        kind: pattern.kind,
        line: index + 1,
      }))
      .filter(
        (finding, position, all) =>
          all.findIndex(other => other.kind === finding.kind) === position,
      ),
  );

export const findWorkflowShareSecrets = (
  bundle: WorkflowShareBundle,
): WorkflowShareSecretFinding[] => [
  ...[bundle.name, bundle.description ?? ''].flatMap(text =>
    findWorkflowShareFileSecrets({ fileName: 'bundle', content: text }),
  ),
  ...[bundle.workflow, ...bundle.steps].flatMap(findWorkflowShareFileSecrets),
];

export const buildWorkflowShareDeepLink = ({
  id,
  origin,
}: {
  id: string;
  origin: string;
}): string =>
  `${WORKFLOW_SHARE_DEEP_LINK_PREFIX}?share=${encodeURIComponent(id)}&origin=${encodeURIComponent(origin)}`;

const SHARE_ORIGIN_PATTERN =
  /^(?:https:\/\/[a-z0-9.-]+(?::\d{1,5})?|http:\/\/(?:localhost|127\.0\.0\.1)(?::\d{1,5})?)$/;

export const parseWorkflowShareDeepLink = (
  link: string,
): { id: string; origin: string } | null => {
  const prefix = `${WORKFLOW_SHARE_DEEP_LINK_PREFIX}?`;
  if (!link.startsWith(prefix)) return null;
  const params = new Map<string, string>();
  for (const pair of link.slice(prefix.length).split('&')) {
    const separator = pair.indexOf('=');
    if (separator < 1) return null;
    try {
      params.set(
        pair.slice(0, separator),
        decodeURIComponent(pair.slice(separator + 1)),
      );
    } catch {
      return null;
    }
  }
  const id = params.get('share');
  const origin = params.get('origin')?.toLowerCase();
  if (!id || !WORKFLOW_SHARE_ID_PATTERN.test(id)) return null;
  if (!origin || !SHARE_ORIGIN_PATTERN.test(origin)) return null;
  return { id, origin };
};

export const workflowShareApiPath = (id?: string): string =>
  id === undefined ? '/api/shares' : `/api/shares/${encodeURIComponent(id)}`;
