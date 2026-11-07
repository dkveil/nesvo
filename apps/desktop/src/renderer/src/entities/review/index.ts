import type { Review } from '@nesvo/contracts';

export type { Review, DecideReviewInput } from '@nesvo/contracts';

export const reviewStatusLabels: Record<Review['status'], string> = {
  pending: 'Do odbioru',
  accepted: 'Zaakceptowano',
  'changes-requested': 'Odesłano do poprawy',
  superseded: 'Nieaktualna wersja',
};

export const fileKindLabels: Record<
  Review['diff']['files'][number]['kind'],
  string
> = {
  added: 'Dodany',
  modified: 'Zmieniony',
  deleted: 'Usunięty',
  binary: 'Binarny',
};

export function reviewDate(value: string) {
  return new Intl.DateTimeFormat('pl-PL', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}
