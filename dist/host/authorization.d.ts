import type { CoreHostAuthorization } from './types.js';
/** Local-first starter policy. Production adapters replace this with Core policy evaluation. */
export declare class LocalCoreHostAuthorization implements CoreHostAuthorization {
    private readonly administratorIds;
    constructor(administratorIds?: ReadonlySet<string>);
    canRead(input: {
        actorId: string | null;
    }): Promise<boolean>;
    canAdminister(input: {
        actorId: string | null;
    }): Promise<boolean>;
}
/**
 * Transitional application authentication.  A client secret proves which
 * registered application is calling; it never substitutes for a human user
 * in command and audit payloads.  Policy evaluation remains in Foundation.
 */
export declare class FoundationPolicyAuthorization implements CoreHostAuthorization {
    private readonly policyUrl;
    private readonly policyKey;
    private readonly clients;
    constructor(policyUrl: string, policyKey: string, clients: Array<{
        applicationKey: string;
        secret: string;
    }>);
    private evaluate;
    canRead(input: {
        actorId: string | null;
        resource: string;
    }): Promise<boolean>;
    canAdminister(input: {
        actorId: string | null;
        resource: string;
    }): Promise<boolean>;
}
//# sourceMappingURL=authorization.d.ts.map