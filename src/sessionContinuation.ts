export class SessionContinuationUnavailableError extends Error {
  readonly code = 'SESSION_CONTINUATION_NOT_AVAILABLE';

  constructor(message = 'Session has no interrupted turn to continue.') {
    super(message);
    this.name = 'SessionContinuationUnavailableError';
  }
}
