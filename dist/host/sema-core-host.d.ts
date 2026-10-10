import type { SemaCore } from '../core/sema-core.js';
import type { CoreCapability, CoreExecution, CoreLifecycleStatus, JsonObject } from '../core/types.js';
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
    capabilities(context: CoreHostRequestContext): Promise<CoreCapability[]>;
    reserveIdentifiers(context: CoreHostRequestContext, input: {
        count: number;
        typeCode?: string;
        metadata?: import('../core/types.js').JsonObject;
    }): Promise<{
        reservation: import("../core/types.js").SemaIdentifierReservation;
        identifiers: import("../core/types.js").SemaIdentifier[];
    }>;
    consumeReservedIdentifier(context: CoreHostRequestContext, input: {
        reservationId: string;
        id: string;
        metadata?: import('../core/types.js').JsonObject;
    }): Promise<import("../core/types.js").SemaIdentifier>;
    /** Core runtime records live in the Core database, never in an application's database. */
    createCommand(context: CoreHostRequestContext, input: {
        commandType: string;
        actorId?: string | null;
        workspaceId?: string | null;
        subjectIds?: string[];
        context?: JsonObject;
        payload?: JsonObject;
    }): Promise<import("../core/types.js").CoreCommand>;
    startExecution(context: CoreHostRequestContext, input: {
        commandId: string;
        providerId?: string | null;
        context?: JsonObject;
    }): Promise<CoreExecution>;
    completeExecution(context: CoreHostRequestContext, input: {
        execution: CoreExecution;
        status: Extract<CoreLifecycleStatus, 'SUCCESS' | 'FAILED' | 'CANCELLED' | 'WAITING'>;
        resultType?: string;
        subjectIds?: string[];
        result?: JsonObject;
        error?: JsonObject;
    }): Promise<{
        execution: CoreExecution;
        result: import("../core/types.js").CoreResult | null;
        event: import("../core/types.js").CoreEvent;
    }>;
    recordEvent(context: CoreHostRequestContext, input: {
        eventType: string;
        commandId?: string | null;
        executionId?: string | null;
        subjectIds?: string[];
        data?: JsonObject;
    }): Promise<import("../core/types.js").CoreEvent>;
    recordAudit(context: CoreHostRequestContext, input: {
        action: string;
        actorId?: string | null;
        commandId?: string | null;
        executionId?: string | null;
        subjectIds?: string[];
        evidence?: JsonObject;
    }): Promise<import("../core/types.js").CoreAuditEntry>;
    registerCapability(context: CoreHostRequestContext, input: Omit<CoreCapability, 'id' | 'status'> & {
        status?: CoreCapability['status'];
    }): Promise<CoreCapability>;
    discoverCapabilities(context: CoreHostRequestContext, query?: string): Promise<CoreCapability[]>;
    authorizeInvocation(context: CoreHostRequestContext, input: {
        capabilityKey: string;
        actorId?: string | null;
        workspaceId?: string | null;
    }): Promise<{
        allowed: boolean;
        reason: string;
        capabilityId: string | null;
    }>;
    resolveCapability(context: CoreHostRequestContext, input: {
        capabilityKey: string;
        actorId?: string | null;
        workspaceId?: string | null;
    }): Promise<CoreCapability>;
    documentation(context: CoreHostRequestContext): Promise<CoreHostDocumentation>;
    private requireRead;
    private requireAdministration;
}
//# sourceMappingURL=sema-core-host.d.ts.map