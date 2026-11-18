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
import { RefreshCw } from 'lucide-react';
import { errorDetail, type Provider } from '@/entities/session';
import { Button } from '@/shared/ui/button';
import { IconButton } from '@/shared/ui/icon-button';
import { Listbox } from '@/shared/ui/listbox';
import { listboxOptionId } from '@/shared/ui/listbox-option-id';
import { Popover, PopoverAnchor, PopoverContent } from '@/shared/ui/popover';
import { SearchField } from '@/shared/ui/search-field';
import { StatusMessage } from '@/shared/ui/status-message';
import { Hint } from '@/shared/ui/tooltip';
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
  const activeOptionId = active
    ? listboxOptionId(listId, active.id)
    : undefined;
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
    if (!open || event.defaultPrevented || event.nativeEvent.isComposing)
      return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
      requestAnimationFrame(onFocusMessage);
      return;
    }
    if (
      !(event.target instanceof Element) ||
      !event.target.closest(
        'input, textarea, [role="textbox"], [role="listbox"]',
      )
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
    <Popover
      open={open}
      onOpenChange={next => {
        if (next) {
          setManualOpen(true);
          setManualQuery('');
        } else close();
      }}
    >
      {children({
        anchor: node => <PopoverAnchor asChild>{node}</PopoverAnchor>,
        notice: typedError ? (
          <StatusMessage tone="error" variant="notice">
            {typedError}
          </StatusMessage>
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
      <PopoverContent
        side="top"
        align="start"
        sideOffset={8}
        collisionPadding={{ top: 56, right: 12, bottom: 12, left: 12 }}
        aria-label="Skill menu"
        surface="solid"
        size="trigger"
        padding="none"
        className="flex max-h-[min(22rem,var(--radix-popover-content-available-height))] flex-col overflow-hidden"
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
          <div className="flex shrink-0 items-center border-b pr-1.5">
            <SearchField
              ref={filter}
              variant="underline"
              containerClassName="flex-1 border-b-0"
              aria-label="Filter skills"
              placeholder="Find a skill"
              value={manualQuery ?? ''}
              onChange={event => setManualQuery(event.target.value)}
              onClear={() => setManualQuery('')}
              maxLength={256}
              aria-controls={listId}
              aria-activedescendant={activeOptionId}
              aria-autocomplete="list"
            />
            <IconButton
              label="Refresh skill choices"
              size={24}
              disabled={loading}
              onClick={reload}
            >
              <RefreshCw />
            </IconButton>
          </div>
        )}
        {loading && (
          <StatusMessage tone="loading" className="px-3 py-2.5">
            Loading skills…
          </StatusMessage>
        )}
        {error && (
          <div className="flex items-center gap-2 px-3 py-2">
            <StatusMessage tone="error" className="flex-1">
              {error}
            </StatusMessage>
            <Button type="button" size="xs" variant="outline" onClick={reload}>
              Retry skill discovery
            </Button>
          </div>
        )}
        {catalog && (
          <Listbox
            id={listId}
            label="Skills"
            options={skills.map(skill => {
              const reason = unavailableReason(skill, catalog);
              return {
                value: skill.id,
                label: `/${skillCommand(skill)}`,
                ariaLabel: skill.name,
                description:
                  reason || skill.description || 'No description provided.',
                trailing: [
                  skill.origins?.join(', '),
                  sourceLabels[skill.source],
                ]
                  .filter(Boolean)
                  .join(' · '),
                disabled: !!reason,
              };
            })}
            value={active?.id ?? null}
            active={active?.id ?? null}
            onActiveChange={next => {
              if (next) setActiveId(next);
            }}
            onSelect={id => {
              const skill = skills.find(item => item.id === id);
              if (skill) choose(skill);
            }}
            emptyText={
              query
                ? `No skill matches /${query}.`
                : 'No skills are available here.'
            }
            className="min-h-0 flex-1"
          />
        )}
        {catalog && (catalog.truncated || catalog.issues.length > 0) && (
          <Hint label={catalog.issues.map(issue => issue.message).join(' · ')}>
            <StatusMessage
              tone="warning"
              className="shrink-0 border-t px-3 py-1.5"
            >
              Some sources could not be included. Open Skills for details.
            </StatusMessage>
          </Hint>
        )}
      </PopoverContent>
    </Popover>
  );
}
