import { parseDurationMs, type Evidence } from '@nesvo/contracts';
import { readWorkflowDiff } from '../../workspace/isolation';
import type { StepExecutor } from '../runner';
import { hostResult } from './host-result';
import {
  detectedLabels,
  maskProbeText,
  personalPatterns,
  secretPatterns,
} from './sensitive-patterns';

const MAX_FINDINGS = 16;
const assertion =
  /\b(?:assert(?:\b|[_A-Z])|expect\s*\(|should(?:\b|\.)|verify\s*\()/;
const skipping =
  /(?:\b(?:test|it|describe|suite)\.(?:skip|todo|only)\b|\b(?:xit|xtest|xdescribe)\s*\(|(?:@(?:Ignore|Disabled)\b|pytest\.mark\.skip|#\s*\[\s*ignore\b))/;
const testConfig =
  /(?:^|\/)(?:\.github\/workflows\/|\.gitlab-ci\.ya?ml$|\.circleci\/|\.buildkite\/|tsconfig(?:\.[^/]+)?\.json$|\.?eslint[^/]*$|biome\.jsonc?$|\.pre-commit-config\.yaml$|package\.json$)/i;
const removedCheck =
  /\b(?:test|check|lint|typecheck|type-check|tsc|verify|on|pull_request|required)\b/i;
const loosenedCheck =
  /(?:eslint-disable|ts-(?:ignore|nocheck)|--no-verify|--no-check|--passWithNoTests|continue-on-error\s*:\s*true|allow_failure\s*:\s*true|["']?(?:strict|noImplicitAny|noUnusedLocals|strictNullChecks|noEmitOnError)["']?\s*:\s*false|\b(?:ignores|exclude|paths-ignore|branches-ignore)\b\s*:|:\s*["'](?:off|warn)["'])/;

const unquotePath = (value: string) =>
  value
    .replace(/^"|"$/g, '')
    .replace(/^[ab]\//, '')
    .split('\t')[0] ?? '';

export const probeExecutor: StepExecutor = async execution => {
  const mode = execution.definition.probe ?? 'all';
  const includes = (kind: string) => mode === 'all' || mode === kind;
  const { patches, complete } = await readWorkflowDiff(
    execution.run.directory,
    execution.run.isolation?.base,
    AbortSignal.any([
      execution.signal,
      AbortSignal.timeout(
        parseDurationMs(execution.definition.timeout) ?? 10_000,
      ),
    ]),
  );
  if (execution.signal.aborted) return { kind: 'interrupted' };

  const findings: string[] = [];
  const groups = new Set<string>();
  let count = 0;
  let fileCount = 0;
  let changedLines = 0;
  const add = (text: string) => {
    count++;
    if (findings.length < MAX_FINDINGS - 1) findings.push(text);
  };
  if (!complete)
    add(
      'The diff scan was incomplete. Verify files outside the scan limits before accepting the result.',
    );

  for (const patch of patches) {
    let path = '';
    let line = 0;
    let inHunk = false;
    const violations = new Set<string>();
    const mark = (label: string, sensitive = false) => {
      if (violations.has(label)) return;
      violations.add(label);
      const location = maskProbeText(path).slice(0, 280) || 'Changed file';
      add(
        label +
          (sensitive ? ' [masked]' : '') +
          ' — ' +
          location +
          (line > 0 ? ':' + line : ''),
      );
    };
    for (const raw of patch.split(/\r?\n/)) {
      if (raw.startsWith('diff --git ')) {
        fileCount++;
        inHunk = false;
        line = 0;
        path = '';
        violations.clear();
      } else if (raw.startsWith('@@ ')) {
        inHunk = true;
        line = Number(/ \+(\d+)/.exec(raw)?.[1] ?? 0);
      } else if (
        !inHunk &&
        (raw.startsWith('--- ') || raw.startsWith('+++ '))
      ) {
        const name = raw.slice(4);
        if (name !== '/dev/null') path = unquotePath(name).replace(/^\.\//, '');
        if (path.includes('/'))
          groups.add(maskProbeText(path.split('/')[0]!).slice(0, 100));
      } else if (inHunk && raw.startsWith('-')) {
        changedLines++;
        if (!includes('test-integrity')) continue;
        if (assertion.test(raw)) mark('Assertion removed');
        if (testConfig.test(path) && removedCheck.test(raw))
          mark('Validation or CI configuration changed');
      } else if (inHunk && raw.startsWith('+')) {
        changedLines++;
        if (includes('secrets'))
          for (const label of detectedLabels(raw, secretPatterns))
            mark(label, true);
        if (includes('personal-data'))
          for (const label of detectedLabels(raw, personalPatterns))
            mark(label, true);
        if (includes('test-integrity')) {
          if (skipping.test(raw)) mark('Test skipped or focused');
          if (loosenedCheck.test(raw))
            mark('Validation or CI configuration may be weaker');
        }
        line++;
      } else if (inHunk && raw.startsWith(' ')) {
        line++;
      }
    }
  }

  if (includes('change-size') && (fileCount > 20 || changedLines > 500)) {
    const directories = [...groups].slice(0, 4);
    const split =
      directories.length > 1
        ? 'Consider one change per area (' +
          directories.join(', ') +
          '), each with its tests.'
        : 'Consider separating behavior changes from infrastructure or mechanical changes, keeping tests with behavior.';
    add(
      'Large diff (' +
        fileCount +
        ' files, ' +
        changedLines +
        ' changed lines). ' +
        split,
    );
  }
  if (count > findings.length)
    findings.push(
      count -
        findings.length +
        ' additional findings exceeded the display limit. Review the diff for similar signals.',
    );

  const evidence: Evidence[] = findings.map((text, index) => ({
    kind: 'text',
    label: 'probe/' + execution.step.id + '/' + (index + 1),
    path: null,
    text,
    url: null,
  }));
  const summary =
    count === 0
      ? 'No diff findings.'
      : count + (count === 1 ? ' diff finding.' : ' diff findings.');
  return hostResult(
    execution,
    'pass',
    summary,
    {
      finding_count: String(count),
      files: String(fileCount),
      changed_lines: String(changedLines),
      complete: String(complete),
    },
    evidence,
  );
};
