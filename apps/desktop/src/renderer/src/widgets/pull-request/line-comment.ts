import type { SelectedLineRange, SelectionSide } from '@pierre/diffs';

export type DiffSide = 'left' | 'right';

export type LineRange = {
  side: DiffSide;
  line: number;
  startLine: number | null;
};

export type LineDraft = LineRange & { path: string; body: string };

export const selectionSide = (side: DiffSide): SelectionSide =>
  side === 'left' ? 'deletions' : 'additions';

const diffSide = (side: SelectionSide | undefined): DiffSide =>
  side === 'deletions' ? 'left' : 'right';

export function lineRangeOf(range: SelectedLineRange): LineRange {
  const startSide = diffSide(range.side);
  const endSide = diffSide(range.endSide ?? range.side);
  if (startSide !== endSide)
    return { side: endSide, line: range.end, startLine: null };
  const first = Math.min(range.start, range.end);
  const last = Math.max(range.start, range.end);
  return {
    side: endSide,
    line: last,
    startLine: first === last ? null : first,
  };
}

export function selectedLinesOf(range: LineRange): SelectedLineRange {
  const side = selectionSide(range.side);
  return {
    start: range.startLine ?? range.line,
    end: range.line,
    side,
    endSide: side,
  };
}

export function lineRangeLabel(range: LineRange) {
  const prefix = range.side === 'left' ? 'removed ' : '';
  return range.startLine
    ? `${prefix}lines ${range.startLine}–${range.line}`
    : `${prefix}line ${range.line}`;
}
