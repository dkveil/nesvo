export type ToolVisibility = 'all' | 'compact';

export const toolVisibilityKey = 'nesvo.tool-visibility.v1';

const parse = (value: string | null): ToolVisibility =>
  value === 'all' ? 'all' : 'compact';

export const readToolVisibility = (): ToolVisibility => {
  try {
    return parse(localStorage.getItem(toolVisibilityKey));
  } catch {
    return 'compact';
  }
};

export const saveToolVisibility = (visibility: ToolVisibility): void => {
  try {
    localStorage.setItem(toolVisibilityKey, visibility);
  } catch {
    return;
  }
};
