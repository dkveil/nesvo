import { useEffect, useEffectEvent, useRef, useState } from 'react';
import type {
  DesktopApi,
  Session,
  SkillCatalog,
  SkillEntry,
} from '@nesvo/contracts';
import { BookOpen, RefreshCw } from 'lucide-react';
import { cn } from '@/shared/lib/cn';
import { errorDetail } from '@/entities/session';
import { Disclosure } from '@/shared/ui/disclosure';
import { EmptyState } from '@/shared/ui/empty-state';
import { KeyValueList, type KeyValueEntry } from '@/shared/ui/key-value-list';
import { PanelAction, PanelSearch } from '@/shared/ui/panel';
import { SidePanel, SidePanelHeader } from '@/shared/ui/side-panel';
import { StatusMessage } from '@/shared/ui/status-message';

type Props = {
  session: Session;
  api: Pick<DesktopApi, 'discoverSkills'>;
  onClose: () => void;
};

const sourceLabels: Record<SkillEntry['source'], string> = {
  project: 'Project',
  user: 'Personal',
  system: 'Built-in',
  managed: 'Managed',
  plugin: 'Plugin',
  unknown: 'Unknown source',
};

const declaredValue = (value: boolean | null) =>
  value === null ? 'Not reported' : value ? 'Yes' : 'No';

const invocationLabel = (skill: SkillEntry) =>
  skill.invocation === 'blocked'
    ? skill.invocationReason || 'Unavailable for this connection'
    : skill.invocation === 'instructions'
      ? 'Shared instructions'
      : skill.invocation === 'native'
        ? 'Native skill'
        : skill.enabled === false
          ? 'Disabled'
          : '';

const skillDetails = (skill: SkillEntry): KeyValueEntry[] => [
  {
    key: 'source-flag',
    label: 'Source flag',
    value:
      skill.enabled === null
        ? 'Not reported'
        : skill.enabled
          ? 'Enabled at source'
          : 'Disabled at source',
  },
  {
    key: 'format',
    label: 'Format',
    value: skill.kind === 'skill' ? 'Skill' : 'Command',
  },
  ...(skill.invocation
    ? [
        {
          key: 'delivery',
          label: 'Delivery',
          value:
            skill.invocation === 'instructions'
              ? 'Shared instructions · static snapshot for this message'
              : skill.invocation === 'native'
                ? 'Native skill'
                : skill.invocationReason || 'Blocked for this connection',
        },
      ]
    : []),
  ...(skill.origins?.length
    ? [{ key: 'origins', label: 'Origins', value: skill.origins.join(', ') }]
    : []),
  ...(skill.userInvocable !== null
    ? [
        {
          key: 'manual',
          label: 'Declared manual use',
          value: declaredValue(skill.userInvocable),
        },
      ]
    : []),
  ...(skill.modelInvocable !== null
    ? [
        {
          key: 'automatic',
          label: 'Declared automatic use',
          value: declaredValue(skill.modelInvocable),
        },
      ]
    : []),
  ...(skill.path
    ? [
        {
          key: 'path',
          label: 'Source file',
          value: <span className="font-mono text-2xs">{skill.path}</span>,
        },
      ]
    : []),
  ...(skill.contentHash
    ? [
        {
          key: 'hash',
          label: 'Content SHA-256',
          value: (
            <span className="font-mono text-2xs">{skill.contentHash}</span>
          ),
        },
      ]
    : []),
];

function SkillRow({ skill }: { skill: SkillEntry }) {
  const [open, setOpen] = useState(false);
  const invocation = invocationLabel(skill);
  return (
    <Disclosure
      data-skill-id={skill.id}
      open={open}
      onOpenChange={setOpen}
      triggerLabel={`Details for ${skill.name}`}
      title={skill.name}
      meta={[skill.origins?.join(', '), sourceLabels[skill.source]]
        .filter(Boolean)
        .join(' · ')}
      description={
        (skill.description && !open) || invocation ? (
          <>
            {skill.description && !open && (
              <span className="line-clamp-2">{skill.description}</span>
            )}
            {invocation && <span>{invocation}</span>}
          </>
        ) : undefined
      }
      contentClassName="space-y-3 pr-2 pb-3"
    >
      {skill.description && (
        <p className="leading-5 whitespace-pre-wrap [overflow-wrap:anywhere]">
          {skill.description}
        </p>
      )}
      <KeyValueList entries={skillDetails(skill)} />
      {skill.detail && (
        <p className="leading-5 [overflow-wrap:anywhere]">{skill.detail}</p>
      )}
    </Disclosure>
  );
}

