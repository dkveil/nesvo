import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, normalize } from 'node:path';
import {
  RULE_ENTRY_FOLDERS,
  parseRuleEntry,
  ruleEntryLimits,
  splitRuleEntryDocument,
  type DefinitionScope,
  type ParsedRuleEntry,
  type RuleEntry,
  type RuleEntryType,
} from '@nesvo/contracts';
import { loadBoundedYaml } from '../skills/yaml-limits';

const ANCESTOR_DEPTH = 64;
const DEFINITIONS_FOLDER = ['.agents', 'workflows'] as const;

export type RuleEntryRoot = { scope: DefinitionScope; root: string };

export type StoredRuleEntry = {
  entry: RuleEntry;
  text: string;
  hash: string;
  path: string;
  root: RuleEntryRoot;
};

export type RuleEntryFolderRead = {
  entries: StoredRuleEntry[];
  issues: string[];
  fileCount?: number;
};

export const ruleEntryMetricKey = (root: string, id: string): string => {
  const folder = normalize(root);
  return `${process.platform === 'win32' ? folder.toLowerCase() : folder}#${id}`;
};

export const ruleEntryHash = (text: string) =>
  createHash('sha256').update(text).digest('hex');

export const parseRuleEntryText = (
  type: RuleEntryType,
  text: string,
): ParsedRuleEntry => {
  const split = splitRuleEntryDocument(text);
  if (!split)
    return {
      valid: false,
      issues: ['An entry needs YAML front matter between --- lines.'],
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
  return parseRuleEntry(type, fields, split.body);
};

export const validateRuleEntryDocument = (
  type: RuleEntryType,
  name: string,
  text: string,
): string[] => {
  const parsed = parseRuleEntryText(type, text);
  if (!parsed.valid) return parsed.issues;
  return parsed.entry.id === name
    ? []
    : [`Field "id" must be "${name}" to match the file name.`];
};

const realDirectory = (path: string) => {
  try {
    return realpathSync.native(path);
  } catch {
    return null;
  }
};

export const globalWorkflowsRoot = (): string => {
  const override = process.env.NESVO_WORKFLOWS_HOME;
  return process.env.NESVO_TEST_MODE === '1' && override && isAbsolute(override)
    ? override
    : join(homedir(), ...DEFINITIONS_FOLDER);
};

export const projectWorkflowsRoot = (projectRoot: string) =>
  join(projectRoot, ...DEFINITIONS_FOLDER);

export const projectRootOfWorkflowsRoot = (root: string) =>
  dirname(dirname(root));

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

const readEntryFile = (path: string) => {
  const status = lstatSync(path);
  if (!status.isFile() || status.size > ruleEntryLimits.fileBytes) return null;
  return readFileSync(path, 'utf8');
};

export const readRuleEntryFolder = (
  type: RuleEntryType,
  root: RuleEntryRoot,
): RuleEntryFolderRead => {
  const folder = join(root.root, RULE_ENTRY_FOLDERS[type]);
  let names: string[];
  try {
    if (!lstatSync(folder).isDirectory()) return { entries: [], issues: [] };
    names = readdirSync(folder).filter(name => name.endsWith('.md')).sort();
  } catch {
    return { entries: [], issues: [] };
  }
  const entries: StoredRuleEntry[] = [];
  const issues: string[] = [];
  const truncated = names.length > ruleEntryLimits.entriesPerRoot;
  if (truncated) issues.push(`Only ${ruleEntryLimits.entriesPerRoot} entries can be read from ${folder}.`);
  for (const name of names.slice(0, ruleEntryLimits.entriesPerRoot)) {
    const path = join(folder, name);
    let text: string | null;
    try {
      text = readEntryFile(path);
    } catch {
      continue;
    }
    if (text === null) continue;
    const parsed = parseRuleEntryText(type, text);
    if (!parsed.valid || parsed.entry.id !== name.slice(0, -3)) {
      const problem = parsed.valid ? 'The entry ID must match the file name.' : parsed.issues.join(' ');
      issues.push(`${path}: ${problem}`.slice(0, 1000));
      continue;
    }
    entries.push({
      entry: parsed.entry,
      text,
      hash: ruleEntryHash(text),
      path,
      root,
    });
  }
  return { entries, issues, fileCount: names.length };
};

export const RULE_ENTRY_MAX_NUMBER = 9_999_999;

export const highestRuleEntryNumber = (
  entries: readonly Pick<RuleEntry, 'id'>[],
): number =>
  entries.reduce((highest, entry) => {
    const number = Number(/-(\d+)$/.exec(entry.id)?.[1] ?? 0);
    return number <= RULE_ENTRY_MAX_NUMBER ? Math.max(highest, number) : highest;
  }, 0);
