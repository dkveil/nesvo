export const listboxOptionId = (listId: string, value: string) =>
  `${listId}-option-${value.replace(/[^\w-]/g, character => `_${character.charCodeAt(0).toString(16)}`)}`;