function Catalog({
  session,
  api,
  onClose,
  onRefresh,
}: Props & { onRefresh: () => void }) {
  const [query, setQuery] = useState('');
  const [state, setState] = useState<{
    catalog?: SkillCatalog;
    error?: string;
  }>({});
  const search = useRef<HTMLInputElement>(null);
  const close = useEffectEvent(onClose);
  useEffect(() => {
    let current = true;
    void api.discoverSkills({ sessionId: session.id }).then(
      catalog => {
        if (!current) return;
        setState(
          catalog.sessionId === session.id &&
            catalog.provider === session.provider
            ? { catalog }
            : {
                error:
                  'The skill catalog does not match this session. Refresh to try again.',
              },
        );
      },
      error => {
        if (current) setState({ error: errorDetail(error) });
      },
    );
    return () => {
      current = false;
    };
  }, [api, session.id, session.provider]);
  useEffect(() => {
    search.current?.focus();
    const escape = (event: KeyboardEvent) => {
      if (
        event.key === 'Escape' &&
        !event.defaultPrevented &&
        !(
          event.target instanceof Element &&
          event.target.closest('[role="dialog"]')
        )
      ) {
        event.preventDefault();
        close();
      }
    };
    document.addEventListener('keydown', escape);
    return () => document.removeEventListener('keydown', escape);
  }, []);
  const { catalog, error } = state;
  const loading = !catalog && !error;
  const term = query.trim().toLowerCase();
  const skills =
    catalog?.skills.filter(skill =>
      [
        skill.name,
        skill.description,
        skill.path,
        sourceLabels[skill.source],
        ...(skill.origins ?? []),
      ].some(value => value?.toLowerCase().includes(term)),
    ) ?? [];
  return (
    <>
      <SidePanelHeader
        closeLabel="Close skills"
        onClose={onClose}
        icon={BookOpen}
        title="Shared library"
        meta={session.provider}
      >
        <PanelAction
          label="Refresh skills"
          disabled={loading}
          onClick={onRefresh}
        >
          <RefreshCw className={cn(loading && 'animate-spin')} />
        </PanelAction>
      </SidePanelHeader>
      <PanelSearch
        ref={search}
        aria-label="Search skills"
        placeholder="Search skills"
        maxLength={200}
        value={query}
        onChange={event => setQuery(event.target.value)}
        className="m-1.5"
      />
      {catalog && (
        <div className="flex shrink-0 items-center justify-between gap-3 px-3 pt-1 pb-2 text-2xs text-muted-foreground">
          <span>
            {term
              ? `${skills.length} of ${catalog.skills.length}`
              : catalog.skills.length}{' '}
            skills
          </span>
          <span>
            {catalog.method === 'native'
              ? 'Provider catalog'
              : catalog.method === 'library'
                ? 'Shared library'
                : 'Local skill files'}
          </span>
        </div>
      )}
      <div className="min-h-0 flex-1 space-y-px overflow-y-auto px-1.5 pb-1.5">
        {loading && (
          <StatusMessage tone="loading" className="p-3">
            Discovering skills…
          </StatusMessage>
        )}
        {error && (
          <StatusMessage tone="error" className="p-3">
            {error}
          </StatusMessage>
        )}
        {catalog && skills.length === 0 && (
          <EmptyState
            size="sm"
            icon={BookOpen}
            title={term ? 'No matching skills' : 'No skills'}
            description={
              term
                ? undefined
                : catalog.status === 'unsupported'
                  ? 'Skill discovery is not supported by this provider version.'
                  : catalog.status === 'unavailable'
                    ? 'Skill discovery is unavailable.'
                    : 'No skills found in the checked sources.'
            }
          />
        )}
        {skills.map(skill => (
          <SkillRow key={skill.id} skill={skill} />
        ))}
        {catalog && (catalog.issues.length > 0 || catalog.truncated) && (
          <Disclosure
            title={
              catalog.status === 'unavailable' ||
              catalog.status === 'unsupported'
                ? 'Discovery details'
                : 'Some sources could not be verified'
            }
            className="mt-1.5 border-t pt-1.5"
          >
            <ul className="space-y-3 pt-1 pb-2 text-2xs leading-5">
              {catalog.issues.map((issue, index) => (
                <li key={index} className="[overflow-wrap:anywhere]">
                  <p>{issue.message}</p>
                  {issue.path && <p className="mt-1 font-mono">{issue.path}</p>}
                </li>
              ))}
              {catalog.truncated && (
                <li>
                  The catalog is limited. Some entries or metadata were omitted.
                </li>
              )}
            </ul>
          </Disclosure>
        )}
      </div>
      <footer className="shrink-0 border-t px-3 py-2.5 text-2xs text-muted-foreground">
        {catalog?.method === 'filesystem'
          ? 'File metadata only. Provider availability is not verified. '
          : ''}
        {catalog?.method === 'library'
          ? 'Type / to choose a skill. Delivery and compatibility are shown per entry; permissions stay unchanged.'
          : catalog?.invocationSupported
            ? 'Type / in your message or choose Skills in the composer to select one skill.'
            : 'Skill invocation is unavailable for this connection.'}
      </footer>
    </>
  );
}

export default function SessionSkills(props: Props) {
  const [refresh, setRefresh] = useState(0);
  return (
    <SidePanel
      kind="skills"
      resizeLabel="Resize skills panel"
      aria-label="Session skills"
      data-session-id={props.session.id}
    >
      <Catalog
        key={`${props.session.id}:${refresh}`}
        {...props}
        onRefresh={() => setRefresh(value => value + 1)}
      />
    </SidePanel>
  );
}
