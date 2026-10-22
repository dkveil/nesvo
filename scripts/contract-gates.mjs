import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

import {
  createGit,
  readAddedLines,
  readBlob,
  readCommits,
  resolveRange,
  shortSha,
} from './contract-gates/git-range.mjs';
import { findAttribution, isCheckedPath, judgeComments } from './contract-gates/rules.mjs';

const ALLOWLIST_URL = new URL('./contract-gates/allowlist.json', import.meta.url);
const GUIDE = 'docs/engineering.md#comment-and-attribution-gates';

const count = (amount, noun) => `${amount} ${noun}${amount === 1 ? '' : 's'}`;

const loadAllowlist = () => {
  const { allowedComments } = JSON.parse(readFileSync(ALLOWLIST_URL, 'utf8'));
  const valid =
    Array.isArray(allowedComments) &&
    allowedComments.every(entry => typeof entry === 'string' && entry.startsWith('// '));
  if (!valid) throw new Error('allowlist.json must list whole comment lines starting with "// "');
  return new Set(allowedComments);
};

const attributionViolations = commits =>
  commits.flatMap(({ sha, message }) =>
    findAttribution(message).map(
      ({ line, reason, excerpt }) =>
        `commit ${shortSha(sha)} message line ${line}: ${reason}: ${excerpt}`,
    ),
  );

const commentViolations = ({ git, range, files, allowlist }) =>
  files.flatMap(([path, addedLines]) =>
    judgeComments({ path, content: readBlob(git, range.head, path), addedLines, allowlist }).map(
      ({ line, reason, excerpt }) => `${path}:${line}: ${reason}: ${excerpt}`,
    ),
  );

const runGates = ({ git, range, allowlist }) => {
  const commits = readCommits(git, range);
  const files = [...readAddedLines(git, range)].filter(([path]) => isCheckedPath(path));
  const violations = [
    ...attributionViolations(commits),
    ...commentViolations({ git, range, files, allowlist }),
  ];
  return { commits: commits.length, files: files.length, violations };
};

const main = argv => {
  const { values } = parseArgs({
    args: argv,
    options: { base: { type: 'string' }, head: { type: 'string', default: 'HEAD' } },
  });
  const git = createGit(process.cwd());
  const range = resolveRange(git, values);
  const { commits, files, violations } = runGates({ git, range, allowlist: loadAllowlist() });
  if (violations.length === 0) {
    console.log(
      `contract gates passed for ${range.description}: ${count(commits, 'commit')}, ${count(files, 'file')}`,
    );
    return 0;
  }
  console.error(
    [
      `contract gates failed for ${range.description}: ${count(violations.length, 'violation')}`,
      ...violations.map(violation => `  ${violation}`),
      `Allowed forms and fixes: ${GUIDE}`,
    ].join('\n'),
  );
  return 1;
};

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  console.error(`contract gates could not run: ${error.message}`);
  process.exitCode = 2;
}
