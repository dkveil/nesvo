import {
  modelLabel,
  modeLabel,
  sessionRoleLabel,
  statusLabels,
  type Session,
} from '@/entities/session';
import { formatCost } from '@/shared/lib/format-cost';
import { KeyValueList } from '@/shared/ui/key-value-list';

type Props = { session: Session };

function formatTokens(value: number | null) {
  const count = value ?? 0;
  return count >= 1000 ? `${(count / 1000).toFixed(1)}k` : String(count);
}

function tokenPair(input: number | null, output: number | null) {
  return `${formatTokens(input)} in · ${formatTokens(output)} out`;
}

function sessionUsage({ usageTotals: totals }: Session) {
  if (totals.turns === 0) return null;
  return {
    last: totals.last
      ? tokenPair(totals.last.inputTokens, totals.last.outputTokens)
      : null,
    total: totals.reportedTurns
      ? tokenPair(totals.inputTokens, totals.outputTokens)
      : null,
    cost: formatCost(totals.costUsd),
    unknown: totals.turns - totals.costTurns,
  };
}

export function SessionDetails({ session }: Props) {
  const role = sessionRoleLabel(session);
  const usage = sessionUsage(session);
  return (
    <div className="space-y-6 p-5">
      <section aria-label="Session details" className="space-y-4">
        <h2 className="text-xs font-medium">Session</h2>
        <KeyValueList
          density="comfortable"
          entries={[
            ...(role ? [{ key: 'role', label: 'Role', value: role }] : []),
            { key: 'provider', label: 'Provider', value: session.provider },
            {
              key: 'model',
              label: 'Model',
              value: session.actualModel ?? modelLabel(session.model),
            },
            {
              key: 'status',
              label: 'Status',
              value: statusLabels[session.status],
            },
            {
              key: 'directory',
              label: 'Working directory',
              value: session.directory,
            },
          ]}
        />
      </section>
      {usage && (
        <section aria-label="Usage" className="space-y-4">
          <h2 className="text-xs font-medium">Usage</h2>
          <KeyValueList
            density="comfortable"
            entries={[
              ...(usage.last
                ? [{ key: 'last', label: 'Last turn', value: usage.last }]
                : []),
              ...(usage.total
                ? [{ key: 'session', label: 'Session', value: usage.total }]
                : []),
              { key: 'cost', label: 'Reported cost', value: usage.cost },
            ]}
          />
          {usage.unknown > 0 && (
            <p className="text-xs text-muted-foreground">
              {usage.unknown} {usage.unknown === 1 ? 'turn' : 'turns'} without
              reported cost
            </p>
          )}
        </section>
      )}
      {session.scope && (
        <section className="space-y-2">
          <h2 className="text-xs font-medium">Worker scope</h2>
          <p className="text-xs leading-5 whitespace-pre-wrap text-muted-foreground [overflow-wrap:anywhere]">
            {session.scope}
          </p>
        </section>
      )}
      <section className="space-y-2 border-t pt-5">
        <h2 className="text-xs font-medium">
          {modeLabel(session.provider, session.mode)}
        </h2>
        <p className="text-xs leading-5 text-muted-foreground">
          {session.provider === 'Claude Code'
            ? 'File reading and search. Editing and shell commands are disabled.'
            : session.mode === 'read-only'
              ? 'File reading and read commands. Writes and elevated access are disabled.'
              : 'Files can be edited in this directory. Codex asks for approval when required; not every change needs confirmation.'}
        </p>
      </section>
      <section className="space-y-2 border-t pt-5">
        <h2 className="text-xs font-medium">Workers</h2>
        <p className="text-xs leading-5 text-muted-foreground">
          {session.parentId
            ? 'This worker returns its result to the parent session. Stop affects this worker only. Workers cannot delegate.'
            : session.delegationEnabled
              ? session.mode === 'supervised'
                ? 'Describe a task that needs parallel work to receive worker proposals. Each worker needs your approval. Workspace-editing sessions can delegate read-only work.'
                : 'Describe a task that needs parallel work to receive worker proposals. Approve each worker and its access before it starts. Stop group stops the parent and its workers.'
              : session.provider === 'Claude Code'
                ? 'Worker delegation is not available for Claude Code here.'
                : 'Start a new session to delegate workers. This existing provider thread keeps its original capabilities.'}
        </p>
      </section>
    </div>
  );
}
