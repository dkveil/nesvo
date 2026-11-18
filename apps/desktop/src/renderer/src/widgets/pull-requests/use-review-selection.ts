import { useState } from 'react';
import { codeReviewLimits, type PullRequestReference } from '@nesvo/contracts';

const keyOf = (reference: PullRequestReference) =>
  `${reference.repository.toLowerCase()}#${reference.number}`;

export function useReviewSelection() {
  const [active, setActive] = useState(false);
  const [selected, setSelected] = useState<PullRequestReference[]>([]);
  const has = (reference: PullRequestReference) =>
    selected.some(item => keyOf(item) === keyOf(reference));
  const toggle = (reference: PullRequestReference) =>
    setSelected(previous =>
      previous.some(item => keyOf(item) === keyOf(reference))
        ? previous.filter(item => keyOf(item) !== keyOf(reference))
        : previous.length >= codeReviewLimits.bulkReviews
          ? previous
          : [
              ...previous,
              { repository: reference.repository, number: reference.number },
            ],
    );
  const stop = () => {
    setActive(false);
    setSelected([]);
  };
  return {
    active,
    selected,
    full: selected.length >= codeReviewLimits.bulkReviews,
    has,
    toggle,
    start: () => setActive(true),
    stop,
  };
}
