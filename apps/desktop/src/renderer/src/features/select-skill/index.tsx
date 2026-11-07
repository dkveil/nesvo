import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import type {
  DesktopApi,
  Session,
  SkillCatalog,
  SkillEntry,
  SkillReference,
} from '@nesvo/contracts';
import { BookOpen, RefreshCw } from 'lucide-react';
import { Popover } from 'radix-ui';
import { errorDetail } from '@/entities/session';
import { Button } from '@/shared/ui/button';
import { Input } from '@/shared/ui/input';

export type SelectedSkill = SkillReference & { description: string };

type Controls = {
  trigger: ReactNode;
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
  onInput: () => void;
  inputAria: {
    'aria-controls'?: string;
    'aria-activedescendant'?: string;
    'aria-autocomplete'?: 'list';
    'aria-haspopup'?: 'listbox';
  };
};

type Props = {
  session: Pick<Session, 'id' | 'provider'>;
  api: Pick<DesktopApi, 'discoverSkills'>;
  draft: string;
  onSelect: (skill: SelectedSkill) => void;
  onFocusMessage: () => void;
  children: (controls: Controls) => ReactNode;
};

const sourceLabels: Record<SkillEntry['source'], string> = {
  project: 'Project',
  user: 'Personal',
  system: 'Built-in',
  managed: 'Managed',
  plugin: 'Plugin',
  unknown: 'Unknown source',
};

const unavailableReason = (skill: SkillEntry, catalog?: SkillCatalog) =>
  skill.invocation === 'blocked'
    ? skill.invocationReason || 'Unavailable for this connection'
    : skill.invocation === 'native' || skill.invocation === 'instructions'
      ? skill.path
        ? ''
        : 'Source file is unavailable'
      : catalog?.method !== 'native' || !catalog.invocationSupported
        ? 'Invocation unavailable'
        : skill.enabled !== true
          ? 'Not enabled in this connection'
          : skill.source === 'plugin'
            ? 'Plugin skill invocation is not supported'
            : skill.kind !== 'skill'
              ? 'Command invocation is not supported'
              : !skill.path
                ? 'Source file is unavailable'
                : skill.userInvocable === false
                  ? 'Manual invocation is disabled'
                  : '';

