import type { CoreCapability, CoreLifecycleStatus, JsonObject } from '../core/types.js';
export interface CoreHostSettings {
    maxReservationSize: number;
    auditRetentionDays: number;
    eventRetentionDays: number;
    capabilityAutoFallback: boolean;
    documentationEnabled: boolean;
}
export interface VersionedCoreHostSettings {
    installationId: string;
    revision: number;
    updatedAt: Date;
    updatedById: string | null;
    values: CoreHostSettings;
}
export interface CoreHostStatistics {
    installationId: string;
    status: 'ACTIVE' | 'SUSPENDED';
    nextLocalId: bigint;
    identifiers: {
        reserved: number;
        issued: number;
        reservations: number;
    };
    commands: Record<CoreLifecycleStatus, number>;
    executions: Record<CoreLifecycleStatus, number>;
    results: number;
    events: number;
    auditEntries: number;
    capabilities: {
        active: number;
        inactive: number;
        deprecated: number;
    };
    capturedAt: Date;
}
export interface CoreHostDocumentation {
    packageName: '@selo/sema-core';
    version: string;
    summary: string;
    endpoints: Array<{
        method: string;
        path: string;
        purpose: string;
    }>;
    settings: Array<{
        key: keyof CoreHostSettings;
        description: string;
    }>;
    statisticGroups: string[];
}
export interface CoreHostStore {
    getHostSettings(): Promise<VersionedCoreHostSettings | null>;
    saveHostSettings(settings: VersionedCoreHostSettings): Promise<VersionedCoreHostSettings>;
    getHostStatistics(): Promise<CoreHostStatistics>;
    getCapabilitiesForHost(): Promise<CoreCapability[]>;
}
export interface CoreHostAuthorization {
    canRead(input: {
        actorId: string | null;
        resource: 'health' | 'settings' | 'statistics' | 'documentation' | 'capabilities';
    }): Promise<boolean>;
    canAdminister(input: {
        actorId: string | null;
        resource: 'settings' | 'identifiers' | 'runtime';
    }): Promise<boolean>;
}
export interface CoreHostRequestContext {
    actorId: string | null;
    metadata?: JsonObject;
}
//# sourceMappingURL=types.d.ts.map