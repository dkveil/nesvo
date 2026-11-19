import type { ConfigurationTarget, Session } from '@nesvo/contracts';
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
  computerId: string,
  desktopProfile: boolean,
  fullAccessEnabled: () => boolean,
): ConfigurationWriter {
  const revisions = database.prepare(
    'SELECT revision FROM session_mode_revisions WHERE id = ?',
  );
  return {
    kind: 'database',
    open(target) {
      if (target.area !== 'authority' || workLaptopMode)
        throw new ConfigurationRefusal('unsupported', workLaptopRestriction);
      if (target.subject !== 'session-mode') {
        const operation = authorityOperation(
          target,
          sessions,
          dataDirectory,
          computerId,
          desktopProfile,
        );
        const snapshot: ConfigurationSnapshot = {
          identity: target.id,
          label: operation.label,
          dependencies: operation.dependencies,
          version: { type: 'revision', revision: 1 },
          value: null,
        };
        return {
          read: () => snapshot,
          prepare({ draft }, before) {
            if (
              draft?.kind !== 'authority' ||
              typeof draft.value === 'string' ||
              draft.value.kind !== target.subject
            )
              throw new ConfigurationRefusal(
                'invalid-request',
                'Choose an action for this setting.',
              );
            const { value } = draft;
            if ('name' in value && configurationText(value.name) !== value.name)
              throw new ConfigurationRefusal(
                'invalid-request',
                'Choose a name without credential-like text.',
              );
            const ownerEffect =
              value.kind === 'claude-allow-rule'
                ? {
                    kind: value.kind,
                    ...operation.approval!,
                    scope: value.scope,
                  }
                : value.kind === 'phone-access'
                  ? { kind: value.kind, action: value.action }
                  : { kind: value.kind };
            return {
              classification: 'authority',
              after: {
                ...before,
                value: draft,
                ownerEffect,
                version: { type: 'revision', revision: 2 },
              },
            };
          },
          write() {
            throw new ConfigurationRefusal(
              'review-required',
              'Complete the action in its desktop confirmation.',
            );
          },
        };
      }
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
          if (draft?.kind !== 'authority' || typeof draft.value !== 'string')
            throw new ConfigurationRefusal(
              'invalid-request',
              'Choose a permission mode.',
            );
          if (session.queue.length || session.externalAttachment)
            throw new ConfigurationRefusal(
              'busy',
              'Finish queued work and return the session to Nesvo before changing its mode.',
            );
          if (draft.value === 'full-access') {
            if (
              !fullAccessEnabled() ||
              session.runId ||
              session.status === 'running'
            )
              throw new ConfigurationRefusal(
                'unsupported',
                'Enable Full access in Settings and finish the current turn first.',
              );
            return {
              classification: 'authority',
              after: {
                ...before,
                value: draft,
                version: { type: 'revision', revision: revision + 1 },
                ownerEffect: { kind: 'full-access', sessionId: target.id },
              },
            };
          }
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
          if (
            to.value?.kind !== 'authority' ||
            typeof to.value.value !== 'string'
          )
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

type AuthorityTarget = Extract<ConfigurationTarget, { area: 'authority' }>;

function authorityOperation(
  target: AuthorityTarget,
  sessions: SessionService,
  directory: string,
  computerId: string,
  desktopProfile: boolean,
) {
  if (target.subject === 'claude-allow-rule') {
    const matches = sessions.list().flatMap(session => {
      if (
        session.provider !== 'Claude Code' ||
        !session.runId ||
        !supportsModeProposal(session, directory)
      )
        return [];
      const approval = session.pendingApprovals.find(
        item => item.id === target.id,
      );
      return approval?.allowPattern && approval.fingerprint
        ? [
            {
              sessionId: session.id,
              runId: session.runId,
              requestId: approval.id,
              fingerprint: approval.fingerprint,
            },
          ]
        : [];
    });
    if (matches.length !== 1)
      throw new ConfigurationRefusal(
        'unavailable',
        'Choose a pending Claude operation with a supported allow rule.',
      );
    const approval = matches[0]!;
    return {
      label: 'Claude allow rule',
      dependencies: approval.fingerprint,
      approval,
    };
  }
  if (
    target.id !== computerId ||
    (!desktopProfile && target.subject !== 'devices')
  )
    throw new ConfigurationRefusal(
      'unavailable',
      'This action belongs to a different computer.',
    );
  return {
    label:
      target.subject === 'devices'
        ? 'Devices'
        : target.subject === 'phone-access'
          ? 'Phone access'
          : 'Computers',
    dependencies: computerId,
  };
}
