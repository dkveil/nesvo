import { randomUUID } from 'node:crypto';
import {
  REVIEW_SEVERITY_ORDER,
  agentReviewOutputSchema,
  codeReviewLimits,
  type PullRequestFile,
  type ReviewDraft,
  type ReviewDraftFinding,
  type ReviewDraftProfile,
} from '@nesvo/contracts';

const MAX_REPORTED_ISSUES = 5;
const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

const severityRank = (severity: ReviewDraftFinding['severity']) =>
  REVIEW_SEVERITY_ORDER.indexOf(severity);

export type ParsedFindings =
  | {
      valid: true;
      summary: string | null;
      findings: ReviewDraftFinding[];
      filtered: number;
    }
  | { valid: false; error: string };

export const parseAgentFindings = (
  output: unknown,
  profile: ReviewDraftProfile,
): ParsedFindings => {
  if (output === undefined || output === null)
    return {
      valid: false,
      error:
        'The agent finished without returning findings in the required structured form. Nothing was saved as a draft.',
    };
  const parsed = agentReviewOutputSchema.safeParse(output);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, MAX_REPORTED_ISSUES)
      .map(issue => `${issue.path.join('.') || 'output'}: ${issue.message}`)
      .join('; ');
    return {
      valid: false,
      error: `The agent returned findings that do not match the required form (${issues}). Nothing was guessed from its text.`.slice(
        0,
        codeReviewLimits.error,
      ),
    };
  }
  const minimum = severityRank(profile.minimumSeverity);
  const accepted = parsed.data.findings
    .filter(
      finding =>
        profile.findingTypes.includes(finding.type) &&
        severityRank(finding.severity) >= minimum,
    )
    .sort(
      (first, second) =>
        severityRank(second.severity) - severityRank(first.severity),
    )
    .slice(0, profile.maxFindings);
  return {
    valid: true,
    summary: profile.includeSummary ? parsed.data.summary : null,
    filtered: parsed.data.findings.length - accepted.length,
    findings: accepted.map(finding => ({
      ...finding,
      suggestion: finding.type === 'suggestion' ? finding.suggestion : null,
      id: randomUUID(),
      state: 'pending',
      edited: false,
    })),
  };
};

export const commentableHunks = (patch: string | null): number[][] => {
  if (!patch) return [];
  const hunks: number[][] = [];
  let current: number[] | null = null;
  let line = 0;
  for (const text of patch.split('\n')) {
    const header = HUNK_HEADER.exec(text);
    if (header) {
      current = [];
      hunks.push(current);
      line = Number(header[1]);
      continue;
    }
    if (!current || text.startsWith('\\')) continue;
    if (text.startsWith('-')) continue;
    current.push(line);
    line++;
  }
  return hunks;
};

const isCommentable = (
  files: ReadonlyMap<string, number[][]>,
  finding: ReviewDraftFinding,
) =>
  (files.get(finding.path) ?? []).some(
    hunk =>
      hunk.includes(finding.startLine) &&
      hunk.includes(finding.endLine) &&
      hunk.filter(
        line => line >= finding.startLine && line <= finding.endLine,
      ).length ===
        finding.endLine - finding.startLine + 1,
  );

const TYPE_LABELS = {
  comment: 'Comment',
  suggestion: 'Suggestion',
  question: 'Question',
  nit: 'Nit',
} as const satisfies Record<ReviewDraftFinding['type'], string>;

const findingText = (finding: ReviewDraftFinding, inline: boolean) => {
  const heading = `**${TYPE_LABELS[finding.type]} · ${finding.severity}**`;
  const suggestion =
    finding.suggestion !== null
      ? inline
        ? `\n\n\`\`\`suggestion\n${finding.suggestion}\n\`\`\``
        : `\n\n\`\`\`\n${finding.suggestion}\n\`\`\``
      : '';
  return `${heading}\n\n${finding.body}${suggestion}`;
};

const lineLabel = (finding: ReviewDraftFinding) =>
  finding.startLine === finding.endLine
    ? `${finding.path}:${finding.startLine}`
    : `${finding.path}:${finding.startLine}-${finding.endLine}`;

export type ReviewSubmission = {
  body: string;
  comments: {
    path: string;
    line: number;
    startLine: number | null;
    body: string;
  }[];
};

export const buildSubmission = (
  draft: ReviewDraft,
  operatorBody: string,
  files: readonly PullRequestFile[] | null,
): ReviewSubmission => {
  const kept = draft.findings.filter(finding => finding.state === 'kept');
  const hunks = new Map(
    (files ?? []).map(file => [file.path, commentableHunks(file.patch)]),
  );
  const inline = files
    ? kept.filter(finding => isCommentable(hunks, finding))
    : [];
  const remaining = kept.filter(finding => !inline.includes(finding));
  const sections = [
    operatorBody,
    draft.summary ?? '',
    remaining.length
      ? remaining
          .map(
            finding => `\`${lineLabel(finding)}\` ${findingText(finding, false)}`,
          )
          .join('\n\n---\n\n')
      : '',
  ].filter(section => section.trim());
  return {
    body: sections.join('\n\n'),
    comments: inline.map(finding => ({
      path: finding.path,
      line: finding.endLine,
      startLine:
        finding.startLine < finding.endLine ? finding.startLine : null,
      body: findingText(finding, true),
    })),
  };
};
