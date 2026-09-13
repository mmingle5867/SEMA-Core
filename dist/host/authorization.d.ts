import type { CoreHostAuthorization } from './types.js';
/** Local-first starter policy. Production adapters replace this with Core policy evaluation. */
export declare class LocalCoreHostAuthorization implements CoreHostAuthorization {
    private readonly administratorIds;
    constructor(administratorIds?: ReadonlySet<string>);
    canRead(): Promise<boolean>;
    canAdminister(input: {
        actorId: string | null;
    }): Promise<boolean>;
}
//# sourceMappingURL=authorization.d.ts.map