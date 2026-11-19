import type { Session } from '@nesvo/contracts';
import type { DatabaseSync } from 'node:sqlite';
import { isAbsolute, relative, sep } from 'node:path';
import { workLaptopRestriction } from '@nesvo/contracts';
import { reportedClaudeModes } from './providers/claude';
import { SessionError, type SessionService } from './sessions/service';
import {
  configurationText,
  ConfigurationRefusal,
  type ConfigurationWriter,
} from './workflows/configuration-changes';
import type { ConfigurationSnapshot } from './workflows/assistant-change-store';

export function supportsModeProposal(
  session: Pick<
    Session,
    | 'directory'
    | 'role'
    | 'archivedAt'
    | 'workflowRunId'
    | 'workflowStepId'
    | 'scheduledJobId'
    | 'plan'
  >,
  dataDirectory: string,
) {
  const workspace = relative(dataDirectory, session.directory);
  return (
    (isAbsolute(workspace) ||
      workspace === '..' ||
      workspace.startsWith('..' + sep)) &&
    session.role !== 'worker' &&
    !session.archivedAt &&
    !session.workflowRunId &&
    !session.workflowStepId &&
    !session.scheduledJobId &&
    !session.plan
  );
}

export function authorityConfiguration(
  database: DatabaseSync,
  sessions: SessionService,
  dataDirectory: string,
  workLaptopMode: boolean,
): ConfigurationWriter {
  const revisions = database.prepare(
    'SELECT revision FROM session_mode_revisions WHERE id = ?',
  );
  return {
    kind: 'database',
    open(target) {
      if (target.area !== 'authority' || workLaptopMode)
        throw new ConfigurationRefusal('unsupported', workLaptopRestriction);
      const session = sessions.snapshot(target.id);
      const row = revisions.get(target.id);
      if (!session || !row || !supportsModeProposal(session, dataDirectory))
        throw new ConfigurationRefusal(
          'unavailable',
          'Choose an existing operator session that supports a permission change.',
        );
      const revision = Number(row.revision);
      const snapshot: ConfigurationSnapshot = {
        identity: target.id,
        label: configurationText(session.title).slice(0, 160),
        provider: session.provider,
        dependencies: session.provider,
        version: { type: 'revision', revision },
        value: { kind: 'authority', value: session.mode },
      };
      return {
        read: () => snapshot,
        prepare({ draft }, before) {
          if (draft?.kind !== 'authority')
            throw new ConfigurationRefusal(
              'invalid-request',
              'Choose a permission mode.',
            );
          if (session.queue.length || session.externalAttachment)
            throw new ConfigurationRefusal(
              'busy',
              'Finish queued work and return the session to Nesvo before changing its mode.',
            );
          if (
            session.provider === 'Claude Code' &&
            draft.value !== 'read-only' &&
            !reportedClaudeModes()?.includes(draft.value)
          )
            throw new ConfigurationRefusal(
              'unsupported',
              'Refresh Claude Code capabilities before proposing this permission mode.',
            );
          try {
            if (
              sessions.validateSelection(target.id, { mode: draft.value })
                .selection.mode !== draft.value
            )
              throw new ConfigurationRefusal(
                'invalid-request',
                'The session cannot use this mode.',
              );
          } catch (error) {
            if (!(error instanceof SessionError)) throw error;
            throw new ConfigurationRefusal(
              error.code === 'busy' ? 'busy' : 'invalid-request',
              error.message,
            );
          }
          return {
            classification: 'authority',
            after: {
              ...before,
              value: draft,
              version: { type: 'revision', revision: revision + 1 },
            },
          };
        },
        write({ to }) {
          if (to.value?.kind !== 'authority')
            throw new ConfigurationRefusal(
              'invalid-request',
              'Choose a permission mode.',
            );
          sessions.changeSelection(
            target.id,
            { mode: to.value.value },
            {
              kind: 'owner',
              via: 'desktop',
              sessionId: null,
            },
          );
        },
      };
    },
  };
}
