import {
  ruleEntryLimits,
  serializeRuleEntry,
  type ConfigurationTarget,
  type ConfigurationValue,
  type RuleEntryType,
} from '@nesvo/contracts';
import { lstat, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import type { ConfigurationSnapshot } from './assistant-change-store';
import {
  absentConfigurationVersion,
  configurationHash,
  ConfigurationRefusal,
  type ConfigurationWriter,
} from './configuration-changes';
import {
  DefinitionError,
  loadCatalog,
  missing,
  resolveWriteRoots,
} from './definitions';
import {
  parseRuleEntryText,
  readRuleEntryFolder,
  validateRuleEntryDocument,
} from './rule-entry-files';
import {
  deleteDefinition,
  deleteRuleEntryFile,
  saveDefinition,
  saveRuleEntryFile,
  withDefinitionInspection,
  type ActiveRunLookup,
} from './writer';

type Area = 'workflows' | 'steps' | 'lessons' | 'gate-rules';

const kindOf = {
  workflows: 'workflow',
  steps: 'step',
  lessons: 'lesson',
  'gate-rules': 'gate-rule',
} as const;
const isEntry = (value: string): value is RuleEntryType =>
  value === 'lesson' || value === 'gate-rule';

async function identityOf(anchor: string, root: string) {
  const rel = relative(anchor, root);
  if (!rel || isAbsolute(rel) || rel.split(sep).includes('..'))
    throw new ConfigurationRefusal(
      'conflict',
      'The workflows folder is outside its verified root.',
    );
  const stat = await lstat(anchor, { bigint: true });
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (await realpath(anchor)) !== anchor
  )
    throw new ConfigurationRefusal('conflict', 'The workflows root moved.');
  let path = anchor;
  for (const part of rel.split(sep)) {
    path = join(path, part);
    const item = await lstat(path).catch(error => {
      if (!missing(error)) throw error;
      return null;
    });
    if (item && (!item.isDirectory() || item.isSymbolicLink()))
      throw new ConfigurationRefusal(
        'conflict',
        'Use a regular directory for workflow definitions.',
      );
  }
  return JSON.stringify([anchor, root, String(stat.dev), String(stat.ino)]);
}

