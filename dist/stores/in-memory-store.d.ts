import type { CoreIdentityState, SemaCoreStore } from '../core/store.js';
import type { CoreAuditEntry, CoreCapability, CoreCommand, CoreEvent, CoreExecution, CoreResult, JsonObject, SemaIdentifier, SemaIdentifierReservation } from '../core/types.js';
/** Test/reference store. Production adapters must provide database transactions. */
export declare class InMemorySemaCoreStore implements SemaCoreStore {
    protected state: CoreIdentityState | null;
    protected readonly reservations: Map<string, SemaIdentifierReservation>;
    protected readonly identifiers: Map<string, SemaIdentifier>;
    protected readonly commands: Map<string, CoreCommand>;
    protected readonly executions: Map<string, CoreExecution>;
    protected readonly capabilities: Map<string, CoreCapability>;
    readonly results: CoreResult[];
    readonly events: CoreEvent[];
    readonly audits: CoreAuditEntry[];
    initializeIdentity(installationId: string): Promise<{
        installationId: string;
        nextLocalId: bigint;
        status: "ACTIVE" | "SUSPENDED";
    }>;
    reserveIdentifiers(input: {
        count: number;
        typeCode?: string;
        metadata: JsonObject;
    }): Promise<{
        reservation: {
            id: string;
            installationId: string;
            firstLocalValue: bigint;
            count: number;
            typeCode?: string;
            metadata: JsonObject;
            createdAt: Date;
        };
        identifiers: SemaIdentifier[];
    }>;
    consumeReservedIdentifier(reservationId: string, id: string, metadata?: JsonObject): Promise<{
        status: "ISSUED";
        metadata: {
            [x: string]: import("../core/types.js").JsonValue;
        };
        id: string;
        reservationId: string;
        installationId: string;
        localValue: bigint;
        localCode: string;
        typeCode?: string;
    }>;
    createCommand(command: CoreCommand): Promise<CoreCommand>;
    updateCommand(id: string, update: Partial<Pick<CoreCommand, 'status'>>): Promise<{
        status: import("../core/types.js").CoreLifecycleStatus;
        id: string;
        commandType: string;
        actorId: string | null;
        workspaceId: string | null;
        subjectIds: string[];
        context: JsonObject;
        payload: JsonObject;
        createdAt: Date;
    }>;
    createExecution(execution: CoreExecution): Promise<CoreExecution>;
    updateExecution(id: string, update: Partial<Pick<CoreExecution, 'status' | 'completedAt' | 'error'>>): Promise<{
        status: import("../core/types.js").CoreLifecycleStatus;
        completedAt: Date | null;
        error: JsonObject | null;
        id: string;
        commandId: string;
        providerId: string | null;
        startedAt: Date | null;
        context: JsonObject;
    }>;
    createResult(result: CoreResult): Promise<CoreResult>;
    createEvent(event: CoreEvent): Promise<CoreEvent>;
    createAudit(entry: CoreAuditEntry): Promise<CoreAuditEntry>;
    upsertCapability(capability: CoreCapability): Promise<CoreCapability>;
    findCapability(capabilityKey: string): Promise<CoreCapability | null>;
    listCapabilities(query: string): Promise<CoreCapability[]>;
}
//# sourceMappingURL=in-memory-store.d.ts.map