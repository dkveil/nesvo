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
import { Input } from '@/shared/ui/input';
import { Field } from '@/shared/ui/field';
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
import { ruleSummary, routeLabels, statusTone } from './rule-text';

type InboxRulesApi = Pick<
  DesktopApi,
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
};

type Draft = {
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

function IssueList({ issues }: { issues: InboxRuleIssue[] }) {
  if (!issues.length) return null;
  return (
    <ul className="space-y-0.5" aria-label="Rule issues">
      {issues.map((issue, index) => (
        <li key={`${issue.message}-${index}`}>
          <StatusMessage
            tone={issue.severity === 'error' ? 'error' : 'warning'}
          >
            {issue.line ? `Line ${issue.line}: ` : ''}
            {issue.message}
          </StatusMessage>
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
}: InboxRulesSettingsProps) {
  const unavailable = unavailableReason(computer);
  const hostId = computer?.id ?? 'local';
  const [folder, setFolder] = useState(defaultFolder ?? '');
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

  const load = async () => {
    if (unavailable) return;
    setError('');
    try {
      setCatalog(await api.listInboxRules({ directory }, hostId));
    } catch (failure) {
      setError(`Inbox rules could not be read. ${errorDetail(failure)}`);
    }
  };
  useEffect(() => {
    if (unavailable) return;
    let current = true;
    api
      .listInboxRules(defaultFolder ? { directory: defaultFolder } : {}, hostId)
      .then(next => {
        if (current) setCatalog(next);
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
      setDraft({ scope: 'global', text: proposal.text, expectedHash: null });
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
          description="Fallback when a rule, workflow or group sets no route."
        >
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
            <SelectTrigger aria-label="Default decision route" className="w-48">
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
        <div className="flex items-end gap-2 px-3 py-2.5">
          <Field
            id="inbox-rules-folder"
            label="Project folder"
            className="flex-1"
          >
            <Input
              id="inbox-rules-folder"
              value={folder}
              placeholder="Folder whose project rules to show"
              onChange={event => setFolder(event.target.value)}
            />
          </Field>
          <Button variant="secondary" onClick={() => void load()}>
            Show rules
          </Button>
        </div>
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
                <span className="block space-y-1">
                  <span className="block">{ruleSummary(entry)}</span>
                  {entry.enforcement
                    .filter(item => item.status === 'unsupported')
                    .map(item => (
                      <span
                        key={`${item.provider}-${item.modes.join()}`}
                        className={statusTone.unsupported}
                      >
                        {item.provider} ({item.modes.join(', ')}):{' '}
                        {item.detail}{' '}
                      </span>
                    ))}
                  <IssueList issues={entry.issues} />
                </span>
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
                  variant="destructive"
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
        <SettingsSection title="Rule file">
          <div className="space-y-2 p-3">
            <Field id="inbox-rule-scope" label="Save to" layout="inline">
              <Select
                value={draft.scope}
                disabled={!!draft.expectedHash}
                onValueChange={value =>
                  setDraft({ ...draft, scope: value as InboxRuleScope })
                }
              >
                <SelectTrigger id="inbox-rule-scope" className="w-48">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="global">Global rules</SelectItem>
                  <SelectItem value="project" disabled={!directory}>
                    Project rules
                  </SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Textarea
              resize="none"
              aria-label="Rule file"
              size="md"
              spellCheck={false}
              className="min-h-64 font-mono text-xs"
              value={draft.text}
              onChange={event =>
                setDraft({ ...draft, text: event.target.value })
              }
            />
            <IssueList issues={issues} />
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
              surface="panel"
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
        surface="panel"
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