export function SelectSkill({
  session,
  api,
  draft,
  onSelect,
  onFocusMessage,
  children,
}: Props) {
  const listId = useId();
  const [manualOpen, setManualOpen] = useState(false);
  const [dismissedDraft, setDismissedDraft] = useState<string | null>(null);
  const [manualQuery, setManualQuery] = useState<string | null>(null);
  const [activeId, setActiveId] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [state, setState] = useState<{
    catalog?: SkillCatalog;
    error?: string;
  }>({});
  const search = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const slashQuery = /^\/([^\s]*)/.exec(draft)?.[1];
  const slash = slashQuery !== undefined;
  const open = manualOpen || (slash && dismissedDraft !== draft);
  const query = (manualQuery ?? slashQuery ?? '').trim().toLowerCase();
  const { catalog, error } = state;
  const loading = !catalog && !error;
  const skills =
    catalog?.skills.filter(skill =>
      [
        skill.name,
        skill.description,
        skill.path,
        sourceLabels[skill.source],
        ...(skill.origins ?? []),
      ].some(value => value?.toLowerCase().includes(query)),
    ) ?? [];
  const selectable = skills.filter(skill => !unavailableReason(skill, catalog));
  const active =
    selectable.find(skill => skill.id === activeId) ?? selectable[0];
  const activeIndex = active
    ? skills.findIndex(skill => skill.id === active.id)
    : -1;
  const activeOptionId =
    activeIndex >= 0 ? `${listId}-${activeIndex}` : undefined;
  useEffect(() => {
    if (!open) return;
    let current = true;
    void api.discoverSkills({ sessionId: session.id }).then(
      result => {
        if (!current) return;
        setState(
          result.sessionId === session.id &&
            result.provider === session.provider
            ? { catalog: result }
            : {
                error:
                  'The skill catalog does not match this session. Refresh to try again.',
              },
        );
      },
      failure => {
        if (current) setState({ error: errorDetail(failure) });
      },
    );
    return () => {
      current = false;
    };
  }, [api, open, session.id, session.provider, refresh]);
  useEffect(() => {
    if (open && activeOptionId)
      document
        .getElementById(activeOptionId)
        ?.scrollIntoView({ block: 'nearest' });
  }, [open, activeOptionId]);
  const close = () => {
    setManualOpen(false);
    setDismissedDraft(draft);
    setManualQuery(null);
  };
  const choose = (skill: SkillEntry) => {
    if (unavailableReason(skill, catalog) || !skill.path) return;
    close();
    onSelect({
      id: skill.id,
      name: skill.name,
      path: skill.path,
      source: skill.source,
      description: skill.description,
      origins: skill.origins,
      delivery: skill.invocation === 'instructions' ? 'instructions' : 'native',
      contentHash: skill.contentHash,
    });
    requestAnimationFrame(onFocusMessage);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (!open || event.nativeEvent.isComposing) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
      requestAnimationFrame(onFocusMessage);
      return;
    }
    if (
      !(event.target instanceof Element) ||
      !event.target.closest('input, textarea, [role="listbox"]')
    )
      return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!selectable.length) return;
      const index = selectable.findIndex(skill => skill.id === active?.id);
      const offset = event.key === 'ArrowDown' ? 1 : -1;
      const next =
        selectable[(index + offset + selectable.length) % selectable.length];
      if (next) setActiveId(next.id);
    } else if ((event.key === 'Enter' || event.key === 'Tab') && active) {
      event.preventDefault();
      choose(active);
    }
  };
  const reload = () => {
    setState({});
    setRefresh(value => value + 1);
  };
  return (
    <Popover.Root
      open={open}
      onOpenChange={next => {
        if (next) {
          setManualOpen(true);
          setManualQuery('');
        } else close();
      }}
    >
      {children({
        trigger: (
          <Popover.Trigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              className="text-muted-foreground"
              aria-label="Choose skill"
              title="Choose skill"
            >
              <BookOpen className="size-3.5" />
              <span className="hidden sm:inline">Skills</span>
            </Button>
          </Popover.Trigger>
        ),
        onKeyDown,
        onInput: () => {
          setDismissedDraft(null);
          setManualQuery(null);
        },
        inputAria: open
          ? {
              'aria-controls': listId,
              'aria-activedescendant': activeOptionId,
              'aria-autocomplete': 'list',
              'aria-haspopup': 'listbox',
            }
          : {},
      })}
      <Popover.Portal>
        <Popover.Content
          side="top"
          align="start"
          sideOffset={12}
          collisionPadding={12}
          className="z-50 flex max-h-[min(24rem,var(--radix-popover-content-available-height))] w-[min(28rem,calc(100vw-1.5rem))] flex-col overflow-hidden rounded-xl border bg-popover text-popover-foreground shadow-xl"
          onOpenAutoFocus={event => {
            event.preventDefault();
            if (manualOpen) search.current?.focus();
          }}
          onCloseAutoFocus={event => event.preventDefault()}
          onInteractOutside={event => {
            if (
              event.target instanceof Element &&
              event.target.closest('#message-input')
            )
              event.preventDefault();
          }}
          onKeyDown={onKeyDown}
        >
          <div className="flex shrink-0 items-center gap-2 border-b px-3 py-2">
            <span className="text-xs font-medium">Shared library</span>
            <span className="ml-auto text-[11px] text-muted-foreground">
              {session.provider}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-6"
              aria-label="Refresh skill choices"
              disabled={loading}
              onClick={reload}
            >
              <RefreshCw className="size-3" />
            </Button>
          </div>
          <>
            <Input
              ref={search}
              aria-label="Filter skills"
              placeholder="Find a skill…"
              value={manualQuery ?? slashQuery ?? ''}
              onChange={event => setManualQuery(event.target.value)}
              maxLength={256}
              className="m-2 h-8 w-auto shrink-0 border-transparent text-xs shadow-none"
              aria-controls={listId}
              aria-activedescendant={activeOptionId}
              aria-autocomplete="list"
            />
            {loading && (
              <p role="status" className="p-3 text-xs text-muted-foreground">
                Loading skills…
              </p>
            )}
            {error && (
              <div className="space-y-2 p-3">
                <p
                  role="alert"
                  className="text-xs text-destructive [overflow-wrap:anywhere]"
                >
                  {error}
                </p>
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  onClick={reload}
                >
                  Retry skill discovery
                </Button>
              </div>
            )}
            <div
              ref={list}
              id={listId}
              role="listbox"
              aria-label="Skills"
              className="min-h-0 overflow-y-auto p-1"
            >
              {skills.map((skill, index) => {
                const reason = unavailableReason(skill, catalog);
                const delivery =
                  skill.invocation === 'instructions'
                    ? 'Shared instructions'
                    : 'Native skill';
                return (
                  <div
                    key={skill.id}
                    id={`${listId}-${index}`}
                    role="option"
                    aria-label={skill.name}
                    aria-selected={active?.id === skill.id}
                    aria-disabled={!!reason}
                    tabIndex={-1}
                    title={[
                      skill.description,
                      sourceLabels[skill.source],
                      skill.origins?.join(', '),
                      reason || delivery,
                      skill.path,
                      skill.contentHash,
                      skill.detail,
                      reason,
                    ]
                      .filter(Boolean)
                      .join('\n')}
                    onMouseDown={event => event.preventDefault()}
                    onMouseEnter={() => {
                      if (!reason) setActiveId(skill.id);
                    }}
                    onClick={() => choose(skill)}
                    className={`rounded-lg px-3 py-2 text-xs ${reason ? 'opacity-50' : active?.id === skill.id ? 'cursor-pointer bg-accent' : 'cursor-pointer hover:bg-accent/60'}`}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <span className="truncate font-medium">{skill.name}</span>
                      <span className="shrink-0 text-[10px] text-muted-foreground">
                        {[skill.origins?.join(', '), sourceLabels[skill.source]]
                          .filter(Boolean)
                          .join(' · ')}
                      </span>
                    </div>
                    <p className="mt-1 line-clamp-1 leading-5 text-muted-foreground">
                      {skill.description || 'No description provided.'}
                    </p>
                    <p className="text-[11px] leading-5 text-muted-foreground">
                      {reason || delivery}
                    </p>
                  </div>
                );
              })}
            </div>
            {catalog && !skills.length && (
              <p className="p-3 text-xs text-muted-foreground">
                {query
                  ? 'No matching skills.'
                  : 'No skills available in this session.'}
              </p>
            )}
            {catalog && (catalog.truncated || catalog.issues.length > 0) && (
              <p
                className="border-t px-3 py-2 text-[11px] text-muted-foreground"
                title={catalog.issues.map(issue => issue.message).join('\n')}
              >
                Some sources or entries could not be included. Open Skills for
                discovery details.
              </p>
            )}
            <p className="shrink-0 border-t px-3 py-2 text-[11px] text-muted-foreground">
              ↑ ↓ to navigate · Enter or Tab to select · Esc to close
            </p>
          </>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
