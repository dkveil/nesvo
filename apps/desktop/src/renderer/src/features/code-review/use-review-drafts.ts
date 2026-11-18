import { useCallback, useEffect, useState } from 'react';
import type { DesktopApi, DesktopReviewDraft } from '@nesvo/contracts';
import { errorDetail } from '@/entities/session';

type ReviewDraftsState = {
  drafts: DesktopReviewDraft[];
  status: 'loading' | 'ready' | 'error';
  error: string;
};

type ReviewDraftsApi = Pick<DesktopApi, 'listPullRequestReviews' | 'subscribe'>;

const newestFirst = (drafts: DesktopReviewDraft[]) =>
  [...drafts].sort((first, second) =>
    second.createdAt.localeCompare(first.createdAt),
  );

const merge = (drafts: DesktopReviewDraft[], draft: DesktopReviewDraft) => {
  const current = drafts.find(
    item => item.id === draft.id && item.hostId === draft.hostId,
  );
  if (current && current.revision >= draft.revision) return drafts;
  return newestFirst([
    ...drafts.filter(
      item => !(item.id === draft.id && item.hostId === draft.hostId),
    ),
    draft,
  ]);
};

export function useReviewDrafts({
  api,
  hostId,
  repository,
  number,
  enabled,
}: {
  api: ReviewDraftsApi | null;
  hostId: string;
  repository?: string;
  number?: number;
  enabled: boolean;
}) {
  const [state, setState] = useState<ReviewDraftsState>({
    drafts: [],
    status: 'loading',
    error: '',
  });
  const [version, setVersion] = useState(0);
  const upsert = useCallback(
    (draft: DesktopReviewDraft) =>
      setState(previous => ({
        ...previous,
        drafts: merge(previous.drafts, draft),
      })),
    [],
  );
  useEffect(() => {
    if (!enabled || !api) return;
    let active = true;
    api
      .listPullRequestReviews(
        repository && number ? { reference: { repository, number } } : {},
      )
      .then(
        drafts => {
          if (active)
            setState({
              drafts: newestFirst(drafts),
              status: 'ready',
              error: '',
            });
        },
        (failure: unknown) => {
          if (active)
            setState(previous => ({
              ...previous,
              status: 'error',
              error: errorDetail(failure),
            }));
        },
      );
    return () => {
      active = false;
    };
  }, [api, repository, number, enabled, version]);
  useEffect(() => {
    if (!enabled || !api) return;
    return api.subscribe(event => {
      if (event.type !== 'pull-request-review-changed') return;
      const { draft } = event;
      if (draft.hostId !== hostId) return;
      if (
        repository &&
        (draft.reference.repository.toLowerCase() !==
          repository.toLowerCase() ||
          draft.reference.number !== number)
      )
        return;
      upsert(draft);
    });
  }, [api, hostId, repository, number, enabled, upsert]);
  const reload = useCallback(() => setVersion(value => value + 1), []);
  return { ...state, reload, upsert };
}
