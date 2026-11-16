const MAX_LINES = 12;
const MAX_CHARACTERS = 1200;

export const isLongPrompt = (body: string) =>
  body.length > MAX_CHARACTERS || body.split('\n').length > MAX_LINES;
