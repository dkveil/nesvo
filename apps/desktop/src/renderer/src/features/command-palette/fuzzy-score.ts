const WORD_BOUNDARY = /[\s/\\._:-]/;
const CONTIGUOUS_SCORE = 1000;
const WORD_START_BONUS = 200;
const SUBSEQUENCE_STEP_SCORE = 10;
const STREAK_BONUS = 5;
const MAX_GAP_PENALTY = 10;

export type ScoredField = { text: string; weight: number };

function tokenScore(token: string, text: string): number | null {
  const haystack = text.toLocaleLowerCase();
  const index = haystack.indexOf(token);
  if (index !== -1) {
    const wordStart = index === 0 || WORD_BOUNDARY.test(haystack[index - 1]!);
    return CONTIGUOUS_SCORE - index + (wordStart ? WORD_START_BONUS : 0);
  }
  let score = 0;
  let position = -1;
  let streak = 0;
  for (const character of token) {
    const next = haystack.indexOf(character, position + 1);
    if (next === -1) return null;
    streak = next === position + 1 ? streak + 1 : 0;
    score +=
      SUBSEQUENCE_STEP_SCORE +
      streak * STREAK_BONUS -
      Math.min(next - position - 1, MAX_GAP_PENALTY);
    position = next;
  }
  return score;
}

export function fuzzyScore(query: string, fields: ScoredField[]) {
  const tokens = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return 0;
  let total = 0;
  for (const token of tokens) {
    let best: number | null = null;
    for (const field of fields) {
      const score = tokenScore(token, field.text);
      if (score !== null && (best === null || score * field.weight > best))
        best = score * field.weight;
    }
    if (best === null) return null;
    total += best;
  }
  return total;
}
