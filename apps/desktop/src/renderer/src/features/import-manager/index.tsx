import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight, Folder, RefreshCw } from 'lucide-react';
import {
  managerImportSelectionLimit,
  managerImportSources,
  type Computer,
  type DesktopApi,
  type ManagerImportCatalog,
  type ManagerImportResult,
  type ManagerImportRow,
  type ManagerImportSource,
} from '@nesvo/contracts';
import { errorDetail } from '@/entities/session';
import { Button } from '@/shared/ui/button';
import { Checkbox } from '@/shared/ui/checkbox';
import { Field } from '@/shared/ui/field';
import { IconButton } from '@/shared/ui/icon-button';
import { Input } from '@/shared/ui/input';
import { ListRow } from '@/shared/ui/list-row';
import { SectionLabel } from '@/shared/ui/section-label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/shared/ui/select';
import { StatusMessage } from '@/shared/ui/status-message';
import { managerImportSummary, managerLabels } from './summary';

export type DetectedImports = Partial<
  Record<ManagerImportSource, ManagerImportCatalog>
>;

type Api = Pick<DesktopApi, 'listManagerImport' | 'adoptManagerImport'>;
type Props = {
  api: Api;
  computer: Computer | undefined;
  detected?: DetectedImports;
  initialSource?: ManagerImportSource;
  onBusyChange?: (busy: boolean) => void;
  onImported?: () => void;
  onSourceChange?: (source: ManagerImportSource) => void;
};

const available = (row: ManagerImportRow) =>
  row.kind === 'group' || row.disposition !== 'blocked';

const fallbackNote = 'Worktree removed, resumes in the project folder.';

function Result({
  result,
  rows,
}: {
  result: ManagerImportResult;
  rows: ManagerImportRow[];
}) {
  const created = result.outcomes.filter(
    row => row.status === 'created',
  ).length;
  const existing = result.outcomes.filter(
    row => row.status === 'existing',
  ).length;
  const skipped = result.outcomes.filter(row => row.status === 'skipped');
  return (
    <div className="space-y-2">
      <StatusMessage tone={skipped.length ? 'warning' : 'success'}>
        {created} imported · {existing} already in Nesvo · {skipped.length}{' '}
        skipped
      </StatusMessage>
      {skipped.map(outcome => (
        <ListRow
          key={outcome.key}
          density="two-line"
          title={
            rows.find(row => row.key === outcome.key)?.title ??
            'Unavailable item'
          }
          description={outcome.reason ?? 'This item could not be imported.'}
        />
      ))}
    </div>
  );
}

export function ManagerImportPicker({
  api,
  computer,
  detected,
  initialSource,
  onBusyChange,
  onImported,
  onSourceChange,
}: Props) {
  const sourceId = useId();
  const rootId = useId();
  const sources = detected
    ? managerImportSources.filter(source => detected[source])
    : managerImportSources;
  const [source, setSource] = useState(
    initialSource ?? sources[0] ?? 't3-code',
  );
  const [root, setRoot] = useState<string>();
  const [customRoot, setCustomRoot] = useState(false);
  const [path, setPath] = useState('');
  const [busy, setBusy] = useState(false);
  const active = sources.includes(source) ? source : (sources[0] ?? 't3-code');
  if (!computer || computer.status !== 'connected')
    return (
      <StatusMessage tone="warning">
        Connect this computer to check its import sources.
      </StatusMessage>
    );
  if (!computer.capabilities.includes('manager-import'))
    return (
      <StatusMessage tone="warning">
        Update this computer’s Nesvo host and reconnect to import from other
        apps.
      </StatusMessage>
    );
  return (
    <div className="space-y-4">
      {sources.length > 1 && (
        <Field id={sourceId} label="Source" layout="inline">
          <Select
            value={active}
            disabled={busy}
            onValueChange={value => {
              setSource(value as ManagerImportSource);
              onSourceChange?.(value as ManagerImportSource);
              setRoot(undefined);
              setPath('');
              setCustomRoot(false);
            }}
          >
            <SelectTrigger id={sourceId} className="w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {sources.map(value => (
                <SelectItem key={value} value={value}>
                  {managerLabels[value]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      )}
      {!detected &&
        (customRoot ? (
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={event => {
              event.preventDefault();
              setRoot(path.trim() || undefined);
            }}
          >
            <Field
              id={rootId}
              label="Data directory on this computer"
              className="min-w-48 flex-1"
            >
              <Input
                id={rootId}
                value={path}
                maxLength={4096}
                disabled={busy}
                onChange={event => setPath(event.currentTarget.value)}
              />
            </Field>
            <Button
              type="submit"
              variant="secondary"
              size="sm"
              disabled={busy || !path.trim()}
            >
              Check directory
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => {
                setRoot(undefined);
                setPath('');
                setCustomRoot(false);
              }}
            >
              Use default
            </Button>
          </form>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => setCustomRoot(true)}
          >
            <Folder /> Use a custom directory
          </Button>
        ))}
      <ImportRows
        key={JSON.stringify([computer.id, computer.instanceId, active, root])}
        api={api}
        hostId={computer.id}
        source={active}
        root={root}
        initial={root ? undefined : detected?.[active]}
        onboarding={!!detected}
        showSourceLabel={!detected && sources.length === 1}
        onRoot={setRoot}
        onImported={onImported}
        onBusy={value => {
          setBusy(value);
          onBusyChange?.(value);
        }}
      />
    </div>
  );
}

