/** Raised when a Core Host request is well-formed HTTP but its content is not acceptable. Maps to HTTP 400. */
export declare class CoreHostValidationError extends Error {
    constructor(message: string);
}
/** Raised when the caller is not allowed to perform a Core Host operation. Maps to HTTP 403. */
export declare class CoreHostAuthorizationError extends Error {
    constructor(message: string);
}
//# sourceMappingURL=errors.d.ts.map