export function configurationDefinitions(options: {
  area: Area;
  directory: string;
  signal: AbortSignal;
  activeRuns: ActiveRunLookup;
  trusted: (project: string) => Promise<boolean>;
  nextEntry: (
    type: RuleEntryType,
    folder: string,
    scope: 'global' | 'project',
  ) => string;
}): ConfigurationWriter {
  const { area, directory, signal, activeRuns, trusted, nextEntry } = options;
  const kind = kindOf[area];
  return {
    kind: 'file',
    allocate: target => {
      if (!('scope' in target) || !isEntry(kind)) return target;
      if (target.name !== 'new')
        throw new ConfigurationRefusal(
          'invalid-request',
          'Use new to request a host-assigned entry ID.',
        );
      return {
        ...target,
        name: nextEntry(
          kind,
          target.scope.kind === 'project' ? target.scope.root : directory,
          target.scope.kind,
        ),
      };
    },
    locked: async (target, use, recovery) => {
      if (!('scope' in target) || target.area !== area)
        throw new ConfigurationRefusal(
          'unsupported',
          'Choose a configuration definition.',
        );
      const project =
        target.scope.kind === 'project' ? target.scope.root : null;
      if (project && !isAbsolute(project))
        throw new ConfigurationRefusal(
          'invalid-request',
          'Choose an absolute project root.',
        );
      const folder = project ?? directory;
      const roots = await resolveWriteRoots(folder, signal);
      if (
        project &&
        (roots.projectRoot !== project || (await realpath(project)) !== project)
      )
        throw new ConfigurationRefusal(
          'conflict',
          'The verified project root changed.',
        );
      const scope = target.scope.kind;
      const fileTarget = { directory: folder, scope, kind, name: target.name };
      const checkTrust = async () => {
        if (!recovery && project && !(await trusted(project)))
          throw new ConfigurationRefusal(
            'unauthorized',
            'Trust this project before changing its definitions.',
          );
      };
      try {
        return await withDefinitionInspection(
          fileTarget,
          roots,
          signal,
          async (file, root) => {
            await checkTrust();
            const testHome =
              process.env.NESVO_TEST_MODE === '1' &&
              process.env.NESVO_WORKFLOWS_HOME;
            const anchor = await realpath(
              project ?? (testHome ? dirname(roots.global) : homedir()),
            );
            const identity = await identityOf(anchor, root);
            const catalog = recovery ? null : await loadCatalog(folder, signal);
            const dependencies = catalog
              ? configurationHash(
                  JSON.stringify(
                    [...catalog.steps, ...catalog.workflows]
                      .filter(
                        item =>
                          item.name !== target.name ||
                          item.source.scope !== scope,
                      )
                      .map(item => [item.name, item.source.contentHash]),
                  ),
                )
              : '';
            const entry =
              isEntry(kind) && file
                ? parseRuleEntryText(kind, file.text)
                : null;
            const value: ConfigurationValue | null = entry?.valid
              ? {
                  kind: 'entry',
                  value: {
                    description: entry.entry.description,
                    body: entry.entry.body,
                    kind: entry.entry.kind,
                    scope: entry.entry.scope,
                    status: entry.entry.status,
                    enforcedBy: entry.entry.enforcedBy,
                    review: entry.entry.review,
                  },
                }
              : file
                ? { kind: 'markdown', document: file.text }
                : null;
            const read = (): ConfigurationSnapshot => ({
              value,
              identity,
              dependencies,
              document: file?.text,
              version: file
                ? { type: 'hash', hash: file.contentHash }
                : absentConfigurationVersion,
            });
            const apply = async (
              from: ConfigurationSnapshot,
              to: ConfigurationSnapshot,
              preview: boolean,
              authorize: () => void,
            ) => {
              await checkTrust();
              if ((await identityOf(anchor, root)) !== identity)
                throw new ConfigurationRefusal(
                  'conflict',
                  'The workflows root moved.',
                );
              const expectedHash =
                from.version.type === 'hash' ? from.version.hash : null;
              const flags = {
                guardExternal: true,
                configuration: { root, preview, authorize },
              };
              const document = to.document;
              if (document === undefined && !expectedHash)
                throw new ConfigurationRefusal(
                  'invalid-request',
                  'Choose an existing definition to delete.',
                );
              if (isEntry(kind)) {
                const input = {
                  type: kind,
                  directory: folder,
                  scope,
                  name: target.name,
                };
                const result =
                  document === undefined
                    ? await deleteRuleEntryFile(
                        { ...input, expectedHash: expectedHash! },
                        signal,
                        flags,
                      )
                    : await saveRuleEntryFile(
                        {
                          ...input,
                          expectedHash,
                          document,
                          validate: async text => {
                            const issues = validateRuleEntryDocument(
                              kind,
                              target.name,
                              text,
                            );
                            if (issues.length)
                              return ['Check the rule entry fields and ID.'];
                            if (
                              expectedHash === null &&
                              (readRuleEntryFolder(kind, { scope, root })
                                .fileCount ?? 0) >=
                                ruleEntryLimits.entriesPerRoot
                            )
                              return [
                                'The workflows folder reached its entry limit.',
                              ];
                            const parsed = parseRuleEntryText(kind, text);
                            if (!parsed.valid) return ['The entry is invalid.'];
                            const live = await loadCatalog(folder, signal);
                            if (
                              kind === 'gate-rule' &&
                              (!parsed.entry.scope.steps?.length ||
                                parsed.entry.scope.steps.some(
                                  name =>
                                    !live.steps.some(
                                      step =>
                                        step.name === name &&
                                        step.type === 'agent',
                                    ),
                                ))
                            )
                              return [
                                'Choose active agent steps for this gate rule.',
                              ];
                            return [];
                          },
                        },
                        signal,
                        flags,
                      );
                if (result.type === 'conflict')
                  throw new ConfigurationRefusal(
                    'conflict',
                    'The definition changed.',
                  );
                if (result.type === 'refused')
                  throw new ConfigurationRefusal(
                    'invalid-request',
                    'The entry is invalid.',
                    result.issues.slice(0, 20).map(item => ({
                      field: item.line ? `line ${item.line}` : 'document',
                      message: 'Check this part of the rule entry.',
                    })),
                  );
              } else {
                const input = { ...fileTarget, kind };
                const result =
                  document === undefined
                    ? await deleteDefinition(
                        { ...input, expectedHash: expectedHash! },
                        signal,
                        activeRuns,
                        flags,
                      )
                    : await saveDefinition(
                        { ...input, expectedHash, document },
                        signal,
                        activeRuns,
                        flags,
                      );
                if ('type' in result) {
                  if (result.type === 'workflow-definition-conflict')
                    throw new ConfigurationRefusal(
                      'conflict',
                      'The definition changed.',
                    );
                  throw new ConfigurationRefusal(
                    'invalid-request',
                    'The workflow writer refused the definition.',
                    result.issues.slice(0, 20).map(item => ({
                      field: item.line ? `line ${item.line}` : 'document',
                      message:
                        item.message.includes('external') ||
                        item.message.includes('used by workflow')
                          ? 'Review the dependent workflow and its external-action guard.'
                          : 'Check this part of the definition.',
                    })),
                  );
                }
              }
            };
            return use({
              read,
              prepare: (mutation, before, restore) => {
                const draft = mutation.draft;
                let document =
                  draft?.kind === 'markdown' ? draft.document : undefined;
                if (draft?.kind === 'entry' && isEntry(kind)) {
                  document =
                    restore?.document ??
                    serializeRuleEntry({
                      ...draft.value,
                      id: target.name,
                      type: kind,
                      provenance: entry?.valid
                        ? entry.entry.provenance
                        : {
                            source: 'manual',
                            date: new Date().toISOString().slice(0, 10),
                          },
                    });
                }
                const classification =
                  !isEntry(kind) &&
                  document &&
                  /\btype:\s*(?:action|command)\b/.test(document)
                    ? 'authority'
                    : 'review';
                return {
                  classification,
                  after: {
                    ...before,
                    value: draft,
                    document,
                    version:
                      document === undefined
                        ? absentConfigurationVersion
                        : { type: 'hash', hash: configurationHash(document) },
                  },
                };
              },
              verify: (from, to) => apply(from, to, true, () => undefined),
              write: (intent, authorize) =>
                apply(intent.from, intent.to, false, authorize),
            });
          },
        );
      } catch (error) {
        if (error instanceof DefinitionError)
          throw new ConfigurationRefusal(
            error.kind === 'busy' ? 'busy' : 'invalid-request',
            'The workflow definition is unavailable or in use.',
          );
        throw error;
      }
    },
  };
}
