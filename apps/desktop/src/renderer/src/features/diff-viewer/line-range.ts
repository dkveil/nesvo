import type {
  FileDiffMetadata,
  SelectedLineRange,
  SelectionSide,
} from '@pierre/diffs';
import type { CodeCommentSide } from '@nesvo/contracts';

export type DiffLineRange = {
  side: CodeCommentSide;
  startLine: number;
  endLine: number;
};

type DiffRow = {
  prefix: ' ' | '+' | '-';
  text: string;
  oldLine: number | null;
  newLine: number | null;
};

const SNIPPET_MAX_LENGTH = 8000;

export const selectionSideOf = (side: CodeCommentSide): SelectionSide =>
  side === 'old' ? 'deletions' : 'additions';

const commentSideOf = (side: SelectionSide | undefined): CodeCommentSide =>
  side === 'deletions' ? 'old' : 'new';

export function lineRangeOf(range: SelectedLineRange): DiffLineRange {
  const startSide = commentSideOf(range.side);
  const endSide = commentSideOf(range.endSide ?? range.side);
  if (startSide !== endSide)
    return { side: endSide, startLine: range.end, endLine: range.end };
  return {
    side: endSide,
    startLine: Math.min(range.start, range.end),
    endLine: Math.max(range.start, range.end),
  };
}

export function selectionOf(range: DiffLineRange): SelectedLineRange {
  const side = selectionSideOf(range.side);
  return { start: range.startLine, end: range.endLine, side, endSide: side };
}

export function lineRangeLabel(range: DiffLineRange) {
  const lines =
    range.startLine === range.endLine
      ? `${range.startLine}`
      : `${range.startLine}–${range.endLine}`;
  return range.side === 'old' ? `${lines} (removed)` : lines;
}

export function lineRangeDescription(range: DiffLineRange) {
  const prefix = range.side === 'old' ? 'removed ' : '';
  return range.startLine === range.endLine
    ? `${prefix}line ${range.startLine}`
    : `${prefix}lines ${range.startLine}–${range.endLine}`;
}

const lineText = (value: string | undefined) =>
  (value ?? '').replace(/\r?\n$/, '');

function rowsOf(diff: FileDiffMetadata): DiffRow[] {
  const rows: DiffRow[] = [];
  for (const hunk of diff.hunks) {
    let oldLine = hunk.deletionStart;
    let newLine = hunk.additionStart;
    for (const block of hunk.hunkContent) {
      if (block.type === 'context') {
        for (let index = 0; index < block.lines; index++)
          rows.push({
            prefix: ' ',
            text: lineText(diff.additionLines[block.additionLineIndex + index]),
            oldLine: oldLine++,
            newLine: newLine++,
          });
        continue;
      }
      for (let index = 0; index < block.deletions; index++)
        rows.push({
          prefix: '-',
          text: lineText(diff.deletionLines[block.deletionLineIndex + index]),
          oldLine: oldLine++,
          newLine: null,
        });
      for (let index = 0; index < block.additions; index++)
        rows.push({
          prefix: '+',
          text: lineText(diff.additionLines[block.additionLineIndex + index]),
          oldLine: null,
          newLine: newLine++,
        });
    }
  }
  return rows;
}

const rowIndexOf = (
  rows: readonly DiffRow[],
  line: number,
  side: CodeCommentSide,
) =>
  rows.findIndex(row =>
    side === 'old' ? row.oldLine === line : row.newLine === line,
  );

export function diffLineRangeOf(
  diff: FileDiffMetadata,
  range: SelectedLineRange,
): DiffLineRange {
  const simple = lineRangeOf(range);
  const startSide = commentSideOf(range.side);
  const endSide = commentSideOf(range.endSide ?? range.side);
  if (startSide === endSide) return simple;
  const rows = rowsOf(diff);
  const from = rowIndexOf(rows, range.start, startSide);
  const to = rowIndexOf(rows, range.end, endSide);
  if (from < 0 || to < 0) return simple;
  const lines = rows
    .slice(Math.min(from, to), Math.max(from, to) + 1)
    .map(row => (endSide === 'old' ? row.oldLine : row.newLine))
    .filter((line): line is number => line != null);
  return lines.length
    ? {
        side: endSide,
        startLine: Math.min(...lines),
        endLine: Math.max(...lines),
      }
    : simple;
}

export function snippetOf(diff: FileDiffMetadata, range: DiffLineRange) {
  const rows = rowsOf(diff);
  const inRange = (row: DiffRow) => {
    const line = range.side === 'old' ? row.oldLine : row.newLine;
    return line != null && line >= range.startLine && line <= range.endLine;
  };
  const first = rows.findIndex(inRange);
  if (first < 0) return '';
  const last = rows.findLastIndex(inRange);
  return rows
    .slice(first, last + 1)
    .map(row => `${row.prefix}${row.text}`)
    .join('\n')
    .slice(0, SNIPPET_MAX_LENGTH);
}
