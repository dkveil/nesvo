import { useMemo } from 'react';
import { parsePatchFiles } from '@pierre/diffs';
import { FileDiff, Folder } from 'lucide-react';
import { DiffStat } from '@/entities/file-change';
import type { Review } from '@/entities/review';
import { Button } from '@/shared/ui/button';
import { NativeDisclosure } from '@/shared/ui/disclosure';
import { FileTypeIcon } from '@/shared/ui/file-type-icon';
import { ListRow } from '@/shared/ui/list-row';

type Counts = { additions: number; deletions: number };
type Change = Counts & { path: string; name: string };
type FolderNode = Counts & {
  folders: Map<string, FolderNode>;
  files: Change[];
};

const folder = (): FolderNode => ({
  folders: new Map(),
  files: [],
  additions: 0,
  deletions: 0,
});

function changesTree(review: Review) {
  const counts = new Map<string, Counts>();
  try {
    const patches = parsePatchFiles(review.diff.patch, {
      cacheKeyPrefix: review.id,
      throwOnError: true,
    });
    for (const patch of patches)
      for (const file of patch.files)
        counts.set(
          file.name,
          file.hunks.reduce(
            (total, hunk) => ({
              additions: total.additions + hunk.additionLines,
              deletions: total.deletions + hunk.deletionLines,
            }),
            { additions: 0, deletions: 0 },
          ),
        );
  } catch {
    return null;
  }
  const root = folder();
  for (const { path } of review.diff.files) {
    const lines = counts.get(path) ?? { additions: 0, deletions: 0 };
    const segments = path.split('/');
    const name = segments.pop() ?? path;
    let node = root;
    for (const segment of segments) {
      node.additions += lines.additions;
      node.deletions += lines.deletions;
      const child = node.folders.get(segment) ?? folder();
      node.folders.set(segment, child);
      node = child;
    }
    node.additions += lines.additions;
    node.deletions += lines.deletions;
    node.files.push({ path, name, ...lines });
  }
  return root;
}

function TreeRows({
  node,
  onOpen,
}: {
  node: FolderNode;
  onOpen: (path: string) => void;
}) {
  return (
    <>
      {[...node.folders].map(([name, child]) => (
        <NativeDisclosure
          key={name}
          title={name}
          icon={<Folder />}
          meta={
            <DiffStat additions={child.additions} deletions={child.deletions} />
          }
          lazyContent
        >
          <TreeRows node={child} onOpen={onOpen} />
        </NativeDisclosure>
      ))}
      {node.files.map(file => (
        <ListRow
          key={file.path}
          size="sm"
          leading={<FileTypeIcon name={file.name} />}
          title={file.name}
          trailing={
            <DiffStat additions={file.additions} deletions={file.deletions} />
          }
          mainProps={{ title: file.path }}
          onClick={() => onOpen(file.path)}
        />
      ))}
    </>
  );
}

export function TurnChanges({
  review,
  onOpen,
}: {
  review: Review;
  onOpen: (id: string, path?: string) => void;
}) {
  const tree = useMemo(() => changesTree(review), [review]);
  const count = review.diff.files.length;
  return (
    <section aria-label="Turn changes" className="border-t border-border pt-1">
      <div className="flex min-h-7 flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-xs font-medium">
          <span>
            {count === 1 ? '1 changed file' : count + ' changed files'}
          </span>
          {tree && (
            <DiffStat additions={tree.additions} deletions={tree.deletions} />
          )}
        </div>
        <Button size="xs" variant="ghost" onClick={() => onOpen(review.id)}>
          <FileDiff />
          Open diff
        </Button>
      </div>
      {tree && (
        <TreeRows node={tree} onOpen={path => onOpen(review.id, path)} />
      )}
    </section>
  );
}
