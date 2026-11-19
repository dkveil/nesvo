import { NativeDisclosure } from '@/shared/ui/disclosure';
import { PathInput } from '@/shared/ui/path-input';
import { FolderPicker } from '@/shared/ui/folder-picker';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/shared/ui/tooltip';
import { useEffect, useRef, useState } from 'react';
import {
  inboxRulePresets,
  type Computer,
  type DecisionRoute,
  type DesktopApi,
  type InboxRuleCatalog,
  type InboxRuleEntry,
  type InboxRuleIssue,
  type InboxRuleScope,
  type Provider,
} from '@nesvo/contracts';
import { errorDetail } from '@/entities/session';
import { Badge } from '@/shared/ui/badge';
import { Button } from '@/shared/ui/button';
import { ConfirmDialog } from '@/shared/ui/confirm-dialog';
import { InlineNotice } from '@/shared/ui/inline-notice';
import { SavedInField } from '@/shared/ui/saved-in-field';
import type { ProviderStates } from '@/entities/session';
import { ModelPicker } from '@/features/new-thread/model-picker';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/shared/ui/select';
import { SettingsRow, SettingsSection } from '@/shared/ui/settings-section';
import { SkeletonList } from '@/shared/ui/skeleton';
import { StatusMessage } from '@/shared/ui/status-message';
import { Switch } from '@/shared/ui/switch';
import { Textarea } from '@/shared/ui/textarea';
import { ruleSummary, routeLabels } from './rule-text';

type InboxRulesApi = Pick<
  DesktopApi,
  | 'chooseDirectory'
  | 'listInboxRules'
  | 'validateInboxRule'
  | 'saveInboxRule'
  | 'deleteInboxRule'
  | 'setInboxRuleEnabled'
  | 'proposeInboxRule'
  | 'saveInboxSettings'
>;

type InboxRulesSettingsProps = {
  computer: Computer | undefined;
  defaultFolder: string | null;
  statuses: ProviderStates;
  onRefreshProvider: (provider: Provider) => void;
  api: InboxRulesApi;
  onEditProfile?: () => void;
};

type Draft = {
  proposed?: boolean;
  scope: InboxRuleScope;
  text: string;
  expectedHash: string | null;
  previousName?: string;
};

const NEW_RULE = `---
name: my-rule
description: What this rule is for.
trigger: command
pattern: "git push*"
action: hold
show: [command, diff]
---
{{ session.title }} wants to run \`{{ command }}\`.
`;

const VALIDATE_DELAY_MS = 300;

const unavailableReason = (computer: Computer | undefined) => {
  if (!computer) return 'Choose a computer.';
  if (computer.status !== 'connected')
    return `${computer.name} is offline. Connect it to change Inbox rules.`;
  if (!computer.capabilities.includes('inbox-rules'))
    return 'Update this computer’s Nesvo host and reconnect to use Inbox rules.';
  return '';
};

function IssueList({
  issues,
  onSelectLine,
}: {
  issues: InboxRuleIssue[];
  onSelectLine?: (line: number) => void;
}) {
  if (!issues.length) return null;
  return (
    <ul className="divide-y" aria-label="Rule issues">
      {issues.map((issue, index) => (
        <li key={index} className="space-y-1 py-1.5">
          {(issue.field || issue.line) && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              {issue.field && (
                <code className="text-foreground">{issue.field}</code>
              )}
              {issue.line &&
                (onSelectLine ? (
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() => onSelectLine(issue.line!)}
                  >
                    Line {issue.line}
                  </Button>
                ) : (
                  <span>Line {issue.line}</span>
                ))}
            </div>
          )}
          <StatusMessage
            tone={issue.severity === 'error' ? 'error' : 'warning'}
          >
            {issue.message.replace(
              /^(?:\w+: )?Invalid (?:option|input):[\s\S]+$/,
              'Check this field’s value.',
            )}
          </StatusMessage>
          {!!issue.choices?.length && (
            <NativeDisclosure title="Allowed values" triggerTone="muted">
              <ul className="flex flex-wrap gap-1.5">
                {issue.choices.map(value => (
                  <li key={value}>
                    <Badge>
                      <code>{value}</code>
                    </Badge>
                  </li>
                ))}
              </ul>
            </NativeDisclosure>
          )}
        </li>
      ))}
    </ul>
  );
}

