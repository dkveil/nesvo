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
  DiscoverSkillsInput,
  SkillCatalog,
  SkillEntry,
  SkillReference,
} from '@nesvo/contracts';
import { BookOpen, RefreshCw } from 'lucide-react';
import { Popover } from 'radix-ui';
import { cn } from 'cn';
import { errorDetail, type Provider } from '@/entities/session';
import { Button } from '@/shared/ui/button';
import {
  rankSkills,
  resolveTypedSkill,
  skillCommand,
  slashQueryOf,
  sourceLabels,
  typedCommandOf,
  unavailableReason,
} from './skill-command';

export type SelectedSkill = SkillReference & { description: string };

export type SkillScope = {
  hostId: string;
  provider: Provider;
  input: DiscoverSkillsInput;
};

export type TypedSubmission =
  | { status: 'none' }
  | { status: 'skill'; skill: SelectedSkill; text: string }
  | { status: 'error' };

type Controls = {
  trigger: ReactNode;
  anchor: (node: ReactNode) => ReactNode;
  notice: ReactNode;
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
  onInput: () => void;
  hasTypedCommand: boolean;
  resolveTyped: (draft: string) => Promise<TypedSubmission>;
  inputAria: {
    'aria-controls'?: string;
    'aria-activedescendant'?: string;
    'aria-autocomplete'?: 'list';
    'aria-haspopup'?: 'listbox';
    'aria-expanded'?: boolean;
    'data-skill-input': true;
  };
};

type Props = {
  scope: SkillScope;
  api: Pick<DesktopApi, 'discoverSkills'>;
  draft: string;
  enabled?: boolean;
  onSelect: (skill: SelectedSkill) => void;
  onFocusMessage: () => void;
  children: (controls: Controls) => ReactNode;
};

const toSelected = (skill: SkillEntry): SelectedSkill => ({
  id: skill.id,
  name: skill.name,
  path: skill.path ?? '',
  source: skill.source,
  description: skill.description,
  origins: skill.origins,
  delivery: skill.invocation === 'instructions' ? 'instructions' : 'native',
  contentHash: skill.contentHash,
});

const belongsTo = (catalog: SkillCatalog, scope: SkillScope) =>
  catalog.provider === scope.provider &&
  ('sessionId' in scope.input
    ? catalog.sessionId === scope.input.sessionId
    : !catalog.sessionId);

const requestCatalog = (
  api: Pick<DesktopApi, 'discoverSkills'>,
  scope: SkillScope,
) =>
  api.discoverSkills(scope.input).then(result => {
    if (!belongsTo(result, scope))
      throw new Error(
        'The skill catalog does not match this thread. Refresh to try again.',
      );
    return result;
  });

