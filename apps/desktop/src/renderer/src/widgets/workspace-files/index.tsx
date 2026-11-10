import {
  Component,
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
  ChevronDown,
  ChevronRight,
  FileCode2,
  Folder,
  FolderOpen,
  RefreshCw,
  Search,
  WrapText,
  X,
} from 'lucide-react';
import { errorDetail } from '@/entities/session';
import { Button } from '@/shared/ui/button';
import { Input } from '@/shared/ui/input';

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
      <p role="status" className="px-3 py-2 text-[11px] text-muted-foreground">
        Loading folder…
      </p>
    );
  if (state.error)
    return (
      <p
        role="alert"
        className="px-3 py-2 text-xs leading-5 text-destructive [overflow-wrap:anywhere]"
      >
        {state.error}
      </p>
    );
  return (
    <ul className="min-w-0">
      {state.data?.entries.map(entry => {
        const open = expanded.includes(entry.path);
        const isDirectory = entry.kind === 'directory';
        const Icon = isDirectory ? (open ? FolderOpen : Folder) : FileCode2;
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
              style={{ paddingLeft: 12 + Math.min(level, 12) * 12 }}
              className="flex w-full min-w-0 items-center gap-1.5 py-1.5 pr-3 text-left text-xs text-muted-foreground hover:bg-white/5 focus-visible:outline-ring aria-pressed:bg-white/7 aria-pressed:text-foreground"
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
                open ? (
                  <ChevronDown className="size-3 shrink-0" />
                ) : (
                  <ChevronRight className="size-3 shrink-0" />
                )
              ) : (
                <span className="w-3 shrink-0" />
              )}
              <Icon className="size-3.5 shrink-0" />
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
        <li className="px-3 py-2 text-[11px] text-muted-foreground">
          Empty folder
        </li>
      )}
      {state.data?.truncated && (
        <li
          title={state.data.detail ?? undefined}
          className="px-3 py-2 text-[11px] leading-5 text-muted-foreground"
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
        className="px-3 py-2 text-xs text-destructive [overflow-wrap:anywhere]"
      >
        {state.error}
      </p>
    );
  if (!state.data)
    return (
      <p role="status" className="px-3 py-2 text-[11px] text-muted-foreground">
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
            className="w-full min-w-0 px-3 py-2 text-left text-xs hover:bg-white/5 focus-visible:outline-ring aria-pressed:bg-white/7"
          >
            <span className="block truncate">{entry.name}</span>
            <span className="mt-1 block truncate text-[10px] text-muted-foreground">
              {entry.path}
            </span>
          </button>
        </li>
      ))}
      {state.data.matches.length === 0 && (
        <li className="px-3 py-2 text-[11px] text-muted-foreground">
          {state.data.truncated
            ? 'No matches in scanned files'
            : 'No matching files'}
        </li>
      )}
      {state.data.truncated && (
        <li
          title={state.data.detail ?? undefined}
          className="px-3 py-2 text-[11px] leading-5 text-muted-foreground"
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
      <pre className="h-full overflow-auto p-3 text-xs leading-6">
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
      theme: 'github-dark',
      themeType: 'dark',
      preferredHighlighter: 'shiki-js',
      disableFileHeader: true,
      overflow: wrap ? 'wrap' : 'scroll',
      tokenizeMaxLength: 100000,
      tokenizeMaxLineLength: 1000,
      unsafeCSS:
        ':host{--diffs-font-size:12px;--diffs-line-height:22px;--diffs-bg:#090909;--diffs-fg:#d4d4d4} [data-diffs]{background:#090909} [data-code]{font-family:Consolas,monospace}',
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
      className="flex h-full min-h-0 min-w-0 flex-col"
    >
      <header className="shrink-0 border-b px-3 py-2 text-[11px] text-muted-foreground [overflow-wrap:anywhere]">
        {path}
      </header>
      <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
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
      </div>
    </section>
  );
}

export default function WorkspaceFiles({
  session,
  api,
  savedVersion,
  onSavedDiff,
  onClose,
}: Props) {
  const [query, setQuery] = useState('');
  const [path, setPath] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [wrap, setWrap] = useState(false);
  const closeButton = useRef<HTMLButtonElement>(null);
  const close = useEffectEvent(onClose);
  const select = useCallback((value: string) => setPath(value), []);
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
  return (
    <section
      aria-label="Workspace files"
      data-session-id={session.id}
      className="absolute inset-0 z-10 flex min-h-0 min-w-0 flex-col border-l bg-code-background min-[1200px]:relative min-[1200px]:inset-auto min-[1200px]:w-[56%] min-[1200px]:max-w-[1000px] min-[1200px]:shrink-0"
    >
      <header className="flex shrink-0 items-center gap-2 border-b px-3 py-2.5">
        <FolderOpen className="size-4 shrink-0 text-muted-foreground" />
        <h2 className="text-xs font-medium">Files</h2>
        {savedVersion !== undefined && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label={`Open saved result version ${savedVersion}`}
            onClick={onSavedDiff}
            className="h-7 px-2 text-[11px] text-muted-foreground"
          >
            Result v{savedVersion}
          </Button>
        )}
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="ml-auto size-7"
          aria-label="Refresh files"
          title="Refresh files and preview"
          onClick={() => setRefresh(value => value + 1)}
        >
          <RefreshCw className="size-3.5" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7"
          aria-label="Wrap file lines"
          aria-pressed={wrap}
          onClick={() => setWrap(value => !value)}
        >
          <WrapText className="size-3.5" />
        </Button>
        <Button
          ref={closeButton}
          type="button"
          variant="ghost"
          size="icon"
          className="size-7"
          aria-label="Close files"
          onClick={onClose}
        >
          <X className="size-4" />
        </Button>
      </header>
      <div className="flex shrink-0 items-center justify-between gap-3 border-b px-3 py-2 text-[11px] text-muted-foreground">
        <span className="truncate" title={session.directory}>
          {name}
        </span>
        <span className="shrink-0">Current workspace</span>
      </div>
      <div className="flex min-h-0 min-w-0 flex-1">
        <nav
          aria-label="Workspace folders"
          className="flex min-h-0 w-[34%] min-w-[150px] max-w-[230px] shrink-0 flex-col border-r"
        >
          <div className="relative m-2 shrink-0">
            <Search className="pointer-events-none absolute top-2 left-2 size-3.5 text-muted-foreground" />
            <Input
              type="search"
              aria-label="Search files"
              placeholder="Search files"
              maxLength={100}
              value={query}
              onChange={event => setQuery(event.target.value)}
              className="h-8 border-transparent bg-transparent pl-7 text-xs shadow-none"
            />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
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
                key={refresh}
                sessionId={session.id}
                path=""
                api={api}
                onSelect={select}
                selectedPath={path}
              />
            )}
          </div>
          <p
            className="shrink-0 border-t px-3 py-2 text-[10px] leading-4 text-muted-foreground"
            title="Generated and private entries are excluded. Symbolic links are not followed."
          >
            Generated/private files hidden
          </p>
        </nav>
        <div className="min-h-0 min-w-0 flex-1">
          {path ? (
            <FilePreview
              key={`${path}:${refresh}`}
              path={path}
              sessionId={session.id}
              api={api}
              wrap={wrap}
            />
          ) : (
            <div className="flex h-full items-center justify-center p-6 text-center text-xs text-muted-foreground">
              Select a file to preview
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
