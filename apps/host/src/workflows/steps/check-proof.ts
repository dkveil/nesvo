import type { CheckCandidate } from '@nesvo/contracts';
import { lstat, opendir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { pathKey } from '../definitions';
import { readCheckInput } from '../check-inventory';

type Reports = Map<string, string>;
type Proof = { text: string; failed: boolean };
const counted = (count: number, name: string) =>
  count + ' ' + name + (count === 1 ? '' : 's');

const reportDirectory = (candidate: CheckCandidate) =>
  'runner' in candidate.target && candidate.target.runner === 'gradle-wrapper'
    ? 'build/test-results/' + candidate.target.task.split(':').at(-1)
    : null;

export async function checkReports(
  cwd: string,
  candidate: CheckCandidate,
  signal: AbortSignal,
): Promise<Reports> {
  const result: Reports = new Map();
  const folder = reportDirectory(candidate);
  if (!folder) return result;
  const directory = join(cwd, folder);
  try {
    if (pathKey(await realpath(directory)) !== pathKey(directory))
      return result;
    for await (const entry of await opendir(directory)) {
      signal.throwIfAborted();
      if (!entry.isFile() || !/^TEST-[\w.$-]+\.xml$/.test(entry.name)) continue;
      const info = await lstat(join(directory, entry.name), { bigint: true });
      result.set(
        folder + '/' + entry.name,
        [info.ino, info.mtimeNs, info.ctimeNs, info.size].join(':'),
      );
      if (result.size >= 48) break;
    }
  } catch {
    signal.throwIfAborted();
  }
  return result;
}

export async function checkProof(
  cwd: string,
  candidate: CheckCandidate,
  before: Reports,
  log: string,
  signal: AbortSignal,
): Promise<Proof | null> {
  if (reportDirectory(candidate)) {
    const after = await checkReports(cwd, candidate, signal);
    let tests = 0;
    let files = 0;
    let failures = 0;
    for (const [path, stamp] of after) {
      if (stamp === before.get(path)) continue;
      const file = await readCheckInput(cwd, path, signal).catch(() => null);
      const suite = /<testsuite\b[^>]*\btests="(\d{1,8})"/.exec(
        file?.text ?? '',
      );
      if (!suite) continue;
      const skipped = Number(/\bskipped="(\d{1,8})"/.exec(suite[0])?.[1] ?? 0);
      tests += Math.max(0, Number(suite[1]) - skipped);
      failures +=
        Number(/\bfailures="(\d{1,8})"/.exec(suite[0])?.[1] ?? 0) +
        Number(/\berrors="(\d{1,8})"/.exec(suite[0])?.[1] ?? 0);
      files++;
    }
    return tests > 0
      ? {
          text:
            'Gradle wrote ' +
            counted(files, 'fresh test report') +
            ' with ' +
            counted(tests, 'executed test') +
            '.',
          failed: failures > 0,
        }
      : null;
  }
  const count = [
    [/^Ran ([1-9]\d*) tests? in [\d.]+s/m, 'unittest'],
    [/^.*?([1-9]\d*) (?:passed|failed).*? in [\d.]+s.*$/m, 'Test runner'],
    [/^\s*Tests (?:\d+ failed \| )?(?:\d+ passed )?\(([1-9]\d*)\)/m, 'Vitest'],
    [/^Tests:.*?\b([1-9]\d*) total/m, 'Jest'],
    [/^.*?([1-9]\d*) tests? completed(?:, \d+ failed)?\s*$/m, 'Test runner'],
    [/^Total tests: ([1-9]\d*)/m, 'VSTest'],
  ] as const;
  if (/^bun test\b/m.test(log)) {
    const passes = Number(/^\s*(\d+) pass\s*$/m.exec(log)?.[1] ?? 0);
    const fails = Number(/^\s*(\d+) fail\s*$/m.exec(log)?.[1] ?? 0);
    if (passes + fails > 0)
      return {
        text:
          'Bun reported ' + passes + ' passed and ' + fails + ' failed tests.',
        failed: fails > 0,
      };
  }
  const nodeCount = (label: string) =>
    Number(
      new RegExp('^(?:#|\\u2139) ' + label + ' (\\d+)[^\\S\\r\\n]*$', 'm').exec(
        log,
      )?.[1] ?? 0,
    );
  const executed = nodeCount('pass') + nodeCount('fail');
  if (nodeCount('tests') > 0 && executed > 0)
    return {
      text:
        'Node test runner reported ' +
        counted(executed, 'test') +
        ' in its output.',
      failed: nodeCount('fail') > 0,
    };
  if (/^=== RUN {3}\S/m.test(log) && /^--- (?:PASS|FAIL): \S/m.test(log))
    return {
      text: 'Go reported an executed test and its verdict.',
      failed: /^--- FAIL:/m.test(log),
    };
  for (const [pattern, runner] of count) {
    const match = pattern.exec(log);
    if (!match) continue;
    const skipped =
      runner === 'unittest' ? Number(/\bskipped=(\d+)/.exec(log)?.[1] ?? 0) : 0;
    const tests = Number(match[1]) - skipped;
    if (tests > 0)
      return {
        text:
          runner + ' reported ' + counted(tests, 'test') + ' in its output.',
        failed: /\b[1-9]\d* failed\b|^FAILED \(|\bfailures=[1-9]/m.test(log),
      };
  }
  return null;
}
