import { useMemo, useRef, useState, type ReactNode } from 'react';
import { ArrowRightLeft } from 'lucide-react';
import { ProviderGlyph, type Provider } from '@/entities/session';
import { shortcutKeys } from '@/shared/lib/keyboard-shortcuts';
import { Dialog, DialogContent, DialogTitle } from '@/shared/ui/dialog';
import { KeyCombo } from '@/shared/ui/kbd';
import { Listbox, type ListboxOption } from '@/shared/ui/listbox';
import { listboxOptionId } from '@/shared/ui/listbox-option-id';
import { SearchField } from '@/shared/ui/search-field';
import { fuzzyScore } from './fuzzy-score';

export type PaletteMode = 'all' | 'sessions';

export type PaletteCommand = {
  id: string;
  label: string;
  icon: ReactNode;
  shortcut?: string;
  keywords?: string;
  description?: string;
  disabled?: boolean;
  keepOpen?: boolean;
  run: () => void;
};

export type PaletteSession = {
  key: string;
  title: string;
  folder: string;
  group: string;
  computer: string;
  provider: Provider;
  status: string;
};

type Props = {
  initialMode: PaletteMode;
  commands: PaletteCommand[];
  sessions: PaletteSession[];
  onOpenSession: (key: string) => void;
  onClose: () => void;
  returnFocus: HTMLElement | null;
};

type Ranked<T> = { item: T; score: number };

const RESULTS_ID = 'command-palette-results';
const SESSION_LIMIT = 50;
const COMMANDS_GROUP = 'Commands';
const SESSIONS_GROUP = 'Sessions';

const commandValue = (id: string) => `command:${id}`;
const sessionValue = (key: string) => `session:${key}`;

function rank<T>(items: T[], score: (item: T) => number | null, query: string) {
  const ranked = items
    .map(item => ({ item, score: score(item) }))
    .filter((entry): entry is Ranked<T> => entry.score !== null);
  return query.trim()
    ? ranked.sort((left, right) => right.score - left.score)
    : ranked;
}

const sessionDescription = (session: PaletteSession) =>
  [session.folder, session.group, session.computer].filter(Boolean).join(' · ');

