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
  FileText,
  FolderOpen,
  RefreshCw,
  WrapText,
  X,
} from 'lucide-react';
import { cn } from '@/shared/lib/cn';
import { errorDetail } from '@/entities/session';
import { Button } from '@/shared/ui/button';
import { CodeBlock } from '@/shared/ui/code-block';
import { EmptyState } from '@/shared/ui/empty-state';
import { ListRow } from '@/shared/ui/list-row';
import {
  PANEL_MIN_WIDTH_PX,
  usePanelWidth,
} from '@/shared/lib/use-panel-width';
import {
  Panel,
  PanelAction,
  PanelHeader,
  PanelSearch,
  Toolbar,
} from '@/shared/ui/panel';
import { PanelResizer } from '@/shared/ui/panel-resizer';
import { panelSurface } from '@/shared/ui/panel-styles';
import { StatusMessage } from '@/shared/ui/status-message';
import { TabPanel, Tabs } from '@/shared/ui/tabs';
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

const MAX_TREE_LEVEL = 12;
const TABS_ID = 'workspace-files';

const fileName = (path: string) => path.split('/').at(-1) ?? path;

function TreeNote({ children }: { children: ReactNode }) {
  return (
    <li className="px-2 py-1 text-2xs leading-4 text-muted-foreground">
      {children}
    </li>
  );
}

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
      <StatusMessage tone="loading" className="px-2 py-1">
        Loading folder…
      </StatusMessage>
    );
  if (state.error)
    return (
      <StatusMessage tone="error" className="px-2 py-1">
        {state.error}
      </StatusMessage>
    );
  return (
    <ul className="min-w-0">
      {state.data?.entries.map(entry => {
        const open = expanded.includes(entry.path);
        const isDirectory = entry.kind === 'directory';
        return (
          <li key={entry.path}>
            <ListRow
              density="tree"
              level={Math.min(level, MAX_TREE_LEVEL)}
              selected={!isDirectory && selectedPath === entry.path}
              aria-expanded={isDirectory ? open : undefined}
              leading={
                isDirectory ? (
                  <ChevronRight
                    aria-hidden="true"
                    className={cn(
                      'transition-transform duration-base ease-out',
                      open && 'rotate-90',
                    )}
                  />
                ) : (
                  <FileGlyph name={entry.name} />
                )
              }
              title={entry.name}
              mainProps={{
                'aria-label': isDirectory
                  ? `${open ? 'Collapse' : 'Expand'} ${entry.path}`
                  : `Open file ${entry.path}`,
              }}
              onClick={() =>
                isDirectory
                  ? setExpanded(previous =>
                      open
                        ? previous.filter(value => value !== entry.path)
                        : [...previous, entry.path],
                    )
                  : onSelect(entry.path)
              }
            />
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
      {state.data?.entries.length === 0 && <TreeNote>Empty folder</TreeNote>}
      {state.data?.truncated && (
        <TreeNote>
          Some entries could not be listed.
          {state.data.detail ? ` ${state.data.detail}` : ''}
        </TreeNote>
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
      <StatusMessage tone="error" className="px-2 py-1">
        {state.error}
      </StatusMessage>
    );
  if (!state.data)
    return (
      <StatusMessage tone="loading" className="px-2 py-1">
        Searching…
      </StatusMessage>
    );
  return (
    <ul aria-label="File search results" className="min-w-0">
      {state.data.matches.map((entry: WorkspaceEntry) => (
        <li key={entry.path}>
          <ListRow
            density="two-line"
            selected={selectedPath === entry.path}
            leading={<FileGlyph name={entry.name} />}
            title={entry.name}
            description={entry.path}
            mainProps={{ 'aria-label': `Open file ${entry.path}` }}
            onClick={() => onSelect(entry.path)}
          />
        </li>
      ))}
      {state.data.matches.length === 0 && (
        <TreeNote>
          {state.data.truncated
            ? 'No matches in scanned files'
            : 'No matching files'}
        </TreeNote>
      )}
      {state.data.truncated && (
        <TreeNote>
          Partial results. Browse folders for more.
          {state.data.detail ? ` ${state.data.detail}` : ''}
        </TreeNote>
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
      <div className="h-full overflow-auto p-3">
        <CodeBlock code={this.props.text} maxHeightClassName="max-h-none" />
      </div>
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
      className="h-full min-h-0 min-w-0 animate-in overflow-hidden duration-base ease-out fade-in-0"
    >
      {state.error ? (
        <StatusMessage tone="error" className="p-4">
          {state.error}
        </StatusMessage>
      ) : !state.file ? (
        <StatusMessage tone="loading" className="p-4">
          Loading file…
        </StatusMessage>
      ) : state.file.status !== 'text' ? (
        <EmptyState
          size="sm"
          icon={FileText}
          title={
            state.file.status === 'binary' ? 'Binary file' : 'File too large'
          }
          description={
            state.file.detail ??
            (state.file.status === 'binary'
              ? 'This file cannot be previewed as text.'
              : 'This file is too large to preview.')
          }
        />
      ) : state.file.text === '' ? (
        <EmptyState size="sm" icon={FileText} title="Empty file" />
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
      <Toolbar label="File tools" bordered={false}>
        <PanelAction
          label="Refresh files"
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
          className="min-w-0 flex-1"
        />
        <PanelAction
          label="Collapse folders"
          onClick={() => setCollapse(value => value + 1)}
        >
          <ChevronsDownUp />
        </PanelAction>
      </Toolbar>
      <div className="min-h-0 flex-1 overflow-y-auto px-1 pb-1">
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
        <p className="px-2 pt-3 pb-1 text-2xs leading-4 text-muted-foreground">
          Generated and private entries are excluded. Symbolic links are not
          followed.
        </p>
      </div>
    </nav>
  );
  return (
    <Panel
      aria-label="Workspace files"
      data-session-id={session.id}
      data-editing={editing}
      ref={attachPanel}
      style={panelStyle}
      className={cn(
        panelSurface,
        'transition-[width] duration-slow ease-out',
        resizing && 'transition-none',
      )}
    >
      <PanelResizer label="Resize files panel" {...resizer} />
      <PanelHeader
        titleBar
        icon={FolderOpen}
        title="Files"
        meta={
          !editing && (
            <>
              <span className="sr-only">Current workspace </span>
              <span>{name}</span>
            </>
          )
        }
      >
        {savedVersion !== undefined && (
          <Button
            type="button"
            variant="ghost"
            className="text-muted-foreground"
            aria-label={`Open saved result version ${savedVersion}`}
            onClick={onSavedDiff}
          >
            Result v{savedVersion}
          </Button>
        )}
        {editing && (
          <PanelAction
            label="Wrap file lines"
            aria-pressed={wrap}
            onClick={() => setWrap(value => !value)}
          >
            <WrapText />
          </PanelAction>
        )}
        <PanelAction ref={closeButton} label="Close files" onClick={onClose}>
          <X className="size-4" />
        </PanelAction>
      </PanelHeader>
      {editing && (
        <>
          <Tabs
            variant="editor"
            label="Open files"
            idPrefix={TABS_ID}
            value={path}
            onChange={setPath}
            onClose={closeTab}
            options={tabs.map(tab => ({
              value: tab,
              label: fileName(tab),
              icon: <FileGlyph name={fileName(tab)} />,
              closable: true,
            }))}
          />
          <nav
            aria-label="File path"
            className="flex h-7 shrink-0 items-center gap-1.5 overflow-hidden border-b px-3 text-2xs whitespace-nowrap text-muted-foreground"
          >
            <span>Current workspace</span>
            <ChevronRight
              className="size-3 shrink-0 opacity-60"
              aria-hidden="true"
            />
            <span>{name}</span>
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
        </>
      )}
      <div className="flex min-h-0 min-w-0 flex-1">
        {editing && (
          <TabPanel
            idPrefix={TABS_ID}
            value={path}
            className="min-h-0 min-w-0 flex-1"
          >
            <FilePreview
              key={`${path}:${refresh}`}
              path={path}
              sessionId={session.id}
              api={api}
              wrap={wrap}
            />
          </TabPanel>
        )}
        {tree}
      </div>
    </Panel>
  );
}
