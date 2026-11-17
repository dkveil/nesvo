import {
  Component,
  Fragment,
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  CodeView,
  type CodeViewItem,
  type CodeViewReactOptions,
} from '@pierre/diffs/react';
import type {
  DesktopApi,
  Session,
  WorkspaceDirectory,
  WorkspaceEntry,
  WorkspaceFile,
  WorkspaceSearch,
} from '@nesvo/contracts';
import {
  ChevronRight,
  ChevronsDownUp,
  FolderOpen,
  RefreshCw,
  WrapText,
  X,
} from 'lucide-react';
import { cn } from '@/shared/lib/cn';
import { errorDetail } from '@/entities/session';
import { Button } from '@/shared/ui/button';
import {
  PANEL_MIN_WIDTH_PX,
  usePanelWidth,
} from '@/shared/lib/use-panel-width';
import { PanelAction, PanelSearch } from '@/shared/ui/panel';
import { PanelResizer } from '@/shared/ui/panel-resizer';
import { panelRow, panelSurface } from '@/shared/ui/panel-styles';
import { FileGlyph } from './file-glyph';

type Props = {
  session: Session;
  api: Pick<
    DesktopApi,
    'listWorkspaceDirectory' | 'searchWorkspaceFiles' | 'readWorkspaceFile'
  >;
  savedVersion?: number;
  onSavedDiff: () => void;
  onClose: () => void;
};

type DirectoryState = {
  data?: WorkspaceDirectory;
  error?: string;
  loading: boolean;
};

const TREE_INDENT_PX = 12;
const TREE_INSET_PX = 6;

const fileName = (path: string) => path.split('/').at(-1) ?? path;

function Directory({
  path,
  sessionId,
  api,
  selectedPath,
  onSelect,
  level = 0,
}: {
  path: string;
  sessionId: string;
  api: Props['api'];
  selectedPath: string;
  onSelect: (path: string) => void;
  level?: number;
}) {
  const [state, setState] = useState<DirectoryState>({ loading: true });
  const [expanded, setExpanded] = useState<string[]>([]);
  useEffect(() => {
    let current = true;
    void api.listWorkspaceDirectory({ sessionId, path }).then(
      data => {
        if (current) setState({ data, loading: false });
      },
      error => {
        if (current) setState({ error: errorDetail(error), loading: false });
      },
    );
    return () => {
      current = false;
    };
  }, [api, path, sessionId]);
  if (state.loading)
    return (
      <p role="status" className="px-3 py-1.5 text-2xs text-muted-foreground">
        Loading folder…
      </p>
    );
  if (state.error)
    return (
      <p
        role="alert"
        className="px-3 py-1.5 text-xs leading-5 text-destructive [overflow-wrap:anywhere]"
      >
        {state.error}
      </p>
    );
  return (
    <ul className="min-w-0">
      {state.data?.entries.map(entry => {
        const open = expanded.includes(entry.path);
        const isDirectory = entry.kind === 'directory';
        return (
          <li key={entry.path}>
            <button
              type="button"
              aria-label={
                isDirectory
                  ? `${open ? 'Collapse' : 'Expand'} ${entry.path}`
                  : `Open file ${entry.path}`
              }
              aria-expanded={isDirectory ? open : undefined}
              aria-pressed={
                isDirectory ? undefined : selectedPath === entry.path
              }
              title={entry.path}
              style={{
                paddingLeft:
                  TREE_INSET_PX + Math.min(level, 12) * TREE_INDENT_PX,
              }}
              className={cn(
                panelRow,
                'flex h-[1.375rem] w-full min-w-0 items-center gap-1.5 pr-2 text-xs text-foreground/85',
                'aria-pressed:bg-accent aria-pressed:ring-1 aria-pressed:ring-ring/60 aria-pressed:ring-inset',
              )}
              onClick={() =>
                isDirectory
                  ? setExpanded(previous =>
                      open
                        ? previous.filter(value => value !== entry.path)
                        : [...previous, entry.path],
                    )
                  : onSelect(entry.path)
              }
            >
              {isDirectory ? (
                <ChevronRight
                  aria-hidden="true"
                  className={cn(
                    'size-3.5 shrink-0 text-muted-foreground transition-transform duration-150 ease-out',
                    open && 'rotate-90',
                  )}
                />
              ) : (
                <FileGlyph name={entry.name} />
              )}
              <span className="truncate">{entry.name}</span>
            </button>
            {isDirectory && open && (
              <Directory
                path={entry.path}
                sessionId={sessionId}
                api={api}
                selectedPath={selectedPath}
                onSelect={onSelect}
                level={level + 1}
              />
            )}
          </li>
        );
      })}
      {state.data?.entries.length === 0 && (
        <li className="px-3 py-1.5 text-2xs text-muted-foreground">
          Empty folder
        </li>
      )}
      {state.data?.truncated && (
        <li
          title={state.data.detail ?? undefined}
          className="px-3 py-1.5 text-2xs leading-5 text-muted-foreground"
        >
          Some entries could not be listed.
        </li>
      )}
    </ul>
  );
}

