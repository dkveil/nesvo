import {
  modelLabel,
  modeLabels,
  sessionRoleLabel,
  statusLabels,
  type Session,
} from '@/entities/session';

type Props = { session: Session };

export function SessionDetails({ session }: Props) {
  const role = sessionRoleLabel(session);
  return (
    <div className="space-y-6 p-5">
      <section aria-label="Session details" className="space-y-4">
        <h2 className="text-xs font-medium">Session</h2>
        <dl className="space-y-3 text-xs">
          {role && (
            <div className="flex justify-between gap-3">
              <dt className="text-muted-foreground">Role</dt>
              <dd>{role}</dd>
            </div>
          )}
          <div className="flex justify-between gap-3">
            <dt className="text-muted-foreground">Provider</dt>
            <dd>{session.provider}</dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-muted-foreground">Model</dt>
            <dd className="min-w-0 break-all text-right">
              {session.actualModel ?? modelLabel(session.model)}
            </dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-muted-foreground">Status</dt>
            <dd>{statusLabels[session.status]}</dd>
          </div>
          <div className="space-y-1">
            <dt className="text-muted-foreground">Working directory</dt>
            <dd className="break-all leading-5">{session.directory}</dd>
          </div>
        </dl>
      </section>
      {session.scope && (
        <section className="space-y-2">
          <h2 className="text-xs font-medium">Worker scope</h2>
          <p className="text-xs leading-5 whitespace-pre-wrap text-muted-foreground [overflow-wrap:anywhere]">
            {session.scope}
          </p>
        </section>
      )}
      <section className="space-y-2 border-t pt-5">
        <h2 className="text-xs font-medium">{modeLabels[session.mode]}</h2>
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
