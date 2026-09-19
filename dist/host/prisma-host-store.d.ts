import { Prisma, PrismaClient } from '@prisma/client';
import type { CoreAuditEntry, CoreCapability, CoreCommand, CoreEvent, CoreExecution, CoreResult, JsonObject, SemaCoreStore, SemaIdentifier, SemaIdentifierReservation } from '../index.js';
import type { CoreHostStatistics, CoreHostStore, VersionedCoreHostSettings } from './types.js';
/** PostgreSQL-backed shared Core store. It contains Core records only. */
export declare class PrismaSemaCoreHostStore implements SemaCoreStore, CoreHostStore {
    private readonly prisma;
    constructor(prisma?: PrismaClient<Prisma.PrismaClientOptions, never, import("@prisma/client/runtime/library").DefaultArgs>);
    disconnect(): Promise<void>;
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
        reservation: SemaIdentifierReservation;
        identifiers: SemaIdentifier[];
    }>;
    consumeReservedIdentifier(reservationId: string, id: string, metadata?: JsonObject): Promise<{
        id: string;
        reservationId: string;
        installationId: string;
        localValue: bigint;
        localCode: string;
        typeCode: string | undefined;
        status: "ISSUED";
        metadata: JsonObject;
    }>;
    createCommand(command: CoreCommand): Promise<CoreCommand>;
    updateCommand(id: string, update: Partial<Pick<CoreCommand, 'status'>>): Promise<{
        subjectIds: string[];
        context: JsonObject;
        payload: JsonObject;
        status: CoreCommand["status"];
        id: string;
        commandType: string;
        actorId: string | null;
        workspaceId: string | null;
        createdAt: Date;
    }>;
    createExecution(execution: CoreExecution): Promise<CoreExecution>;
    updateExecution(id: string, update: Partial<Pick<CoreExecution, 'status' | 'completedAt' | 'error'>>): Promise<{
        context: JsonObject;
        error: JsonObject | null;
        status: CoreExecution["status"];
        id: string;
        createdAt: Date;
        completedAt: Date | null;
        commandId: string;
        providerId: string | null;
        startedAt: Date | null;
    }>;
    createResult(result: CoreResult): Promise<CoreResult>;
    createEvent(event: CoreEvent): Promise<CoreEvent>;
    createAudit(entry: CoreAuditEntry): Promise<CoreAuditEntry>;
    upsertCapability(capability: CoreCapability): Promise<{
        id: string;
        metadata: JsonObject;
        status: CoreCapability["status"];
        capabilityKey: string;
        displayName: string;
        description: string;
        providerKey: string;
        version: string;
    }>;
    findCapability(capabilityKey: string): Promise<{
        metadata: JsonObject;
        status: CoreCapability["status"];
        id: string;
        createdAt: Date;
        capabilityKey: string;
        displayName: string;
        description: string;
        providerKey: string;
        version: string;
        updatedAt: Date;
    } | null>;
    listCapabilities(query: string): Promise<{
        metadata: JsonObject;
        status: CoreCapability["status"];
        id: string;
        createdAt: Date;
        capabilityKey: string;
        displayName: string;
        description: string;
        providerKey: string;
        version: string;
        updatedAt: Date;
    }[]>;
    getHostSettings(): Promise<{
        installationId: string;
        revision: number;
        updatedAt: Date;
        updatedById: string | null;
        values: VersionedCoreHostSettings["values"];
    } | null>;
    saveHostSettings(settings: VersionedCoreHostSettings): Promise<{
        installationId: string;
        revision: number;
        updatedAt: Date;
        updatedById: string | null;
        values: VersionedCoreHostSettings["values"];
    }>;
    getCapabilitiesForHost(): Promise<{
        metadata: JsonObject;
        status: CoreCapability["status"];
        id: string;
        createdAt: Date;
        capabilityKey: string;
        displayName: string;
        description: string;
        providerKey: string;
        version: string;
        updatedAt: Date;
    }[]>;
    getHostStatistics(): Promise<CoreHostStatistics>;
}
//# sourceMappingURL=prisma-host-store.d.ts.map