function SearchResults({
  query,
  sessionId,
  api,
  onSelect,
  selectedPath,
}: {
  query: string;
  sessionId: string;
  api: Props['api'];
  onSelect: (path: string) => void;
  selectedPath: string;
}) {
  const [state, setState] = useState<{
    data?: WorkspaceSearch;
    error?: string;
  }>({});
  useEffect(() => {
    let current = true;
    const timer = window.setTimeout(() => {
      void api.searchWorkspaceFiles({ sessionId, path: '', query }).then(
        data => {
          if (current) setState({ data });
        },
        error => {
          if (current) setState({ error: errorDetail(error) });
        },
      );
    }, 200);
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
  }, [api, query, sessionId]);
  if (state.error)
    return (
      <p
        role="alert"
        className="px-3 py-1.5 text-xs text-destructive [overflow-wrap:anywhere]"
      >
        {state.error}
      </p>
    );
  if (!state.data)
    return (
      <p role="status" className="px-3 py-1.5 text-2xs text-muted-foreground">
        Searching…
      </p>
    );
  return (
    <ul aria-label="File search results" className="min-w-0">
      {state.data.matches.map((entry: WorkspaceEntry) => (
        <li key={entry.path}>
          <button
            type="button"
            aria-label={`Open file ${entry.path}`}
            aria-pressed={selectedPath === entry.path}
            title={entry.path}
            onClick={() => onSelect(entry.path)}
            className={cn(
              panelRow,
              'flex w-full min-w-0 items-start gap-1.5 px-2 py-1 text-xs',
            )}
          >
            <FileGlyph name={entry.name} className="mt-0.5" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-foreground">
                {entry.name}
              </span>
              <span className="block truncate text-2xs text-muted-foreground">
                {entry.path}
              </span>
            </span>
          </button>
        </li>
      ))}
      {state.data.matches.length === 0 && (
        <li className="px-3 py-1.5 text-2xs text-muted-foreground">
          {state.data.truncated
            ? 'No matches in scanned files'
            : 'No matching files'}
        </li>
      )}
      {state.data.truncated && (
        <li
          title={state.data.detail ?? undefined}
          className="px-3 py-1.5 text-2xs leading-5 text-muted-foreground"
        >
          Partial results. Browse folders for more.
        </li>
      )}
    </ul>
  );
}

class PreviewBoundary extends Component<
  { children: ReactNode; text: string },
  { failed: boolean }
> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override render() {
    return this.state.failed ? (
      <pre className="h-full overflow-auto p-3 text-xs leading-5">
        <code>{this.props.text}</code>
      </pre>
    ) : (
      this.props.children
    );
  }
}

function SourceCode({ file, wrap }: { file: WorkspaceFile; wrap: boolean }) {
  const items = useMemo<CodeViewItem<undefined>[]>(
    () => [
      {
        id: file.path,
        type: 'file',
        file: { name: file.path, contents: file.text ?? '' },
      },
    ],
    [file],
  );
  const options = useMemo<CodeViewReactOptions<undefined, undefined>>(
    () => ({
      theme: { dark: 'github-dark', light: 'github-light' },
      themeType: 'system',
      preferredHighlighter: 'shiki-js',
      disableFileHeader: true,
      overflow: wrap ? 'wrap' : 'scroll',
      tokenizeMaxLength: 100000,
      tokenizeMaxLineLength: 1000,
      unsafeCSS:
        ':host{--diffs-font-size:12px;--diffs-line-height:20px;--diffs-bg:var(--background);--diffs-fg:var(--foreground)} [data-diffs]{background:var(--background)} [data-code]{font-family:Consolas,monospace}',
    }),
    [wrap],
  );
  return (
    <PreviewBoundary text={file.text ?? ''}>
      <CodeView
        items={items}
        options={options}
        disableWorkerPool
        className="h-full min-h-0"
      />
    </PreviewBoundary>
  );
}

