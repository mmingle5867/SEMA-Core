import type { SemaCoreStore } from './store.js';
import type { CoreCapability, CoreCommand, CoreEvent, CoreExecution, CoreLifecycleStatus, CoreResult, JsonObject, SemaIdentifier, SemaIdentifierReservation } from './types.js';
export interface SemaCoreOptions {
    installationId: string;
    /** Configurable policy limit; no caller can silently reserve an unlimited block. */
    maxReservationSize: number;
}
export declare class SemaCore {
    private readonly store;
    private readonly options;
    private readonly installationId;
    constructor(store: SemaCoreStore, options: SemaCoreOptions);
    initialize(): Promise<import("./store.js").CoreIdentityState>;
    getMaxReservationSize(): number;
    /** Installation administration may change this bounded policy at runtime. */
    setMaxReservationSize(value: number): void;
    issueIdentifier(typeCode?: string, metadata?: JsonObject): Promise<SemaIdentifier>;
    /**
     * Reserves real permanent IDs in one atomic operation. Unconsumed entries
     * remain reserved; they are never returned to the allocator or reused.
     */
    reserveIdentifiers(count: number, typeCode?: string, metadata?: JsonObject): Promise<{
        reservation: SemaIdentifierReservation;
        identifiers: SemaIdentifier[];
    }>;
    consumeReservedIdentifier(id: string, reservationId: string, metadata?: JsonObject): Promise<SemaIdentifier>;
    /** A child installation's InstallationID is a normal permanent object ID of its parent. */
    issueChildInstallation(metadata?: JsonObject): Promise<SemaIdentifier>;
    createCommand(input: {
        commandType: string;
        actorId?: string | null;
        workspaceId?: string | null;
        subjectIds?: string[];
        context?: JsonObject;
        payload?: JsonObject;
    }): Promise<CoreCommand>;
    startExecution(input: {
        commandId: string;
        providerId?: string | null;
        context?: JsonObject;
    }): Promise<CoreExecution>;
    completeExecution(input: {
        execution: CoreExecution;
        status: Extract<CoreLifecycleStatus, 'SUCCESS' | 'FAILED' | 'CANCELLED' | 'WAITING'>;
        resultType?: string;
        subjectIds?: string[];
        result?: JsonObject;
        error?: JsonObject;
    }): Promise<{
        execution: CoreExecution;
        result: CoreResult | null;
        event: CoreEvent;
    }>;
    recordEvent(input: {
        eventType: string;
        commandId?: string | null;
        executionId?: string | null;
        subjectIds?: string[];
        data?: JsonObject;
    }): Promise<CoreEvent>;
    recordAudit(input: {
        action: string;
        actorId?: string | null;
        commandId?: string | null;
        executionId?: string | null;
        subjectIds?: string[];
        evidence?: JsonObject;
    }): Promise<import("./types.js").CoreAuditEntry>;
    registerCapability(input: Omit<CoreCapability, 'id' | 'status'> & {
        status?: CoreCapability['status'];
    }): Promise<CoreCapability>;
    discoverCapabilities(query?: string): Promise<CoreCapability[]>;
    authorizeInvocation(input: {
        capabilityKey: string;
        actorId?: string | null;
        workspaceId?: string | null;
    }): Promise<{
        allowed: boolean;
        reason: string;
        capabilityId: string | null;
    }>;
    resolveCapability(input: {
        capabilityKey: string;
        actorId?: string | null;
        workspaceId?: string | null;
    }): Promise<CoreCapability>;
}
//# sourceMappingURL=sema-core.d.ts.map