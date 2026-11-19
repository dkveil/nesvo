import type {
  Review,
  ReviewDiff,
  Session,
  TurnQuestion,
} from '@nesvo/contracts';

export function reviewReason(
  session: Session,
  diff: ReviewDiff,
  reviewEveryResult: boolean,
): Review['reason'] {
  if (diff.files.some(file => file.path !== '.') || diff.patch) return 'files';
  if (session.role === 'worker') return 'worker';
  if (session.workflowRunId || session.workflowStepId) return 'workflow';
  if (session.reviewEveryResult || reviewEveryResult) return 'policy';
  return undefined;
}

const directRequest =
  /^(?:(?:(?:please|could you|can you) )?(?:choose|pick|select|reply|answer|tell me|let me know|confirm|specify)\b|(?:prosz\u0119[,:]? )?(?:napisz|wybierz|wska\u017c|daj zna\u0107|odpowiedz|potwierd\u017a|powiedz|podaj|okre\u015bl)(?=\s|[,:?]|$))/iu;
const choiceQuestion =
  /^(?:(?:which|what)\b[^?\n]{0,170}\b(?:do you|would you|should I|shall I)\b|(?:would you (?:like|prefer)|do you (?:prefer|want)|should I|shall I)\b|(?:kt\u00f3r[\u0105ye]|jak[\u0105ie]|czy)\s[^?\n]{0,170}\b(?:wolisz|wybierasz|chcesz|mam|wybra\u0107)(?=\s|[?,.]|$))/iu;
const optionalOffer =
  /^(?:please )?let me know if\b|^daj zna\u0107[ ,]+je\u015bli\b/iu;

export function closingQuestion(body: string): TurnQuestion | undefined {
  const tail = body.slice(-4096).replaceAll('\r\n', '\n').trimEnd();
  const boundary = tail.lastIndexOf('\n\n');
  if (body.length > 4096 && boundary === -1) return;
  const paragraph = tail.slice(boundary < 0 ? 0 : boundary + 2).trim();
  if (!paragraph || paragraph.length > 1000 || /^[>`#*-]/.test(paragraph))
    return;
  if (/^\s*(?:```|~~~)/m.test(paragraph)) return;
  if (optionalOffer.test(paragraph)) return;
  if (
    !directRequest.test(paragraph) &&
    !(paragraph.endsWith('?') && choiceQuestion.test(paragraph))
  )
    return;
  return [{ text: paragraph, options: [] }];
}