function FilePreview({
  path,
  sessionId,
  api,
  wrap,
}: {
  path: string;
  sessionId: string;
  api: Props['api'];
  wrap: boolean;
}) {
  const [state, setState] = useState<{ file?: WorkspaceFile; error?: string }>(
    {},
  );
  useEffect(() => {
    let current = true;
    void api.readWorkspaceFile({ sessionId, path }).then(
      file => {
        if (current) setState({ file });
      },
      error => {
        if (current) setState({ error: errorDetail(error) });
      },
    );
    return () => {
      current = false;
    };
  }, [api, path, sessionId]);
  return (
    <section
      aria-label="File preview"
      data-file-path={path}
      className="h-full min-h-0 min-w-0 animate-in overflow-hidden duration-150 fade-in-0"
    >
      {state.error ? (
        <p
          role="alert"
          className="p-4 text-xs leading-5 text-destructive [overflow-wrap:anywhere]"
        >
          {state.error}
        </p>
      ) : !state.file ? (
        <p role="status" className="p-4 text-xs text-muted-foreground">
          Loading file…
        </p>
      ) : state.file.status !== 'text' ? (
        <p className="p-4 text-xs leading-6 text-muted-foreground">
          {state.file.detail ??
            (state.file.status === 'binary'
              ? 'This file cannot be previewed as text.'
              : 'This file is too large to preview.')}
        </p>
      ) : state.file.text === '' ? (
        <p className="p-4 text-xs text-muted-foreground">Empty file</p>
      ) : (
        <SourceCode file={state.file} wrap={wrap} />
      )}
    </section>
  );
}

const EDITOR_WIDTH_RATIO = 0.56;
const EDITOR_MAX_WIDTH_PX = 1000;

const defaultEditorWidth = (viewportWidth: number) =>
  Math.min(EDITOR_MAX_WIDTH_PX, viewportWidth * EDITOR_WIDTH_RATIO);

const defaultTreeWidth = () => PANEL_MIN_WIDTH_PX;

