import { useMemo, useState } from 'react';
import { parsePatchFiles, type FileDiffMetadata } from '@pierre/diffs';
import { DiffStat } from '@/entities/file-change';
import { DiffFileView } from '@/features/diff-viewer/diff-file-view';
import { WrapToggle } from '@/features/diff-viewer/diff-view-toggles';
import { useDiffWrap } from '@/features/diff-viewer/use-diff-wrap';
import { ListRow } from '@/shared/ui/list-row';

const patchFiles = (patch: string) => {
  try {
    return parsePatchFiles(patch).flatMap(item => item.files);
  } catch {
    return [];
  }
};

const counts = (file: FileDiffMetadata) =>
  file.hunks.reduce(
    (total, hunk) => ({
      additions: total.additions + hunk.additionLines,
      deletions: total.deletions + hunk.deletionLines,
    }),
    { additions: 0, deletions: 0 },
  );

const ignoreSelection = () => undefined;

export function WorkerDiff({
  patch,
  truncated,
}: {
  patch: string;
  truncated: boolean;
}) {
  const [path, setPath] = useState('');
  const [wrap] = useDiffWrap();
  const files = useMemo(
    () => patchFiles(patch).map(file => ({ file, ...counts(file) })),
    [patch],
  );
  const selected =
    files.find(item => item.file.name === path)?.file ?? files[0]?.file;
  const totals = files.reduce(
    (sum, file) => ({
      additions: sum.additions + file.additions,
      deletions: sum.deletions + file.deletions,
    }),
    { additions: 0, deletions: 0 },
  );
  return (
    <section aria-label="Worker diff" className="min-w-0">
      <div className="flex items-center gap-2 border-y border-border/40 px-2 py-1 text-xs text-muted-foreground">
        <span>
          {files.length} {files.length === 1 ? 'file' : 'files'}{' '}
          {truncated ? 'shown' : 'changed'}
        </span>
        <DiffStat {...totals} />
        <div className="ml-auto">
          <WrapToggle />
        </div>
      </div>
      {!!files.length && (
        <nav
          aria-label="Changed files"
          className="max-h-32 divide-y divide-border/40 overflow-auto"
        >
          {files.map(({ file, additions, deletions }) => (
            <ListRow
              key={file.name}
              title={file.name}
              selected={selected === file}
              className="rounded-none data-selected:bg-transparent data-selected:text-info-foreground"
              trailing={
                <DiffStat additions={additions} deletions={deletions} />
              }
              mainProps={{
                'aria-label': `View changes in ${file.name}`,
                'aria-pressed': selected === file,
              }}
              onClick={() => setPath(file.name)}
            />
          ))}
        </nav>
      )}
      {selected && selected.unifiedLineCount > 0 ? (
        <div
          data-worker-diff-lines
          className="max-h-[40vh] min-h-16 overflow-auto bg-code-background"
        >
          <DiffFileView
            key={selected.name}
            diff={selected}
            patch={patch}
            wrap={wrap}
            commentable={false}
            selectable
            draft={null}
            onDraftRange={ignoreSelection}
            renderDraft={ignoreSelection}
          />
        </div>
      ) : (
        <p className="px-2 py-4 text-xs text-muted-foreground">
          {selected
            ? 'No text lines changed.'
            : patch
              ? 'The diff could not be displayed.'
              : 'No committed changes.'}
        </p>
      )}
    </section>
  );
}
