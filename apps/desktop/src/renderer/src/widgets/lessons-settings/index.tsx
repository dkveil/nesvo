import { RuleUsage } from '@/features/gate-rules/rule-usage';
import { useState } from 'react';
import {
  lessonIsDue,
  localDate,
  type Computer,
  type Lesson,
  type LessonChanges,
  type LessonOverview,
  type LessonSettings,
  type Provider,
} from '@nesvo/contracts';
import {
  LessonEditDialog,
  incidentKindLabels,
  lessonDate,
  lessonScopeText,
  lessonStatusText,
  matchesScopeFilter,
  scopeFilterLabels,
  scopeFilters,
  useLessonOverview,
  type LessonApi,
  type ScopeFilter,
} from '@/features/lessons';
import { Badge } from '@/shared/ui/badge';
import { Button } from '@/shared/ui/button';
import { InlineNotice } from '@/shared/ui/inline-notice';
import { Input } from '@/shared/ui/input';
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

type LessonsSettingsProps = {
  computer: Computer | undefined;
  statuses: ProviderStates;
  onRefreshProvider: (provider: Provider) => void;
  api: LessonApi;
};

const unavailableReason = (computer: Computer | undefined) => {
  if (!computer) return 'Choose a computer.';
  if (computer.status !== 'connected')
    return `${computer.name} is offline. Connect it to review its lessons.`;
  if (!computer.capabilities.includes('lessons'))
    return 'Update this computer’s Nesvo host and reconnect to learn lessons from its incidents.';
  return '';
};

const proposalText = (overview: LessonOverview) => {
  const { proposal, pendingIncidents } = overview;
  if (proposal.status === 'running') return 'Proposing lessons…';
  const waiting = `${pendingIncidents} new incident${pendingIncidents === 1 ? '' : 's'} to learn from.`;
  if (proposal.status === 'failed' || proposal.status === 'invalid')
    return `${proposal.error ?? 'The last proposal failed.'} ${waiting}`;
  if (proposal.finishedAt)
    return `Last proposal ${lessonDate(proposal.finishedAt)}: ${proposal.proposed} lesson${proposal.proposed === 1 ? '' : 's'}${proposal.dropped ? `, ${proposal.dropped} left out` : ''}. ${waiting}`;
  return waiting;
};

