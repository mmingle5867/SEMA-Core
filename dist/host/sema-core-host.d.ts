import type { SemaCore } from '../core/sema-core.js';
import type { CoreHostAuthorization, CoreHostDocumentation, CoreHostRequestContext, CoreHostSettings, CoreHostStore, VersionedCoreHostSettings } from './types.js';
/** Installation backend: settings, operational statistics, docs, and Core runtime access. */
export declare class SemaCoreHost {
    private readonly core;
    private readonly store;
    private readonly authorization;
    private readonly version;
    constructor(core: SemaCore, store: CoreHostStore, authorization: CoreHostAuthorization, version?: string);
    initialize(context?: CoreHostRequestContext): Promise<{
        state: import("../index.js").CoreIdentityState;
        settings: VersionedCoreHostSettings;
    }>;
    health(context: CoreHostRequestContext): Promise<{
        status: "ACTIVE" | "SUSPENDED";
        installationId: string;
        version: string;
        capturedAt: Date;
    }>;
    getSettings(context: CoreHostRequestContext): Promise<VersionedCoreHostSettings>;
    updateSettings(context: CoreHostRequestContext, patch: Partial<CoreHostSettings>): Promise<VersionedCoreHostSettings>;
    statistics(context: CoreHostRequestContext): Promise<import("./types.js").CoreHostStatistics>;
    capabilities(context: CoreHostRequestContext): Promise<import("../index.js").CoreCapability[]>;
    documentation(context: CoreHostRequestContext): Promise<CoreHostDocumentation>;
    private requireRead;
}
//# sourceMappingURL=sema-core-host.d.ts.map