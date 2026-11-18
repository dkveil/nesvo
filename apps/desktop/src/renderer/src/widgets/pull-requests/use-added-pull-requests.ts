import { useState } from 'react';
import type { PullRequestSummary } from '@nesvo/contracts';
import {
  sameReference,
  type PullRequestApi,
  type PullRequestTarget,
} from '@/entities/pull-request';
import { errorDetail } from '@/entities/session';
import { parseReferenceBatch, type ReferenceFailure } from './reference-batch';

export type AddedPullRequest = {
  hostId: string;
  pullRequest: PullRequestSummary;
};

type AddResult = {
  opened: PullRequestTarget | null;
  failures: ReferenceFailure[];
};

type UseAddedPullRequestsResult = {
  added: AddedPullRequest[];
  failures: ReferenceFailure[];
  pending: number;
  add: (
    api: PullRequestApi,
    hostId: string,
    inputs: string[],
    repository: string | null,
  ) => Promise<AddResult>;
  dismissFailures: () => void;
  clear: () => void;
};

const isSameEntry = (left: AddedPullRequest, right: AddedPullRequest) =>
  left.hostId === right.hostId &&
  sameReference(left.pullRequest, right.pullRequest);

export const useAddedPullRequests = (): UseAddedPullRequestsResult => {
  const [added, setAdded] = useState<AddedPullRequest[]>([]);
  const [failures, setFailures] = useState<ReferenceFailure[]>([]);
  const [pending, setPending] = useState(0);
  const add = async (
    api: PullRequestApi,
    hostId: string,
    inputs: string[],
    repository: string | null,
  ): Promise<AddResult> => {
    const batch = parseReferenceBatch(inputs, repository);
    setFailures(batch.failures);
    setPending(batch.references.length);
    const settled = await Promise.allSettled(
      batch.references.map(item => api.readPullRequest(item.reference)),
    );
    setPending(0);
    const loaded = settled.flatMap(result =>
      result.status === 'fulfilled'
        ? [{ hostId, pullRequest: result.value }]
        : [],
    );
    const readFailures = settled.flatMap((result, index) =>
      result.status === 'rejected'
        ? [
            {
              input: batch.references[index]?.input ?? '',
              reason: errorDetail(result.reason),
            },
          ]
        : [],
    );
    const allFailures = [...batch.failures, ...readFailures];
    setFailures(allFailures);
    setAdded(previous => [
      ...loaded,
      ...previous.filter(
        entry => !loaded.some(item => isSameEntry(item, entry)),
      ),
    ]);
    const first = loaded[0];
    return {
      opened: first
        ? {
            hostId,
            reference: {
              repository: first.pullRequest.repository,
              number: first.pullRequest.number,
            },
          }
        : null,
      failures: allFailures,
    };
  };
  return {
    added,
    failures,
    pending,
    add,
    dismissFailures: () => setFailures([]),
    clear: () => setAdded([]),
  };
};
