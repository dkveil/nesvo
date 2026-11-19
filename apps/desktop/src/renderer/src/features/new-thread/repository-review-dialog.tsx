import { useState } from 'react';
import type {
  McpServerList,
  ListMcpServersInput,
  RepositoryTrustReviewInput,
} from '@nesvo/contracts';
import { errorDetail } from '@/entities/session';
import { RepositoryDecision } from '@/features/session-mcp/mcp-repository-notice';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/shared/ui/dialog';

export function RepositoryReviewDialog({
  hostId,
  target,
  list,
  onOpenChange,
  onContinue,
}: {
  hostId: string;
  target: Extract<ListMcpServersInput, { directory: string }>;
  list: McpServerList;
  onOpenChange: (open: boolean) => void;
  onContinue: () => Promise<void>;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [current, setCurrent] = useState(list);
  const repository = current.repository!;
  const trust = async (
    rawReviewToken?: string,
    decision?: RepositoryTrustReviewInput,
  ) => {
    if (!decision || pending) return;
    setPending(true);
    setError('');
    try {
      await window.nesvo.trustRepositoryMcp(
        {
          ...target,
          decision,
          fingerprint: repository.fingerprint,
          rawReviewToken,
        },
        hostId,
      );
      await onContinue();
    } catch (reason) {
      setError(errorDetail(reason));
      const updated = await window.nesvo
        .listMcpServers(target, hostId)
        .catch(() => undefined);
      if (updated?.repository) setCurrent(updated);
    } finally {
      setPending(false);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={open => {
        if (!pending) onOpenChange(open);
      }}
    >
      <DialogContent className="sm:max-w-2xl" showCloseButton={!pending}>
        <DialogHeader>
          <DialogTitle>Review repository</DialogTitle>
          <DialogDescription>
            {repository.name} · {current.provider}
          </DialogDescription>
        </DialogHeader>
        <RepositoryDecision
          key={repository.fingerprint}
          draft
          repository={repository}
          configuration={{
            pending,
            error,
            list: current,
            dismiss: () => onOpenChange(false),
            trust,
            readRaw: async () => {
              const response = await window.nesvo.listMcpServers(
                { ...target, rawFor: repository.fingerprint },
                hostId,
              );
              if (
                response.repository?.fingerprint !== repository.fingerprint ||
                !response.repository.rawReview
              )
                throw new Error(
                  'Repository definitions changed. Review the current configuration.',
                );
              return response.repository.rawReview;
            },
          }}
        />
      </DialogContent>
    </Dialog>
  );
}
