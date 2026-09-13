export type JsonValue = null | boolean | number | string | JsonValue[] | {
    [key: string]: JsonValue;
};
export type JsonObject = {
    [key: string]: JsonValue;
};
export type CoreLifecycleStatus = 'PENDING' | 'RUNNING' | 'WAITING' | 'CANCELLED' | 'FAILED' | 'SUCCESS';
export type IdentifierStatus = 'RESERVED' | 'ISSUED';
export interface SemaIdentifier {
    id: string;
    reservationId: string;
    installationId: string;
    localValue: bigint;
    localCode: string;
    typeCode?: string;
    status: IdentifierStatus;
    metadata: JsonObject;
}
export interface SemaIdentifierReservation {
    id: string;
    installationId: string;
    firstLocalValue: bigint;
    count: number;
    typeCode?: string;
    metadata: JsonObject;
    createdAt: Date;
}
export interface CoreCommand {
    id: string;
    commandType: string;
    actorId: string | null;
    workspaceId: string | null;
    subjectIds: string[];
    context: JsonObject;
    payload: JsonObject;
    status: CoreLifecycleStatus;
    createdAt: Date;
}
export interface CoreExecution {
    id: string;
    commandId: string;
    providerId: string | null;
    status: CoreLifecycleStatus;
    startedAt: Date | null;
    completedAt: Date | null;
    context: JsonObject;
    error: JsonObject | null;
}
export interface CoreResult {
    id: string;
    executionId: string;
    resultType: string;
    subjectIds: string[];
    data: JsonObject;
    createdAt: Date;
}
export interface CoreEvent {
    id: string;
    eventType: string;
    commandId: string | null;
    executionId: string | null;
    subjectIds: string[];
    data: JsonObject;
    occurredAt: Date;
}
export interface CoreAuditEntry {
    id: string;
    action: string;
    actorId: string | null;
    commandId: string | null;
    executionId: string | null;
    subjectIds: string[];
    evidence: JsonObject;
    occurredAt: Date;
}
export interface CoreCapability {
    id: string;
    capabilityKey: string;
    displayName: string;
    description: string;
    providerKey: string;
    version: string;
    status: 'ACTIVE' | 'INACTIVE';
    metadata: JsonObject;
}
//# sourceMappingURL=types.d.ts.map