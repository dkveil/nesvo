import {
  mergedCleanupBranchMessages,
  type MergedWorktreeCleanup,
} from '@nesvo/contracts';
import { blockerSummary } from './blocker-summary';
import { InlineNotice } from '@/shared/ui/inline-notice';
import { KeyValueList } from '@/shared/ui/key-value-list';

const stateLabels: Record<
  MergedWorktreeCleanup['pullRequest']['state'],
  string
> = {
  open: 'Open',
  closed: 'Closed without merging',
  merged: 'Merged',
};

const plural = (count: number, word: string) =>
  `${count} ${word}${count === 1 ? '' : 's'}`;

export function CleanupReport({ cleanup }: { cleanup: MergedWorktreeCleanup }) {
  const { pullRequest, changes, unpushed } = cleanup;
  return (
    <div className="space-y-3" data-merged-cleanup={cleanup.sessionId}>
      <KeyValueList
        entries={[
          {
            key: 'pull-request',
            label: 'Pull request',
            value: `#${pullRequest.reference.number} · ${stateLabels[pullRequest.state]}`,
          },
          {
            key: 'changes',
            label: 'Uncommitted',
            value:
              changes.length > 0
                ? `${plural(changes.length, 'file')}${cleanup.changesTruncated ? ' or more' : ''}`
                : 'None',
          },
          {
            key: 'unpushed',
            label: 'Unpushed',
            value:
              unpushed.length > 0
                ? `${plural(unpushed.length, 'commit')}${cleanup.unpushedTruncated ? ' or more' : ''}`
                : 'None',
          },
          {
            key: 'branch',
            label: 'Branch',
            value: `${cleanup.worktree.branch} · ${mergedCleanupBranchMessages[cleanup.branch]}`,
          },
          ...(cleanup.localFiles > 0
            ? [
                {
                  key: 'local',
                  label: 'Ignored files',
                  value: `${plural(cleanup.localFiles, 'ignored entry')} such as copied local settings are removed with the worktree.`,
                },
              ]
            : []),
        ]}
      />
      {cleanup.blockers.length > 0 && (
        <InlineNotice tone="warning">
          {`${blockerSummary(cleanup)} Nothing is removed or deleted.`}
        </InlineNotice>
      )}
      {changes.length > 0 && (
        <ul
          aria-label="Uncommitted files"
          className="max-h-32 overflow-y-auto rounded-surface border px-2.5 py-1.5 font-mono text-2xs leading-4 text-muted-foreground"
        >
          {changes.map(path => (
            <li key={path} className="truncate">
              {path}
            </li>
          ))}
        </ul>
      )}
      {unpushed.length > 0 && (
        <ul
          aria-label="Unpushed commits"
          className="max-h-32 overflow-y-auto rounded-surface border px-2.5 py-1.5 text-2xs leading-4 text-muted-foreground"
        >
          {unpushed.map(commit => (
            <li key={commit.sha} className="truncate">
              <span className="font-mono">{commit.sha.slice(0, 7)}</span>{' '}
              {commit.subject}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