export function InboxRulesSettings({
  computer,
  defaultFolder,
  statuses,
  onRefreshProvider,
  api,
  onEditProfile,
}: InboxRulesSettingsProps) {
  const unavailable = unavailableReason(computer);
  const hostId = computer?.id ?? 'local';
  const ruleEditor = useRef<HTMLTextAreaElement>(null);
  const selectRuleLine = (line: number) => {
    const editor = ruleEditor.current;
    if (!editor) return;
    const lines = editor.value.split('\n');
    const start = lines
      .slice(0, line - 1)
      .reduce((offset, text) => offset + text.length + 1, 0);
    editor.focus();
    editor.setSelectionRange(start, start + (lines[line - 1]?.length ?? 0));
  };
  const [folder, setFolder] = useState(defaultFolder ?? '');
  const [remoteFolder, setRemoteFolder] = useState(folder);
  const [catalog, setCatalog] = useState<InboxRuleCatalog | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [issues, setIssues] = useState<InboxRuleIssue[]>([]);
  const [valid, setValid] = useState(false);
  const [removing, setRemoving] = useState<InboxRuleEntry | null>(null);
  const [description, setDescription] = useState('');
  const [provider, setProvider] = useState<Provider>('Claude Code');
  const [model, setModel] = useState('haiku');
  const [proposing, setProposing] = useState(false);
  const validation = useRef(0);
  const directory = folder.trim() || undefined;

  useEffect(() => {
    if (unavailable) return;
    let current = true;
    api
      .listInboxRules(defaultFolder ? { directory: defaultFolder } : {}, hostId)
      .then(next => {
        if (current) {
          setCatalog(next);
          setFolder(defaultFolder ?? '');
          setRemoteFolder(defaultFolder ?? '');
        }
      })
      .catch(failure => {
        if (current)
          setError(`Inbox rules could not be read. ${errorDetail(failure)}`);
      });
    return () => {
      current = false;
    };
  }, [api, defaultFolder, hostId, unavailable]);
  useEffect(() => {
    if (!draft || unavailable) return;
    const current = ++validation.current;
    const timer = window.setTimeout(() => {
      void api
        .validateInboxRule({ text: draft.text }, hostId)
        .then(result => {
          if (current !== validation.current) return;
          setIssues(result.issues);
          setValid(!!result.rule);
        })
        .catch(failure => {
          if (current !== validation.current) return;
          setIssues([
            {
              severity: 'error',
              path: '',
              line: null,
              message: `The rule could not be checked. ${errorDetail(failure)}`,
            },
          ]);
          setValid(false);
        });
    }, VALIDATE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [api, draft, hostId, unavailable]);

  const run = async (work: () => Promise<InboxRuleCatalog>) => {
    setBusy(true);
    setError('');
    try {
      setCatalog(await work());
      return true;
    } catch (failure) {
      setError(errorDetail(failure));
      return false;
    } finally {
      setBusy(false);
    }
  };
  const loadFolder = async (next: string | null) => {
    const loaded = await run(() =>
      api.listInboxRules(next ? { directory: next } : {}, hostId),
    );
    if (!loaded) return;
    setFolder(next ?? '');
    if (draft?.scope === 'project') setDraft(null);
  };
  const save = async () => {
    if (!draft) return;
    const saved = await run(() =>
      api.saveInboxRule(
        {
          scope: draft.scope,
          ...(draft.scope === 'project' && directory ? { directory } : {}),
          text: draft.text,
          expectedHash: draft.expectedHash,
          ...(draft.previousName ? { previousName: draft.previousName } : {}),
        },
        hostId,
      ),
    );
    if (saved) setDraft(null);
  };
  const addPreset = (text: string) =>
    run(() =>
      api.saveInboxRule({ scope: 'global', text, expectedHash: null }, hostId),
    );
  const propose = async () => {
    setProposing(true);
    setError('');
    try {
      const proposal = await api.proposeInboxRule(
        {
          description: description.trim(),
          provider,
          model: model.trim() || 'default',
          ...(directory ? { directory } : {}),
        },
        hostId,
      );
      setDraft({
        scope: 'global',
        text: proposal.text,
        proposed: true,
        expectedHash: null,
      });
      setIssues(proposal.issues);
      setValid(!!proposal.rule);
    } catch (failure) {
      setError(`No rule was proposed. ${errorDetail(failure)}`);
    } finally {
      setProposing(false);
    }
  };

  if (unavailable)
    return <InlineNotice tone="warning">{unavailable}</InlineNotice>;
  const names = new Set(catalog?.rules.map(rule => rule.name) ?? []);
  return (
    <div className="space-y-6" data-settings="inbox-rules">
      <p className="text-xs text-muted-foreground">
        Inbox rules add review gates for this computer or a trusted project.
      </p>
      {error && <InlineNotice tone="error">{error}</InlineNotice>}
      <SettingsSection title="Routing">
        <SettingsRow
          title="Decisions of child sessions"
          description={
            catalog?.profileManagedRouting
              ? 'From profile'
              : 'Fallback when a rule, workflow or group sets no route.'
          }
        >
          {catalog?.profileManagedRouting ? (
            <Button
              size="sm"
              variant="outline"
              onClick={onEditProfile}
              disabled={!onEditProfile}
            >
              Edit profile setting
            </Button>
          ) : (
            <Select
              value={catalog?.defaultRoute ?? 'inbox'}
              disabled={!catalog || busy}
              onValueChange={value =>
                void run(async () => {
                  await api.saveInboxSettings(
                    { defaultRoute: value as DecisionRoute },
                    hostId,
                  );
                  return api.listInboxRules({ directory }, hostId);
                })
              }
            >
              <SelectTrigger
                aria-label="Default decision route"
                className="w-48"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(routeLabels) as DecisionRoute[]).map(route => (
                  <SelectItem key={route} value={route}>
                    {routeLabels[route]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </SettingsRow>
      </SettingsSection>
      <SettingsSection
        title="Rules"
        action={
          <Button
            size="xs"
            variant="secondary"
            disabled={busy}
            onClick={() => {
              setDraft({ scope: 'global', text: NEW_RULE, expectedHash: null });
              setIssues([]);
            }}
          >
            New rule
          </Button>
        }
      >
        {hostId === 'local' ? (
          <SettingsRow
            title={<label htmlFor="inbox-rules-folder">Project folder</label>}
          >
            <FolderPicker
              id="inbox-rules-folder"
              value={folder || null}
              className="w-[min(24rem,36vw)]"
              chooseDirectory={api.chooseDirectory}
              onChange={loadFolder}
              disabled={busy || !catalog}
            />
          </SettingsRow>
        ) : (
          <SettingsRow
            title={<label htmlFor="inbox-rules-folder">Project folder</label>}
          >
            <PathInput
              id="inbox-rules-folder"
              value={remoteFolder}
              className="w-52"
              placeholder="Absolute path on this computer"
              onChange={event => setRemoteFolder(event.target.value)}
            />
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => void loadFolder(remoteFolder.trim() || null)}
            >
              Show rules
            </Button>
          </SettingsRow>
        )}
        {catalog?.projectTrust === 'untrusted' && (
          <div className="px-3 py-2">
            <InlineNotice tone="warning">
              This repository has project rules, but it is not trusted. Trust it
              from a session’s repository notice to apply them.
            </InlineNotice>
          </div>
        )}
        {!catalog ? (
          <div className="p-3">
            <SkeletonList label="Loading Inbox rules" rows={2} />
          </div>
        ) : catalog.rules.length === 0 ? (
          <p className="px-3 py-3 text-xs text-muted-foreground">
            No Inbox rules yet. Add a suggestion below or write one.
          </p>
        ) : (
          catalog.rules.map(entry => (
            <SettingsRow
              key={entry.path}
              title={
                <span className="flex flex-wrap items-center gap-1.5">
                  {entry.name}
                  <Badge>
                    {entry.scope === 'global' ? 'Global' : 'Project'}
                  </Badge>
                  {!entry.active && entry.inactiveReason && (
                    <Badge tone="warning">{entry.inactiveReason}</Badge>
                  )}
                </span>
              }
              description={
                <div className="space-y-1">
                  <p>{ruleSummary(entry)}</p>
                  {entry.enforcement
                    .filter(item => item.status === 'unsupported')
                    .map(item => (
                      <Tooltip key={item.provider + '-' + item.modes.join()}>
                        <TooltipTrigger asChild>
                          <span
                            tabIndex={0}
                            className="inline-block max-w-full truncate text-muted-foreground"
                          >
                            {item.provider} · limited enforcement
                          </span>
                        </TooltipTrigger>
                        <TooltipContent variant="panel">
                          {item.detail}
                        </TooltipContent>
                      </Tooltip>
                    ))}
                  <IssueList issues={entry.issues} />
                </div>
              }
            >
              <div className="flex items-center gap-1.5">
                <Switch
                  aria-label={`Enable ${entry.name}`}
                  checked={!!entry.rule?.enabled}
                  disabled={busy || !entry.rule}
                  onCheckedChange={enabled =>
                    void run(() =>
                      api.setInboxRuleEnabled(
                        {
                          scope: entry.scope,
                          ...(entry.scope === 'project' && directory
                            ? { directory }
                            : {}),
                          name: entry.name,
                          expectedHash: entry.contentHash,
                          enabled,
                        },
                        hostId,
                      ),
                    )
                  }
                />
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => {
                    setDraft({
                      scope: entry.scope,
                      text: entry.text,
                      expectedHash: entry.contentHash,
                      previousName: entry.name,
                    });
                    setIssues(entry.issues);
                  }}
                >
                  Edit
                </Button>
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => setRemoving(entry)}
                >
                  Delete
                </Button>
              </div>
            </SettingsRow>
          ))
        )}
      </SettingsSection>
      {draft && (
        <SettingsSection title={draft.proposed ? 'Proposed rule' : 'Rule file'}>
          <div className="space-y-2 p-3">
            <SavedInField
              id="inbox-rule-scope"
              scope={draft.scope}
              triggerClassName="w-48"
              projectPath=".agents/inbox-rules"
              projectDisabled={!directory}
              disabled={busy || !!draft.expectedHash}
              onChange={scope => setDraft({ ...draft, scope })}
            />
            <Textarea
              resize="none"
              ref={ruleEditor}
              aria-label="Rule file"
              size="md"
              spellCheck={false}
              className="field-sizing-content min-h-28 font-mono text-xs"
              aria-invalid={issues.some(issue => issue.severity === 'error')}
              aria-describedby={issues.length ? 'draft-rule-issues' : undefined}
              value={draft.text}
              onChange={event =>
                setDraft({ ...draft, text: event.target.value })
              }
            />
            <div id="draft-rule-issues">
              <IssueList issues={issues} onSelectLine={selectRuleLine} />
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setDraft(null)}>
                Cancel
              </Button>
              <Button disabled={busy || !valid} onClick={() => void save()}>
                Save rule
              </Button>
            </div>
          </div>
        </SettingsSection>
      )}
      <SettingsSection title="Describe a rule">
        <div className="space-y-2 p-3">
          <Textarea
            resize="none"
            aria-label="Describe a rule"
            placeholder="Before git push show me the diff and wait"
            value={description}
            onChange={event => setDescription(event.target.value)}
          />
          <div className="flex flex-wrap items-end gap-2">
            <ModelPicker
              provider={provider}
              model={model}
              effort=""
              statuses={statuses}
              showEffort={false}
              includeDefault
              triggerLabel="Choose proposal model"
              onRefreshProvider={onRefreshProvider}
              onChange={(nextProvider, nextModel) => {
                setProvider(nextProvider);
                setModel(nextModel);
              }}
            />
            <Button
              disabled={proposing || !description.trim() || !model}
              onClick={() => void propose()}
            >
              {proposing ? 'Proposing…' : 'Propose a rule'}
            </Button>
          </div>
          <p className="text-2xs text-muted-foreground">
            Review the proposed file before saving it.
          </p>
        </div>
      </SettingsSection>
      <SettingsSection title="Suggestions">
        {inboxRulePresets.map(preset => {
          const name = /name: ([a-z0-9-]+)/.exec(preset.text)?.[1] ?? '';
          const added = names.has(name);
          return (
            <SettingsRow
              key={preset.id}
              title={preset.label}
              description={added ? 'Added as a global rule.' : undefined}
            >
              <Button
                size="xs"
                variant="ghost"
                disabled={busy || added}
                onClick={() => void addPreset(preset.text)}
              >
                {added ? 'Added' : 'Add'}
              </Button>
            </SettingsRow>
          );
        })}
      </SettingsSection>
      <ConfirmDialog
        open={!!removing}
        onOpenChange={open => {
          if (!open) setRemoving(null);
        }}
        title={`Delete ${removing?.name ?? 'rule'}?`}
        description="The rule file is removed from this computer. Pending Inbox items stay."
        confirmLabel="Delete rule"
        tone="destructive"
        onConfirm={async () => {
          const entry = removing;
          if (!entry) return;
          await run(() =>
            api.deleteInboxRule(
              {
                scope: entry.scope,
                ...(entry.scope === 'project' && directory
                  ? { directory }
                  : {}),
                name: entry.name,
                expectedHash: entry.contentHash,
              },
              hostId,
            ),
          );
          setRemoving(null);
        }}
      />
    </div>
  );
}
