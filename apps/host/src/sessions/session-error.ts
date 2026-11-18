export class SessionError extends Error {
  constructor(
    readonly code:
      | 'busy'
      | 'not-found'
      | 'invalid-directory'
      | 'invalid-request'
      | 'unavailable',
    message: string,
  ) {
    super(message);
  }
}
