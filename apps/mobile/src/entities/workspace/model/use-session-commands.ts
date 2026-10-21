import {
  type Dispatch,
  type SetStateAction,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';

import type { Session } from '@entities/session';

import type { HostCapabilities, HostClient } from '@shared/api/host';

import type { CreateSessionOptions, WorkspaceMode } from './workspace-types';

type SessionCommandsOptions = {
  client: HostClient;
  mode: WorkspaceMode;
  connected: boolean;
  hostCapabilities: HostCapabilities | null;
  setExamples: Dispatch<SetStateAction<Session[]>>;
  onCreated: (id: string) => void;
  onClosed: () => void;
};

/** Correlates create responses; only an authoritative snapshot opens the new session. */
export function useSessionCommands(options: SessionCommandsOptions) {
  const { client } = options;
  const latest = useRef(options);
  useLayoutEffect(() => {
    latest.current = options;
  }, [options]);
  const pending = useRef<{ requestId: string; sessionId?: string } | null>(null);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState('');

  useEffect(
    () =>
      client.subscribe(event => {
        if (event.type === 'disconnected') {
          if (pending.current)
            setCreateError(
              'The connection dropped. Connect the host and check the session list before retrying.',
            );
          pending.current = null;
          setCreating(false);
        } else if (
          event.type === 'error' &&
          event.requestId &&
          event.requestId === pending.current?.requestId
        ) {
          pending.current = null;
          setCreating(false);
          setCreateError(event.message);
        } else if (
          event.type === 'created' &&
          pending.current &&
          event.requestId === pending.current.requestId
        ) {
          pending.current = { requestId: event.requestId, sessionId: event.sessionId };
          client.listSessions();
        } else if (event.type === 'sessions' && pending.current?.sessionId) {
          const created = event.sessions.find(session => session.id === pending.current?.sessionId);
          if (created) {
            pending.current = null;
            setCreating(false);
            setCreateError('');
            latest.current.onCreated(created.id);
          }
        }
      }),
    [client],
  );

  function create(request: CreateSessionOptions) {
    const name = request.name.trim();
    if (!name || pending.current) return;
    const { mode, connected, hostCapabilities, setExamples, onCreated } = latest.current;
    setCreateError('');
    if (mode === 'live') {
      if (!connected) {
        setCreateError('Connect a host before creating a session.');
        return;
      }
      if (
        !hostCapabilities?.programs.some(
          program => program.id === request.program && program.available,
        )
      ) {
        setCreateError('The selected tool is not available on the connected computer.');
        return;
      }
      const requestId = client.requestId();
      pending.current = { requestId };
      setCreating(true);
      client.createSession(name, request.groupId, requestId, {
        cwd: request.cwd.trim(),
        program: request.program,
      });
    } else {
      if (request.program !== 'shell') {
        setCreateError('Connect a computer to run the selected CLI.');
        return;
      }
      const example: Session = {
        id: `demo-${client.requestId()}`,
        name,
        agent: 'Terminal',
        project: 'workspace',
        host: 'Preview',
        cwd: '~/projects/workspace',
        status: 'idle',
        preview: 'Sample terminal — type help',
        groupId: request.groupId,
      };
      setExamples(current => [example, ...current]);
      onCreated(example.id);
    }
  }

  function closeSession(session: Session) {
    if (session.live) client.closeSession(session.id);
    else latest.current.setExamples(items => items.filter(item => item.id !== session.id));
    latest.current.onClosed();
  }

  return { create, closeSession, creating, createError, setCreateError };
}
