export class PermanentConnectionError extends Error {
  override name = 'PermanentConnectionError';
}

export const isPermanentConnectionError = (error: unknown) =>
  error instanceof PermanentConnectionError;

export class IncompatibleHostError extends PermanentConnectionError {
  override name = 'IncompatibleHostError';
}
