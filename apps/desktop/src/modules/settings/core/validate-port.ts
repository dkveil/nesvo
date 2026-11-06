export const MIN_PORT = 1;
export const MAX_PORT = 65535;

export const parsePort = (input: string): number | null => {
  const trimmed = input.trim();
  if (!/^\d{1,5}$/.test(trimmed)) return null;
  const port = Number(trimmed);
  return port >= MIN_PORT && port <= MAX_PORT ? port : null;
};