export function LessonsSettings({
  computer,
  statuses,
  onRefreshProvider,
  api,
}: LessonsSettingsProps) {
  const unavailable = unavailableReason(computer);
  const hostId = computer?.id ?? 'local';
  const lessons = useLessonOverview({ api, hostId, enabled: !unavailable });
  const [filter, setFilter] = useState<ScopeFilter>('all');
  const [editing, setEditing] = useState<Lesson | null>(null);
  const [norm, setNorm] = useState<string | null>(null);
  const [now] = useState(() => new Date());
  if (unavailable) return <InlineNotice>{unavailable}</InlineNotice>;
  const { overview } = lessons;
  if (!overview)
    return lessons.error ? (
      <StatusMessage tone="error">{lessons.error}</StatusMessage>
    ) : (
      <SkeletonList label="Loading lessons" rows={3} />
    );
  const { settings } = overview;
  const today = localDate(now);
  const save = (next: Partial<LessonSettings>) =>
    void lessons.saveSettings({ ...settings, ...next });
  const busy = lessons.pending !== null;
  const visible = overview.lessons.filter(lesson =>
    matchesScopeFilter(lesson, filter),
  );
  const decide = (
    lesson: Lesson,
    decision: 'approve' | 'reject' | 'retire' | 'undo',
  ) =>
    void lessons.decide({
      key: lesson.key,
      expectedVersion: lesson.version,
      decision,
    });
  const submitEdit = async (changes: LessonChanges) => {
    if (!editing) return;
    const done = await lessons.decide({
      key: editing.key,
      expectedVersion: editing.version,
      decision: 'edit',
      changes,
    });
    if (done) setEditing(null);
  };
  const normValue =
    norm ?? (settings.costNormUsd === null ? '' : String(settings.costNormUsd));
  return (
    <div className="space-y-6">
      <p className="text-xs text-muted-foreground">
        Approved lessons guide agents until their review date.
      </p>
      {lessons.error && (
        <StatusMessage tone="error">{lessons.error}</StatusMessage>
      )}
      <SettingsSection title="Proposals">
        <SettingsRow
          title={
            <label htmlFor="lessons-daily">Propose lessons every day</label>
          }
          description="Review proposals from one read-only turn per day."
        >
          <Switch
            id="lessons-daily"
            checked={settings.dailyProposals}
            disabled={busy}
            onCheckedChange={dailyProposals => save({ dailyProposals })}
          />
        </SettingsRow>
        <SettingsRow
          title="Proposal model"
          description="Choose a low-cost model. It reads only the recorded incidents."
        >
          <ModelPicker
            provider={settings.provider}
            model={settings.model}
            effort=""
            statuses={statuses}
            showEffort={false}
            includeDefault
            surface="panel"
            disabled={busy}
            triggerLabel="Choose proposal model"
            onRefreshProvider={onRefreshProvider}
            onChange={(provider, model) =>
              save({
                provider,
                model:
                  provider !== settings.provider && provider === 'Claude Code'
                    ? 'haiku'
                    : model,
              })
            }
          />
        </SettingsRow>
        <SettingsRow
          title={<label htmlFor="lessons-norm">Turn cost norm</label>}
          description="A turn that reports a higher cost in USD becomes an incident. Leave empty to skip costs."
        >
          <Input
            id="lessons-norm"
            className="w-24"
            inputMode="decimal"
            placeholder="Off"
            value={normValue}
            disabled={busy}
            onChange={event => setNorm(event.target.value)}
            onBlur={() => {
              const text = normValue.trim();
              const value = text ? Number(text) : null;
              setNorm(null);
              if (value !== null && !(value > 0)) return;
              if (value !== settings.costNormUsd) save({ costNormUsd: value });
            }}
          />
        </SettingsRow>
        <SettingsRow
          title="Propose now"
          description={
            <StatusMessage
              tone={
                overview.proposal.status === 'running'
                  ? 'loading'
                  : overview.proposal.status === 'idle'
                    ? 'info'
                    : 'warning'
              }
            >
              {proposalText(overview)}
            </StatusMessage>
          }
        >
          <Button
            variant="secondary"
            size="md"
            disabled={
              busy ||
              overview.proposal.status === 'running' ||
              overview.pendingIncidents === 0
            }
            aria-busy={lessons.pending === 'propose' || undefined}
            onClick={() => void lessons.propose()}
          >
            Propose lessons
          </Button>
        </SettingsRow>
      </SettingsSection>
      <SettingsSection
        title="Lessons"
        action={
          <Select
            value={filter}
            onValueChange={value => {
              const next = scopeFilters.find(option => option === value);
              if (next) setFilter(next);
            }}
          >
            <SelectTrigger aria-label="Scope" variant="ghost" className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {scopeFilters.map(option => (
                <SelectItem key={option} value={option}>
                  {scopeFilterLabels[option]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        }
      >
        {visible.length === 0 && (
          <SettingsRow
            title="No lessons yet"
            description="Proposed lessons appear in the Inbox. Approved ones are listed here."
          />
        )}
        {visible.map(lesson => {
          const due = lessonIsDue(lesson, today);
          return (
            <SettingsRow
              key={lesson.key}
              title={
                <span className="flex flex-wrap items-center gap-2">
                  {lesson.id && (
                    <span className="font-mono text-2xs text-muted-foreground">
                      {lesson.id}
                    </span>
                  )}
                  <span className="min-w-0">{lesson.description}</span>
                  {(due || lesson.state !== 'active') && (
                    <Badge
                      size="xs"
                      tone={
                        due || lesson.state === 'proposed'
                          ? 'warning'
                          : 'neutral'
                      }
                    >
                      {lessonStatusText(lesson, today)}
                    </Badge>
                  )}
                  {lesson.kind === 'check' && (
                    <Badge size="xs" tone="info">
                      Check
                    </Badge>
                  )}
                </span>
              }
              description={
                <>
                  <span className="block text-foreground/90">
                    {lesson.body.rule}
                  </span>
                  <span className="block">
                    {lessonScopeText(lesson)}
                    {lesson.review && ` · Review ${lessonDate(lesson.review)}`}
                    {lesson.enforcedBy !== 'none' &&
                      ` · Enforced by ${lesson.enforcedBy}`}
                    {lesson.evidence.length > 0 &&
                      ` · ${lesson.evidence.map(item => incidentKindLabels[item.kind]).join(', ')}`}
                  </span>
                  {lesson.id && (
                    <RuleUsage
                      metrics={lesson.metrics}
                      kind={lesson.kind}
                      since={lesson.createdAt}
                      now={now.getTime()}
                    />
                  )}
                </>
              }
            >
              {lesson.state === 'proposed' && (
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() => decide(lesson, 'approve')}
                >
                  Approve
                </Button>
              )}
              {lesson.state !== 'retired' && (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() => setEditing(lesson)}
                >
                  Edit
                </Button>
              )}
              {lesson.state === 'proposed' && (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() => decide(lesson, 'reject')}
                >
                  Reject
                </Button>
              )}
              {lesson.state === 'active' && (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() => decide(lesson, 'retire')}
                >
                  Retire
                </Button>
              )}
              {lesson.location?.changeId && (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() => decide(lesson, 'undo')}
                >
                  Undo
                </Button>
              )}
            </SettingsRow>
          );
        })}
      </SettingsSection>
      {overview.issues.length > 0 && (
        <SettingsSection title="Lesson files that need attention">
          {overview.issues.map(issue => (
            <SettingsRow
              key={issue}
              title="Not added to prompts"
              description={
                <StatusMessage tone="warning">{issue}</StatusMessage>
              }
            />
          ))}
        </SettingsSection>
      )}
      <SettingsSection title="Recent incidents">
        {overview.incidents.length === 0 && (
          <SettingsRow
            title="No incidents recorded"
            description="Incidents appear when sessions or workflows run into problems."
          />
        )}
        {overview.incidents.slice(0, 20).map(incident => (
          <SettingsRow
            key={incident.id}
            title={incidentKindLabels[incident.kind]}
            description={`${incident.summary} · ${lessonDate(incident.at)}${incident.proposedAt ? ' · Used for a proposal' : ''}`}
          />
        ))}
      </SettingsSection>
      {editing && (
        <LessonEditDialog
          lesson={editing}
          approve={false}
          pending={busy}
          error={lessons.error}
          onSubmit={changes => void submitEdit(changes)}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}
