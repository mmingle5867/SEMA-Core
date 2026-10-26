/** Raised when a Core Host request is well-formed HTTP but its content is not acceptable. Maps to HTTP 400. */
export class CoreHostValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CoreHostValidationError';
  }
}

/** Raised when the caller is not allowed to perform a Core Host operation. Maps to HTTP 403. */
/** Something Core depends on cannot be reached, such as Foundation Access for permissions. Says which, plainly. */
export class CoreHostUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CoreHostUnavailableError';
  }
}

/** This Core is shut down: its own machine node is suspended. It refuses changes and work, and stays readable. */
export class CoreHostLockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CoreHostLockedError';
  }
}

/** What was asked for does not exist on this Core. Maps to HTTP 404. */
export class CoreHostNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CoreHostNotFoundError';
  }
}

export class CoreHostAuthorizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CoreHostAuthorizationError';
  }
}
