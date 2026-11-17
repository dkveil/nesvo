import { useState } from 'react';
import type { PullRequest } from '@nesvo/contracts';
import { ChevronDown } from 'lucide-react';
import {
  mergeMethodLabels,
  mergeMethodVerbs,
  shortSha,
  type MergeMethod,
} from '@/entities/pull-request';
import { Button } from '@/shared/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/shared/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/shared/ui/dropdown-menu';
import { ActionFeedback } from './action-feedback';
import { DisabledHint } from './disabled-hint';
import type { ActionState } from './use-pull-request-actions';

const METHOD_ORDER: MergeMethod[] = ['squash', 'merge', 'rebase'];

type MergeControlProps = {
  pullRequest: PullRequest;
  blockedReason: string;
  state: ActionState | undefined;
  onMerge: (method: MergeMethod, deleteBranch: boolean) => Promise<boolean>;
};

function mergeBlockedReason(pullRequest: PullRequest, blockedReason: string) {
  if (blockedReason) return blockedReason;
  if (pullRequest.state === 'merged')
    return 'This pull request is already merged.';
  if (pullRequest.state === 'closed') return 'This pull request is closed.';
  if (pullRequest.isDraft) return 'Mark the draft ready for review first.';
  if (!pullRequest.viewerCanMerge)
    return 'Your GitHub account cannot merge this pull request.';
  if (pullRequest.mergeable === 'conflicting')
    return 'Resolve the merge conflicts first.';
  if (pullRequest.allowedMergeMethods.length === 0)
    return 'This repository does not allow merging from here.';
  return '';
}

export function MergeControl({
  pullRequest,
  blockedReason,
  state,
  onMerge,
}: MergeControlProps) {
  const methods = METHOD_ORDER.filter(method =>
    pullRequest.allowedMergeMethods.includes(method),
  );
  const [chosen, setChosen] = useState<MergeMethod | null>(null);
  const method = chosen && methods.includes(chosen) ? chosen : methods[0];
  const [confirming, setConfirming] = useState(false);
  const [deleteBranch, setDeleteBranch] = useState(false);
  const reason = mergeBlockedReason(pullRequest, blockedReason);
  const pending = state?.status === 'pending';
  const disabled = !!reason || !method || pending;
  if (pullRequest.state !== 'open') return null;
  const confirm = async () => {
    if (!method) return;
    if (await onMerge(method, deleteBranch)) setConfirming(false);
  };
  return (
    <>
      <DisabledHint reason={reason}>
        <span className="inline-flex items-stretch">
          <Button
            type="button"
            size="xs"
            disabled={disabled}
            onClick={() => setConfirming(true)}
            className="h-7 rounded-r-none px-2.5 text-xs disabled:cursor-not-allowed"
          >
            {pending ? 'Merging…' : mergeMethodLabels[method ?? 'squash']}
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                size="xs"
                disabled={disabled || methods.length < 2}
                aria-label="Choose merge method"
                className="h-7 rounded-l-none border-l border-primary-foreground/20 px-1.5 disabled:cursor-not-allowed"
              >
                <ChevronDown className="size-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-48">
              {methods.map(item => (
                <DropdownMenuItem
                  key={item}
                  aria-checked={item === method}
                  className="text-xs aria-checked:font-medium"
                  onSelect={() => setChosen(item)}
                >
                  {mergeMethodLabels[item]}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </span>
      </DisabledHint>
      <Dialog
        open={confirming}
        onOpenChange={open => {
          if (!pending) setConfirming(open);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-base">
              Merge #{pullRequest.number}?
            </DialogTitle>
            <DialogDescription className="text-xs leading-5">
              Merges commit{' '}
              <code className="rounded-sm bg-accent px-1 font-mono">
                {shortSha(pullRequest.headSha)}
              </code>{' '}
              of <span className="font-mono">{pullRequest.headRefName}</span>{' '}
              into <span className="font-mono">{pullRequest.baseRefName}</span>{' '}
              using {method ? mergeMethodVerbs[method] : 'squash'}. If the
              branch gains new commits first, the merge is refused.
            </DialogDescription>
          </DialogHeader>
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={deleteBranch}
              disabled={pending}
              onChange={event => setDeleteBranch(event.target.checked)}
              className="size-3.5 accent-foreground"
            />
            Delete the head branch after merging
          </label>
          {state?.status === 'error' && <ActionFeedback state={state} />}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={pending}
              onClick={() => setConfirming(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={pending || !method}
              onClick={() => void confirm()}
            >
              {pending ? 'Merging…' : mergeMethodLabels[method ?? 'squash']}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