export default function WorkspaceFiles({
  session,
  api,
  savedVersion,
  onSavedDiff,
  onClose,
}: Props) {
  const [query, setQuery] = useState('');
  const [tabs, setTabs] = useState<string[]>([]);
  const [path, setPath] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [wrap, setWrap] = useState(false);
  const [collapse, setCollapse] = useState(0);
  const closeButton = useRef<HTMLButtonElement>(null);
  const close = useEffectEvent(onClose);
  const select = useCallback((value: string) => {
    setTabs(previous =>
      previous.includes(value) ? previous : [...previous, value],
    );
    setPath(value);
  }, []);
  const closeTab = (value: string) => {
    const next = tabs.filter(tab => tab !== value);
    setTabs(next);
    if (value === path)
      setPath(next[Math.min(tabs.indexOf(value), next.length - 1)] ?? '');
  };
  useEffect(() => {
    closeButton.current?.focus();
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
  const name =
    session.directory.split(/[\\/]/).filter(Boolean).at(-1) ?? 'Workspace';
  const segments = path ? path.split('/') : [];
  const editing = tabs.length > 0;
  const {
    attach: attachPanel,
    style: panelStyle,
    resizing,
    resizer,
  } = usePanelWidth(
    editing ? 'files-editor' : 'files-tree',
    editing ? defaultEditorWidth : defaultTreeWidth,
  );
  const tree = (
    <nav
      aria-label="Workspace folders"
      className={cn(
        'flex min-h-0 flex-col',
        editing
          ? 'w-[34%] max-w-64 min-w-44 shrink-0 border-l'
          : 'min-w-0 flex-1',
      )}
    >
      <div className="flex h-8 shrink-0 items-center gap-0.5 px-1">
        <PanelAction
          aria-label="Refresh files"
          title="Refresh files and preview"
          onClick={() => setRefresh(value => value + 1)}
        >
          <RefreshCw />
        </PanelAction>
        <PanelSearch
          aria-label="Search files"
          placeholder="Search files"
          maxLength={100}
          value={query}
          onChange={event => setQuery(event.target.value)}
          className="h-7 min-w-0 flex-1 bg-transparent px-1.5 [&_input]:text-xs [&>svg]:hidden"
        />
        <PanelAction
          aria-label="Collapse folders"
          title="Collapse folders"
          onClick={() => setCollapse(value => value + 1)}
        >
          <ChevronsDownUp />
        </PanelAction>
      </div>
      <div
        className="min-h-0 flex-1 overflow-y-auto px-1 pb-1"
        title="Generated and private entries are excluded. Symbolic links are not followed."
      >
        {query.trim() ? (
          <SearchResults
            key={`${refresh}:${query.trim()}`}
            sessionId={session.id}
            query={query.trim()}
            api={api}
            onSelect={select}
            selectedPath={path}
          />
        ) : (
          <Directory
            key={`${refresh}:${collapse}`}
            sessionId={session.id}
            path=""
            api={api}
            onSelect={select}
            selectedPath={path}
          />
        )}
      </div>
    </nav>
  );
  return (
    <section
      aria-label="Workspace files"
      data-session-id={session.id}
      data-editing={editing}
      ref={attachPanel}
      style={panelStyle}
      className={cn(
        panelSurface,
        'transition-[width] duration-150 ease-out motion-reduce:transition-none',
        resizing && 'transition-none',
      )}
    >
      <PanelResizer label="Resize files panel" {...resizer} />
      <header className="drag-region flex h-(--shell-topbar-height) shrink-0 items-stretch border-b pr-(--panel-edge-inset)">
        <div
          role="tablist"
          aria-label="Open files"
          className="flex min-w-0 flex-1 items-stretch overflow-x-auto [scrollbar-width:none]"
        >
          {!editing && (
            <h2 className="flex min-w-0 shrink-0 items-center gap-1.5 pl-3 text-xs font-semibold">
              <FolderOpen
                className="size-3.5 shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
              Files
              <span className="sr-only">Current workspace</span>
              <span
                className="min-w-0 truncate font-normal text-muted-foreground"
                title={session.directory}
              >
                {name}
              </span>
            </h2>
          )}
          {tabs.map(tab => {
            const active = tab === path;
            return (
              <div
                key={tab}
                data-active={active}
                title={tab}
                className={cn(
                  'group relative flex max-w-52 shrink-0 animate-in items-center border-r pr-1 text-xs text-muted-foreground transition-colors duration-100 fade-in-0 slide-in-from-left-1 hover:bg-accent hover:text-foreground',
                  active &&
                    'bg-accent text-foreground after:absolute after:inset-x-0 after:bottom-0 after:h-px after:bg-foreground/60',
                )}
                onAuxClick={event => {
                  if (event.button === 1) closeTab(tab);
                }}
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={active}
                  className="flex h-full min-w-0 items-center gap-1.5 pr-1 pl-3 outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset"
                  onClick={() => setPath(tab)}
                >
                  <FileGlyph name={fileName(tab)} />
                  <span className="truncate">{fileName(tab)}</span>
                </button>
                <button
                  type="button"
                  aria-label={`Close tab ${tab}`}
                  className={cn(
                    'flex size-5 shrink-0 items-center justify-center rounded-sm opacity-0 transition-opacity duration-100 outline-none group-hover:opacity-100 hover:bg-highlight focus-visible:opacity-100 focus-visible:ring-1 focus-visible:ring-ring',
                    active && 'opacity-100',
                  )}
                  onClick={() => closeTab(tab)}
                >
                  <X className="size-3" aria-hidden="true" />
                </button>
              </div>
            );
          })}
        </div>
        <div className="flex shrink-0 items-center gap-0.5 px-1.5">
          {savedVersion !== undefined && (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              aria-label={`Open saved result version ${savedVersion}`}
              onClick={onSavedDiff}
              className="h-7 text-muted-foreground hover:text-foreground"
            >
              Result v{savedVersion}
            </Button>
          )}
          {editing && (
            <PanelAction
              aria-label="Wrap file lines"
              aria-pressed={wrap}
              onClick={() => setWrap(value => !value)}
            >
              <WrapText />
            </PanelAction>
          )}
          <PanelAction
            ref={closeButton}
            aria-label="Close files"
            onClick={onClose}
          >
            <X className="size-4" />
          </PanelAction>
        </div>
      </header>
      {editing && (
        <nav
          aria-label="File path"
          className="flex h-7 shrink-0 items-center gap-1.5 overflow-hidden border-b px-3 text-2xs whitespace-nowrap text-muted-foreground"
        >
          <span>Current workspace</span>
          <ChevronRight
            className="size-3 shrink-0 opacity-60"
            aria-hidden="true"
          />
          <span title={session.directory}>{name}</span>
          {segments.map((segment, index) => (
            <Fragment key={`${index}:${segment}`}>
              <ChevronRight
                className="size-3 shrink-0 opacity-60"
                aria-hidden="true"
              />
              <span
                className={cn(
                  'truncate',
                  index === segments.length - 1 &&
                    'font-medium text-foreground',
                )}
              >
                {segment}
              </span>
            </Fragment>
          ))}
        </nav>
      )}
      <div className="flex min-h-0 min-w-0 flex-1">
        {editing && (
          <div className="min-h-0 min-w-0 flex-1">
            <FilePreview
              key={`${path}:${refresh}`}
              path={path}
              sessionId={session.id}
              api={api}
              wrap={wrap}
            />
          </div>
        )}
        {tree}
      </div>
    </section>
  );
}
