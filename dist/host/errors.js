/** Raised when a Core Host request is well-formed HTTP but its content is not acceptable. Maps to HTTP 400. */
export class CoreHostValidationError extends Error {
    constructor(message) {
        super(message);
        this.name = 'CoreHostValidationError';
    }
}
/** Raised when the caller is not allowed to perform a Core Host operation. Maps to HTTP 403. */
export class CoreHostAuthorizationError extends Error {
    constructor(message) {
        super(message);
        this.name = 'CoreHostAuthorizationError';
    }
}
//# sourceMappingURL=errors.js.map