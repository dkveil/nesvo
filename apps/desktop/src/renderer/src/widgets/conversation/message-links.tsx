import { useContext, useEffect, useState, type ReactNode } from 'react';
import { ExternalLink, Inbox, MessageSquare, Monitor } from 'lucide-react';
import {
  ChecksIcon,
  usePullRequestDetails,
  visualState,
  visualStateLabels,
} from '@/entities/pull-request';
import { Chip } from '@/shared/ui/chip';
import { FileTypeIcon } from '@/shared/ui/file-type-icon';
import { Popover, PopoverContent, PopoverTrigger } from '@/shared/ui/popover';
import { StatusDot } from '@/shared/ui/status-dot';
import {
  classifyMessageLink,
  fileTarget,
  type FileTarget,
  type MessageLinkTarget,
} from './message-link-target';
import { MessageLinkContext } from './message-link-context';

function openExternal(url: string) {
  void window.nesvo?.openExternal(url)?.catch(() => undefined);
}

function GithubGlyph() {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M8 0a8 8 0 0 0-2.53 15.59c.4.07.55-.17.55-.38l-.01-1.48c-2.22.48-2.69-.94-2.69-.94-.36-.92-.89-1.17-.89-1.17-.73-.5.06-.49.06-.49.8.06 1.23.82 1.23.82.71 1.22 1.87.87 2.32.67.07-.52.28-.87.51-1.07-1.77-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.22 2.2.82a7.65 7.65 0 0 1 4 0c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.28.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48v2.18c0 .21.15.46.55.38A8 8 0 0 0 8 0Z" />
    </svg>
  );
}

function FileChip({ file }: { file: FileTarget }) {
  const scope = useContext(MessageLinkContext);
  const name = file.path.split('/').at(-1)!;
  const suffix = file.line ? ':' + file.line : '';
  return (
    <Chip
      size="inline"
      icon={<FileTypeIcon name={name} />}
      title={file.path + suffix}
      onClick={() => scope?.openFile(file)}
    >
      <span>{name + suffix}</span>
    </Chip>
  );
}

export function InlineFileCode({
  candidate,
  children,
}: {
  candidate: string;
  children: ReactNode;
}) {
  const scope = useContext(MessageLinkContext);
  const lookup = scope?.fileExists;
  const file = scope ? fileTarget(candidate, scope.directory) : null;
  const path = file?.path;
  const [confirmed, setConfirmed] = useState<{
    path: string;
    lookup: typeof lookup;
  } | null>(null);
  useEffect(() => {
    if (!path || !lookup) return;
    let active = true;
    void lookup(path).then(exists => {
      if (active && exists) setConfirmed({ path, lookup });
    });
    return () => {
      active = false;
    };
  }, [path, lookup]);
  return file && confirmed?.path === path && confirmed?.lookup === lookup ? (
    <FileChip file={file} />
  ) : (
    children
  );
}

const stateTones = {
  open: 'success',
  merged: 'accent',
  closed: 'error',
  draft: 'neutral',
} as const;

function GithubLink({
  target,
  label,
}: {
  target: Extract<MessageLinkTarget, { repository: string }>;
  label: ReactNode;
}) {
  const scope = useContext(MessageLinkContext);
  const [requested, setRequested] = useState(false);
  const reference =
    target.kind === 'pr'
      ? { repository: target.repository, number: target.number }
      : null;
  const { data } = usePullRequestDetails({
    hostId: scope?.hostId ?? '',
    reference,
    api: scope?.pullRequests ?? null,
    enabled: requested,
  });
  const state = data ? visualState(data) : null;
  const title = [
    target.repository + '#' + target.number,
    state && visualStateLabels[state],
  ]
    .filter(Boolean)
    .join(' · ');
  const internal = !!reference && !!scope;
  return (
    <span className="inline-flex max-w-full items-center gap-px align-middle">
      <Chip
        size="inline"
        icon={<GithubGlyph />}
        title={title}
        onFocus={() => setRequested(true)}
        onMouseEnter={() => setRequested(true)}
        onClick={() =>
          internal ? scope.openPullRequest(reference) : openExternal(target.url)
        }
      >
        <span>
          {label ?? (target.kind === 'pr' ? 'PR #' : 'Issue #') + target.number}
        </span>
        {state && (
          <StatusDot
            tone={stateTones[state]}
            label={visualStateLabels[state]}
          />
        )}
        {data && <ChecksIcon checks={data.checks} className="size-3" />}
      </Chip>
      {internal && (
        <Chip
          size="inline"
          aria-label="Open on GitHub"
          title="Open on GitHub"
          className="px-1"
          onClick={() => openExternal(target.url)}
        >
          <ExternalLink aria-hidden="true" />
        </Chip>
      )}
    </span>
  );
}