export function CommandPalette({
  initialMode,
  commands,
  sessions,
  onOpenSession,
  onClose,
  returnFocus,
}: Props) {
  const [mode, setMode] = useState(initialMode);
  const [query, setQuery] = useState('');
  const [activeKey, setActiveKey] = useState('');
  const pending = useRef<(() => void) | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const allCommands = useMemo<PaletteCommand[]>(
    () => [
      {
        id: 'go-to-session',
        label: 'Go to session…',
        icon: <ArrowRightLeft />,
        shortcut: shortcutKeys('goToSession'),
        keywords: 'switch open find jump thread',
        keepOpen: true,
        run: () => setMode('sessions'),
      },
      ...commands,
    ],
    [commands],
  );
  const rankedCommands = useMemo(
    () =>
      mode === 'all'
        ? rank(
            allCommands,
            command =>
              fuzzyScore(query, [
                { text: command.label, weight: 2 },
                { text: command.keywords ?? '', weight: 1 },
              ]),
            query,
          )
        : [],
    [allCommands, mode, query],
  );
  const rankedSessions = useMemo(
    () =>
      rank(
        sessions,
        session =>
          fuzzyScore(query, [
            { text: session.title, weight: 3 },
            { text: session.folder, weight: 2 },
            { text: session.group, weight: 2 },
            { text: session.computer, weight: 1 },
          ]),
        query,
      ).slice(0, SESSION_LIMIT),
    [sessions, query],
  );
  const commandOptions: ListboxOption<string>[] = rankedCommands.map(
    ({ item }) => ({
      value: commandValue(item.id),
      label: item.label,
      group: COMMANDS_GROUP,
      icon: item.icon,
      description: item.description,
      disabled: item.disabled,
      trailing: item.shortcut ? <KeyCombo keys={item.shortcut} /> : undefined,
      attributes: { 'data-palette-command': item.id },
    }),
  );
  const sessionOptions: ListboxOption<string>[] = rankedSessions.map(
    ({ item }) => ({
      value: sessionValue(item.key),
      label: item.title,
      group: SESSIONS_GROUP,
      icon: <ProviderGlyph provider={item.provider} />,
      description: sessionDescription(item) || undefined,
      trailing: item.status || undefined,
      ariaLabel: [item.title, sessionDescription(item), item.status]
        .filter(Boolean)
        .join(' · '),
      attributes: { 'data-palette-session': item.key },
    }),
  );
  const sessionsFirst =
    !!query.trim() &&
    (rankedSessions[0]?.score ?? -Infinity) >
      (rankedCommands[0]?.score ?? -Infinity);
  const options = sessionsFirst
    ? [...sessionOptions, ...commandOptions]
    : [...commandOptions, ...sessionOptions];
  const enabled = options.filter(option => !option.disabled);
  const active = enabled.findIndex(option => option.value === activeKey);
  const current = enabled[Math.max(active, 0)];
  const choose = (value: string) => {
    const command = allCommands.find(item => commandValue(item.id) === value);
    if (command) {
      if (command.disabled) return;
      if (command.keepOpen) {
        command.run();
        setQuery('');
        setActiveKey('');
        input.current?.focus();
        return;
      }
      pending.current = command.run;
      onClose();
      return;
    }
    const session = sessions.find(item => sessionValue(item.key) === value);
    if (!session) return;
    pending.current = () => onOpenSession(session.key);
    onClose();
  };
  const label = mode === 'sessions' ? 'Go to session' : 'Command palette';
  return (
    <Dialog open onOpenChange={open => !open && onClose()}>
      <DialogContent
        showCloseButton={false}
        aria-describedby={undefined}
        data-command-palette={mode}
        onCloseAutoFocus={event => {
          event.preventDefault();
          if (returnFocus?.isConnected) returnFocus.focus();
          const action = pending.current;
          pending.current = null;
          action?.();
        }}
        placement="top"
        className="gap-0 overflow-hidden p-0 sm:max-w-xl"
      >
        <DialogTitle className="sr-only">{label}</DialogTitle>
        <SearchField
          ref={input}
          variant="palette"
          role="combobox"
          aria-label={label}
          aria-autocomplete="list"
          aria-expanded
          aria-controls={RESULTS_ID}
          aria-activedescendant={
            current ? listboxOptionId(RESULTS_ID, current.value) : undefined
          }
          placeholder={
            mode === 'sessions'
              ? 'Go to session by title, folder, group or computer'
              : 'Type a command or a session'
          }
          maxLength={200}
          value={query}
          onChange={event => {
            setQuery(event.target.value);
            setActiveKey('');
          }}
          onClear={() => {
            setQuery('');
            setActiveKey('');
          }}
          onKeyDown={event => {
            if (event.nativeEvent.isComposing) return;
            if (
              event.key === 'Backspace' &&
              !query &&
              mode === 'sessions' &&
              initialMode === 'all'
            ) {
              event.preventDefault();
              setMode('all');
              return;
            }
            if (!current) return;
            if (event.key === 'Enter') {
              event.preventDefault();
              choose(current.value);
            }
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault();
              const direction = event.key === 'ArrowDown' ? 1 : -1;
              const index =
                (Math.max(active, 0) + direction + enabled.length) %
                enabled.length;
              const next = enabled[index];
              if (next) setActiveKey(next.value);
            }
          }}
        />
        <Listbox
          id={RESULTS_ID}
          label={mode === 'sessions' ? 'Sessions' : 'Commands and sessions'}
          options={options}
          active={current?.value ?? null}
          onActiveChange={next => {
            if (next) setActiveKey(next);
          }}
          onSelect={choose}
          emptyText={
            mode === 'sessions' ? 'No matching sessions' : 'No matches'
          }
          className="max-h-[min(55vh,26rem)]"
        />
      </DialogContent>
    </Dialog>
  );
}