function ImportRows({
  api,
  hostId,
  source,
  root,
  initial,
  onboarding,
  showSourceLabel,
  onRoot,
  onBusy,
  onImported,
}: {
  api: Api;
  hostId: string;
  source: ManagerImportSource;
  root?: string;
  initial?: ManagerImportCatalog;
  onboarding: boolean;
  showSourceLabel: boolean;
  onRoot: (value: string) => void;
  onBusy: (busy: boolean) => void;
  onImported?: () => void;
}) {
  const [catalog, setCatalog] = useState(initial);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [result, setResult] = useState<ManagerImportResult>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(!initial);
  const [appending, setAppending] = useState(false);
  const [importing, setImporting] = useState(false);
  const pending = useRef(false);
  const rowPrefix = useId();

  useEffect(() => {
    if (initial) return;
    let active = true;
    void api.listManagerImport({ source, root, offset: 0 }, hostId).then(
      value => {
        if (active) {
          setCatalog(value);
          setLoading(false);
        }
      },
      failure => {
        if (active) {
          setError(errorDetail(failure));
          setLoading(false);
        }
      },
    );
    return () => {
      active = false;
    };
  }, [api, hostId, initial, root, source]);

  const rows = catalog?.rows ?? [];
  const tree = new Map<string | null, ManagerImportRow[]>();
  for (const row of rows) {
    const siblings = tree.get(row.parent) ?? [];
    siblings.push(row);
    tree.set(row.parent, siblings);
  }

  const subtree = (row: ManagerImportRow): ManagerImportRow[] =>
    [row, ...(tree.get(row.key) ?? []).flatMap(subtree)].filter(
      item =>
        available(item) && (item.kind === 'group' || !item.workspaceFallback),
    );

  const toggle = (items: ManagerImportRow[], checked: boolean) => {
    const next = new Set(selected);
    for (const item of items) {
      if (checked) next.add(item.key);
      else next.delete(item.key);
    }
    if (next.size > managerImportSelectionLimit) {
      setError(`Choose up to ${managerImportSelectionLimit} items at a time.`);
      return;
    }
    setSelected(next);
    setError('');
  };

  const read = async (offset = 0) => {
    if (pending.current) return;
    pending.current = true;
    setError('');
    if (offset) setAppending(true);
    else {
      setLoading(true);
      setSelected(new Set());
      setResult(undefined);
    }
    try {
      const value = await api.listManagerImport(
        {
          source,
          root,
          offset,
          scanId: offset ? (catalog?.scanId ?? undefined) : undefined,
        },
        hostId,
      );
      if (offset && value.status === 'retry') {
        setError(
          value.message ?? 'Refresh the source before loading more items.',
        );
      } else {
        setCatalog(
          offset ? { ...value, rows: [...rows, ...value.rows] } : value,
        );
      }
    } catch (failure) {
      setError(errorDetail(failure));
    } finally {
      pending.current = false;
      setLoading(false);
      setAppending(false);
    }
  };

  const adopt = async () => {
    if (pending.current || !selected.size) return;
    pending.current = true;
    setImporting(true);
    setError('');
    onBusy(true);
    try {
      const response = await api.adoptManagerImport(
        {
          source,
          root,
          requestId: crypto.randomUUID(),
          selected: rows
            .filter(row => selected.has(row.key))
            .map(row => ({
              key: row.key,
              revision: row.revision,
              ...(row.kind === 'session' && row.workspaceFallback
                ? { useProjectFolder: true as const }
                : {}),
            })),
        },
        hostId,
      );
      const adopted = new Set(
        response.outcomes
          .filter(outcome => outcome.status !== 'skipped')
          .map(outcome => outcome.key),
      );
      if (catalog)
        setCatalog({
          ...catalog,
          rows: rows.map(row =>
            row.kind === 'session' && adopted.has(row.key)
              ? {
                  ...row,
                  disposition: 'existing',
                  reason: null,
                  workspaceFallback: undefined,
                }
              : row,
          ),
        });
      setResult(response);
      setSelected(new Set());
      onImported?.();
    } catch (failure) {
      setError(errorDetail(failure));
    } finally {
      pending.current = false;
      setImporting(false);
      onBusy(false);
    }
  };

  const renderRows = (parent: string | null, level = 0): ReactNode[] =>
    (tree.get(parent) ?? []).map(row => {
      const isGroup = row.kind === 'group';
      const items = isGroup ? subtree(row) : [row];
      const checked = items.filter(item => selected.has(item.key)).length;
      const open = expanded.has(row.key);
      const children = tree.get(row.key);
      const reasonId = `${rowPrefix}-${row.key}`;
      const fallback = row.kind === 'session' && row.workspaceFallback;
      const reason =
        row.kind === 'session'
          ? (row.reason ?? (fallback ? fallbackNote : null))
          : null;
      const details = [
        row.profile,
        row.kind === 'session' ? row.provider : null,
        row.archivedAt ? 'Archived' : null,
        row.kind === 'session' && row.disposition === 'existing'
          ? 'Already in Nesvo'
          : null,
      ]
        .filter(Boolean)
        .join(' · ');
      return (
        <div key={row.key}>
          <ListRow
            density="two-line"
            level={level}
            title={row.title}
            description={reason ? <span id={reasonId}>{reason}</span> : details}
            meta={isGroup && children ? String(children.length) : undefined}
            leading={
              <Checkbox
                aria-label={`Select ${row.title}${row.profile ? ` in ${row.profile}` : ''}${fallback ? ' and resume in the project folder' : ''}`}
                aria-describedby={reason ? reasonId : undefined}
                checked={
                  checked === items.length
                    ? true
                    : checked > 0
                      ? 'indeterminate'
                      : false
                }
                disabled={
                  !available(row) ||
                  importing ||
                  appending ||
                  (isGroup && catalog?.nextOffset !== null)
                }
                onCheckedChange={value => toggle(items, value === true)}
              />
            }
            trailing={
              isGroup && children?.length ? (
                <IconButton
                  label={`${open ? 'Collapse' : 'Expand'} ${row.title}`}
                  aria-expanded={open}
                  onClick={() =>
                    setExpanded(previous => {
                      const next = new Set(previous);
                      if (open) next.delete(row.key);
                      else next.add(row.key);
                      return next;
                    })
                  }
                >
                  {open ? <ChevronDown /> : <ChevronRight />}
                </IconButton>
              ) : undefined
            }
          />
          {open && renderRows(row.key, level + 1)}
        </div>
      );
    });

  const hasItems = !!catalog?.rows.length;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="space-y-1">
          {showSourceLabel && (
            <SectionLabel as="h2" className="px-0">
              {managerLabels[source]}
            </SectionLabel>
          )}
          {hasItems && !onboarding && (
            <p className="text-ui text-muted-foreground">
              {managerImportSummary(source, catalog)}
            </p>
          )}
        </div>
        <IconButton
          label="Refresh import sources"
          disabled={loading || importing || appending}
          onClick={() => void read()}
        >
          <RefreshCw />
        </IconButton>
      </div>
      {loading && (
        <StatusMessage tone="loading">
          Checking this computer for {managerLabels[source]} sessions…
        </StatusMessage>
      )}
      {error && <StatusMessage tone="error">{error}</StatusMessage>}
      {!loading && catalog?.message && (
        <StatusMessage
          tone={
            catalog.status === 'partial' || catalog.status === 'retry'
              ? 'warning'
              : 'info'
          }
        >
          {catalog.message}
        </StatusMessage>
      )}
      {!loading && catalog?.roots.length ? (
        <div className="space-y-1">
          {catalog.roots.map(path => (
            <ListRow
              key={path}
              density="two-line"
              title={path}
              description="Choose this data directory"
              onClick={() => onRoot(path)}
            />
          ))}
        </div>
      ) : null}
      {!loading && catalog && !hasItems && catalog.status === 'ready' && (
        <StatusMessage>
          No projects or sessions are available in this store.
        </StatusMessage>
      )}
      {result && <Result result={result} rows={rows} />}
      {hasItems && !loading && (
        <>
          <div className="border-y" aria-label="Import selection">
            {renderRows(null)}
          </div>
          {catalog.nextOffset !== null && (
            <div className="space-y-2">
              <StatusMessage>
                Load all items to select an entire project or group.
              </StatusMessage>
              <Button
                variant="secondary"
                size="sm"
                disabled={appending || importing}
                onClick={() => void read(catalog.nextOffset ?? 0)}
              >
                {appending ? 'Loading more…' : 'Load more'}
              </Button>
            </div>
          )}
          <StatusMessage>
            Imported sessions start read-only. Close the original conversation
            before resuming it here to avoid conflicting changes.
          </StatusMessage>
          <div className="flex items-center justify-between gap-2">
            <StatusMessage icon={false}>{selected.size} selected</StatusMessage>
            <Button
              size="md"
              disabled={importing || appending || !selected.size}
              onClick={() => void adopt()}
            >
              {importing ? 'Importing…' : 'Import selected'}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
