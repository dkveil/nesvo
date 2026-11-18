import type { PullRequestReference } from '@nesvo/contracts';
import { parseReferenceInput, sameReference } from '@/entities/pull-request';

export const MAX_BATCH_REFERENCES = 20;

export type ReferenceFailure = { input: string; reason: string };

type ReferenceBatch = {
  references: { input: string; reference: PullRequestReference }[];
  failures: ReferenceFailure[];
};

export const splitReferenceInput = (text: string) =>
  text.split(/[\s,]+/).filter(Boolean);

export const parseReferenceBatch = (
  inputs: string[],
  repository: string | null,
): ReferenceBatch =>
  inputs.reduce<ReferenceBatch>(
    (batch, input) => {
      const reference = parseReferenceInput(input, repository);
      if (!reference)
        return {
          ...batch,
          failures: [
            ...batch.failures,
            {
              input,
              reason: repository
                ? 'Not a pull request link or number.'
                : 'Not a full pull request link. Choose a repository for numbers.',
            },
          ],
        };
      if (
        batch.references.some(item => sameReference(item.reference, reference))
      )
        return batch;
      return {
        ...batch,
        references: [...batch.references, { input, reference }],
      };
    },
    { references: [], failures: [] },
  );
