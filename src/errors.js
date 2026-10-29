/** Error raised by the portal client. `kind` drives the HTTP status we return. */
export class PortalError extends Error {
  /** @param {string} message @param {{kind: 'not_found'|'auth'|'timeout'|'unavailable'|'bad_response', status?: number}} opts */
  constructor(message, { kind, status } = {}) {
    super(message);
    this.name = 'PortalError';
    this.kind = kind;
    this.upstreamStatus = status;
  }
}

export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
  }
}