export function MessageLink({
  href,
  children,
}: {
  href?: string;
  children: ReactNode;
}) {
  const scope = useContext(MessageLinkContext);
  const target = classifyMessageLink(href, scope ?? undefined);
  const content = (
    <MessageLinkContext.Provider value={null}>
      {children}
    </MessageLinkContext.Provider>
  );
  if (!target) return <span>{content}</span>;
  const label =
    children === href || ('url' in target && children === target.url)
      ? null
      : content;
  if ('repository' in target)
    return scope ? (
      <GithubLink target={target} label={label} />
    ) : (
      <ExternalMessageLink url={target.url}>{content}</ExternalMessageLink>
    );
  if (target.kind === 'external')
    return (
      <ExternalMessageLink url={target.url}>{content}</ExternalMessageLink>
    );
  if (!scope) return <span>{content}</span>;
  if (target.kind === 'file') return <FileChip file={target.file} />;
  if (target.kind === 'preview') {
    if (scope.local)
      return (
        <Chip
          size="inline"
          icon={<Monitor />}
          title={target.url}
          onClick={() => openExternal(target.url)}
        >
          <span>{label ?? 'Open preview :' + target.port}</span>
        </Chip>
      );
    return (
      <Popover>
        <PopoverTrigger asChild>
          <Chip size="inline" icon={<Monitor />} title={target.url}>
            <span>{label ?? 'Preview :' + target.port}</span>
          </Chip>
        </PopoverTrigger>
        <PopoverContent surface="solid" size="sm" className="space-y-2 text-xs">
          <p className="font-medium">{scope.hostName}</p>
          <p className="text-muted-foreground">
            This port is on {scope.hostName}. Open it from that computer.
          </p>
          <p className="select-all [overflow-wrap:anywhere]">{target.url}</p>
        </PopoverContent>
      </Popover>
    );
  }
  const destination = scope.internalLink(target.kind, target.id, target.hostId);
  if (!destination)
    return (
      <span>
        {label ??
          (target.kind === 'session'
            ? 'Session unavailable'
            : 'Inbox item unavailable')}
      </span>
    );
  return (
    <Chip
      size="inline"
      icon={target.kind === 'session' ? <MessageSquare /> : <Inbox />}
      title={destination.label}
      onClick={destination.open}
    >
      <span>{label ?? destination.label}</span>
    </Chip>
  );
}

function ExternalMessageLink({
  url,
  children,
}: {
  url: string;
  children: ReactNode;
}) {
  return (
    <a
      href={url}
      title={url}
      rel="noreferrer"
      className="underline decoration-muted-foreground/60 underline-offset-2 hover:decoration-foreground"
      onClick={event => {
        event.preventDefault();
        openExternal(url);
      }}
      onAuxClick={event => {
        if (event.button === 1) {
          event.preventDefault();
          openExternal(url);
        }
      }}
    >
      {children}{' '}
      <ExternalLink
        aria-hidden="true"
        className="inline size-3 align-text-bottom text-muted-foreground"
      />
    </a>
  );
}
