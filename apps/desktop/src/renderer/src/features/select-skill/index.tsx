import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import {
  claudeCommandRefusal,
  type ClaudeCommandList,
  type DesktopApi,
  type DiscoverSkillsInput,
  type SkillCatalog,
  type SkillEntry,
  type SkillReference,
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
import {
  findNativeCommand,
  menuEntries,
  type MenuEntry,
} from './command-entries';
import {
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
  selectionIssue: string;
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
  api: Pick<DesktopApi, 'discoverSkills'> &
    Partial<Pick<DesktopApi, 'listClaudeCommands'>>;
  draft: string;
  enabled?: boolean;
  selection?: SkillReference;
  requireSnapshot?: boolean;
  nativeCommands?: boolean;
  onCommand?: (name: string) => void;
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
  api.discoverSkills(scope.input, scope.hostId).then(result => {
    if (!belongsTo(result, scope))
      throw new Error(
        'The skill catalog does not match this selection. Refresh to try again.',
      );
    return result;
  });

export function SelectSkill({
  scope,
  api,
  draft,
  enabled = true,
  selection,
  requireSnapshot = false,
  nativeCommands = false,
  onCommand,
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
  const [commandState, setCommandState] = useState<{
    key: string;
    list?: ClaudeCommandList;
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
  const sessionId =
    'sessionId' in scope.input ? scope.input.sessionId : undefined;
  const listCommands = api.listClaudeCommands;
  const commandsEnabled =
    nativeCommands && scope.provider === 'Claude Code' && !!sessionId;
  const commandsCurrent =
    commandState.key === scopeKey ? commandState : { key: scopeKey };
  const commandList =
    commandsCurrent.list?.status === 'ready' ? commandsCurrent.list : undefined;
  const commandIssue =
    commandsCurrent.error ??
    (commandsCurrent.list?.status === 'unavailable'
      ? (commandsCurrent.list.detail ??
        'Claude Code did not list its commands.')
      : null);
  const entries = catalog
    ? menuEntries(
        catalog,
        commandsEnabled ? commandList?.commands : undefined,
        query,
      )
    : [];
  const reasonFor = (skill: SkillEntry) =>
    unavailableReason(skill, catalog) ||
    (requireSnapshot && !skill.contentHash ? 'Snapshot unavailable' : '');
  const isSelectable = (entry: MenuEntry) =>
    entry.kind === 'command' || !reasonFor(entry.skill);
  const selectedEntry = catalog?.skills.find(
    skill => skill.id === selection?.id,
  );
  const selectionIssue = !selection
    ? ''
    : !enabled
      ? 'Connect to the computer to check this skill.'
      : (error ??
        (catalog
          ? !selectedEntry
            ? 'This skill is unavailable for the selected computer and folder.'
            : reasonFor(selectedEntry) ||
              (selectedEntry.invocation !== selection.delivery
                ? 'This skill is unavailable with the selected provider. Select it again.'
                : selectedEntry.contentHash !== selection.contentHash ||
                    selectedEntry.path !== selection.path ||
                    selectedEntry.source !== selection.source
                  ? 'This skill or its source changed. Select it again.'
                  : '')
          : 'Checking selected skill?'));
  const selectable = entries.filter(isSelectable);
  const active =
    selectable.find(entry => entry.id === activeId) ?? selectable[0];
  const activeOptionId = active
    ? listboxOptionId(listId, active.id)
    : undefined;
  const fetchCatalog = () => requestCatalog(api, scope);
  const fetchCommands = async () => {
    if (!commandsEnabled || !listCommands || !sessionId) return undefined;
    if (commandsCurrent.list) return commandsCurrent.list;
    const list = await listCommands({ sessionId }, scope.hostId);
    setCommandState({ key: scopeKey, list });
    return list;
  };
  useEffect(() => {
    if (!open || !commandsEnabled || !listCommands || !sessionId) return;
    const { hostId } = JSON.parse(scopeKey) as SkillScope;
    let live = true;
    listCommands({ sessionId }, hostId).then(
      list => {
        if (live) setCommandState({ key: scopeKey, list });
      },
      failure => {
        if (live)
          setCommandState({ key: scopeKey, error: errorDetail(failure) });
      },
    );
    return () => {
      live = false;
    };
  }, [listCommands, open, commandsEnabled, sessionId, scopeKey, refresh]);
  const needsCatalog = open || (enabled && !!selection);
  useEffect(() => {
    if (!needsCatalog) return;
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
  }, [api, needsCatalog, scopeKey, refresh]);
  const close = () => {
    setManualOpen(false);
    setDismissedDraft(draft);
    setManualQuery(null);
  };
  const chooseSkill = (skill: SkillEntry) => {
    if (reasonFor(skill) || !skill.path) return;
    close();
    setTypedError('');
    onSelect(toSelected(skill));
    requestAnimationFrame(onFocusMessage);
  };
  const choose = (entry: MenuEntry) => {
    if (entry.kind === 'skill') return chooseSkill(entry.skill);
    close();
    setTypedError('');
    onCommand?.(entry.command.name);
    requestAnimationFrame(onFocusMessage);
  };
  const nativeCommand = async (command: string) => {
    if (!commandsEnabled) return null;
    const refusal = claudeCommandRefusal(command);
    if (refusal) return { status: 'refused' as const, message: refusal };
    const list = await fetchCommands();
    if (list?.status !== 'ready') return null;
    return findNativeCommand(list.commands, command)
      ? { status: 'native' as const, message: '' }
      : null;
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
        const native = await nativeCommand(typed.command).catch(() => null);
        if (native?.status === 'native') {
          setTypedError('');
          return { status: 'none' };
        }
        setTypedError(
          native?.message ||
            (commandsEnabled
              ? `No available skill or Claude Code command is named /${typed.command}. Choose one from the list, or remove the leading slash to send plain text.`
              : resolved.message),
        );
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
      const index = selectable.findIndex(entry => entry.id === active?.id);
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
    setCommandState({ key: '' });
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
        selectionIssue,
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
              placeholder={
                commandsEnabled ? 'Find a skill or command' : 'Find a skill'
              }
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
            options={entries.map(entry => {
              if (entry.kind === 'command')
                return {
                  value: entry.id,
                  label: `/${entry.command.name}`,
                  ariaLabel: entry.command.name,
                  description:
                    entry.command.description || 'Claude Code command.',
                  trailing: [entry.command.argumentHint, 'Command']
                    .filter(Boolean)
                    .join(' · '),
                  disabled: false,
                };
              const { skill } = entry;
              const reason = reasonFor(skill);
              return {
                value: skill.id,
                label: `/${skillCommand(skill)}`,
                ariaLabel: skill.name,
                description:
                  reason && /ENOENT|EACCES|EPERM|not a directory/i.test(reason)
                    ? 'Skill file is unavailable. Open Skills for details.'
                    : reason || skill.description || 'No description provided.',
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
              const entry = entries.find(item => item.id === id);
              if (entry && isSelectable(entry)) choose(entry);
            }}
            emptyText={
              query
                ? `No ${commandsEnabled ? 'skill or command' : 'skill'} matches /${query}.`
                : 'No skills are available here.'
            }
            className="min-h-0 flex-1"
          />
        )}
        {((commandsEnabled && commandIssue) ||
          (catalog && (catalog.truncated || catalog.issues.length > 0))) && (
          <StatusMessage
            tone="warning"
            className="shrink-0 border-t px-3 py-1.5"
          >
            Some skills or commands are unavailable. Open Skills for details.
          </StatusMessage>
        )}
      </PopoverContent>
    </Popover>
  );
}