export function SelectSkill({
  scope,
  api,
  draft,
  enabled = true,
  onSelect,
  onFocusMessage,
  children,
}: Props) {
  const listId = useId();
  const scopeKey = JSON.stringify(scope);
  const [manualOpen, setManualOpen] = useState(false);
  const [dismissedDraft, setDismissedDraft] = useState<string | null>(null);
  const [manualQuery, setManualQuery] = useState<string | null>(null);
  const [activeId, setActiveId] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [typedError, setTypedError] = useState('');
  const [state, setState] = useState<{
    key: string;
    catalog?: SkillCatalog;
    error?: string;
  }>({ key: '' });
  const filter = useRef<HTMLInputElement>(null);
  const slashQuery = slashQueryOf(draft);
  const slash = slashQuery !== undefined;
  const open = enabled && (manualOpen || (slash && dismissedDraft !== draft));
  const query = (manualQuery ?? slashQuery ?? '').trim().toLowerCase();
  const current = state.key === scopeKey ? state : { key: scopeKey };
  const { catalog, error } = current;
  const loading = !catalog && !error;
  const skills = catalog ? rankSkills(catalog.skills, query) : [];
  const selectable = skills.filter(skill => !unavailableReason(skill, catalog));
  const active =
    selectable.find(skill => skill.id === activeId) ?? selectable[0];
  const activeIndex = active
    ? skills.findIndex(skill => skill.id === active.id)
    : -1;
  const activeOptionId =
    activeIndex >= 0 ? `${listId}-${activeIndex}` : undefined;
  const fetchCatalog = () => requestCatalog(api, scope);
  useEffect(() => {
    if (!open) return;
    let live = true;
    requestCatalog(api, JSON.parse(scopeKey) as SkillScope).then(
      result => {
        if (live) setState({ key: scopeKey, catalog: result });
      },
      failure => {
        if (live) setState({ key: scopeKey, error: errorDetail(failure) });
      },
    );
    return () => {
      live = false;
    };
  }, [api, open, scopeKey, refresh]);
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
    setTypedError('');
    onSelect(toSelected(skill));
    requestAnimationFrame(onFocusMessage);
  };
  const resolveTyped = async (text: string): Promise<TypedSubmission> => {
    const typed = typedCommandOf(text);
    if (!typed) return { status: 'none' };
    try {
      const resolved = resolveTypedSkill(
        catalog ?? (await fetchCatalog()),
        typed.command,
        typed.text,
      );
      if (resolved.status === 'error') {
        setTypedError(resolved.message);
        return { status: 'error' };
      }
      if (!resolved.text) {
        setTypedError(
          `Add a message after /${typed.command} to send it with this skill.`,
        );
        return { status: 'error' };
      }
      setTypedError('');
      return {
        status: 'skill',
        skill: toSelected(resolved.skill),
        text: resolved.text,
      };
    } catch (failure) {
      setTypedError(`Skills could not be checked. ${errorDetail(failure)}`);
      return { status: 'error' };
    }
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
    } else if (
      (event.key === 'Enter' || event.key === 'Tab') &&
      !event.shiftKey &&
      !event.ctrlKey &&
      !event.altKey &&
      !event.metaKey &&
      active
    ) {
      event.preventDefault();
      choose(active);
    }
  };
  const reload = () => {
    setState({ key: '' });
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
              disabled={!enabled}
              title="Choose skill (type / in the message)"
            >
              <BookOpen className="size-3.5" />
              <span className="hidden sm:inline">Skills</span>
            </Button>
          </Popover.Trigger>
        ),
        anchor: node => <Popover.Anchor asChild>{node}</Popover.Anchor>,
        notice: typedError ? (
          <p
            role="alert"
            className="px-1 text-xs leading-5 text-destructive [overflow-wrap:anywhere]"
          >
            {typedError}
          </p>
        ) : null,
        onKeyDown,
        onInput: () => {
          setDismissedDraft(null);
          setManualQuery(null);
          setTypedError('');
        },
        hasTypedCommand: !!typedCommandOf(draft),
        resolveTyped,
        inputAria: open
          ? {
              'aria-controls': listId,
              'aria-activedescendant': activeOptionId,
              'aria-autocomplete': 'list',
              'aria-haspopup': 'listbox',
              'aria-expanded': true,
              'data-skill-input': true,
            }
          : { 'data-skill-input': true },
      })}
      <Popover.Portal>
        <Popover.Content
          side="top"
          align="start"
          sideOffset={8}
          collisionPadding={{ top: 56, right: 12, bottom: 12, left: 12 }}
          aria-label="Skill menu"
          className="z-50 flex max-h-[min(22rem,var(--radix-popover-content-available-height))] w-(--radix-popover-trigger-width) min-w-[min(24rem,calc(100vw-1.5rem))] flex-col overflow-hidden rounded-xl border bg-popover text-popover-foreground shadow-xl"
          onOpenAutoFocus={event => {
            event.preventDefault();
            if (manualOpen) filter.current?.focus();
          }}
          onCloseAutoFocus={event => event.preventDefault()}
          onInteractOutside={event => {
            if (
              event.target instanceof Element &&
              event.target.closest('[data-skill-input]')
            )
              event.preventDefault();
          }}
          onKeyDown={onKeyDown}
        >
          {manualOpen && (
            <div className="flex shrink-0 items-center gap-1 border-b px-2 py-1.5">
              <span
                aria-hidden="true"
                className="pl-1 text-sm text-muted-foreground"
              >
                /
              </span>
              <input
                ref={filter}
                aria-label="Filter skills"
                placeholder="Find a skill"
                value={manualQuery ?? ''}
                onChange={event => setManualQuery(event.target.value)}
                maxLength={256}
                className="h-7 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground/70"
                aria-controls={listId}
                aria-activedescendant={activeOptionId}
                aria-autocomplete="list"
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-6 text-muted-foreground"
                aria-label="Refresh skill choices"
                title="Refresh skill choices"
                disabled={loading}
                onClick={reload}
              >
                <RefreshCw className="size-3" />
              </Button>
            </div>
          )}
          {loading && (
            <p
              role="status"
              className="px-3 py-2.5 text-xs text-muted-foreground"
            >
              Loading skills…
            </p>
          )}
          {error && (
            <div className="flex items-center gap-2 px-3 py-2.5">
              <p
                role="alert"
                className="min-w-0 flex-1 text-xs text-destructive [overflow-wrap:anywhere]"
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
            id={listId}
            role="listbox"
            aria-label="Skills"
            className="min-h-0 overflow-y-auto p-1"
          >
            {skills.map((skill, index) => {
              const reason = unavailableReason(skill, catalog);
              const selected = active?.id === skill.id;
              const source = [
                skill.origins?.join(', '),
                sourceLabels[skill.source],
              ]
                .filter(Boolean)
                .join(' · ');
              return (
                <div
                  key={skill.id}
                  id={`${listId}-${index}`}
                  role="option"
                  aria-label={skill.name}
                  aria-selected={selected}
                  aria-disabled={!!reason}
                  tabIndex={-1}
                  data-skill-command={skillCommand(skill)}
                  title={[
                    skill.name,
                    skill.description,
                    source,
                    reason ||
                      (skill.invocation === 'instructions'
                        ? 'Shared instructions'
                        : 'Native skill'),
                    skill.path,
                    skill.contentHash,
                    skill.detail,
                  ]
                    .filter(Boolean)
                    .join('\n')}
                  onMouseDown={event => event.preventDefault()}
                  onMouseMove={() => {
                    if (!reason && !selected) setActiveId(skill.id);
                  }}
                  onClick={() => choose(skill)}
                  className={cn(
                    'flex h-8 min-w-0 items-center gap-2 rounded-lg px-2.5 text-[13px] transition-colors duration-100',
                    reason ? 'cursor-not-allowed opacity-45' : 'cursor-pointer',
                    selected && 'bg-accent',
                  )}
                >
                  <span className="shrink-0 font-semibold">
                    /{skillCommand(skill)}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-muted-foreground">
                    {reason || skill.description || 'No description provided.'}
                  </span>
                  <span className="hidden shrink-0 text-[11px] text-muted-foreground/70 sm:inline">
                    {source}
                  </span>
                </div>
              );
            })}
            {catalog && !skills.length && (
              <p className="px-2.5 py-2 text-xs text-muted-foreground">
                {query
                  ? `No skill matches /${query}.`
                  : 'No skills are available here.'}
              </p>
            )}
          </div>
          {catalog && (catalog.truncated || catalog.issues.length > 0) && (
            <p
              className="shrink-0 border-t px-3 py-1.5 text-[11px] text-muted-foreground"
              title={catalog.issues.map(issue => issue.message).join('\n')}
            >
              Some sources could not be included. Open Skills for details.
            </p>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
