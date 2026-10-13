import type { CoreCapability, CoreLifecycleStatus, JsonObject } from '../core/types.js';

/**
 * Installation-level settings. `documentationEnabled`, `auditRetentionDays`, `eventRetentionDays`
 * and `capabilityAutoFallback` are reserved for future use (self-documenting Core, retention,
 * capability fallback policy). They are stored and validated but intentionally not acted on yet.
 */
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
  identifiers: { reserved: number; issued: number; reservations: number };
  commands: Record<CoreLifecycleStatus, number>;
  executions: Record<CoreLifecycleStatus, number>;
  results: number;
  events: number;
  auditEntries: number;
  capabilities: { active: number; inactive: number; deprecated: number };
  capturedAt: Date;
}

export interface CoreHostDocumentation {
  packageName: '@selo/sema-core';
  version: string;
  summary: string;
  endpoints: Array<{ method: string; path: string; purpose: string }>;
  settings: Array<{ key: keyof CoreHostSettings; description: string }>;
  statisticGroups: string[];
}

export interface CoreHostStore {
  getHostSettings(): Promise<VersionedCoreHostSettings | null>;
  saveHostSettings(settings: VersionedCoreHostSettings): Promise<VersionedCoreHostSettings>;
  getHostStatistics(): Promise<CoreHostStatistics>;
  getCapabilitiesForHost(): Promise<CoreCapability[]>;
  /**
   * The next value from the counter that assigns the first ID of each new system. One counter, held by the
   * original system; it never goes backwards and never gives a value twice. Value 1 is the original system itself.
   */
  issueTopLevelValue(): Promise<bigint>;
}

export interface CoreHostAuthorization {
  canRead(input: { actorId: string | null; resource: string }): Promise<boolean>;
  canAdminister(input: { actorId: string | null; resource: string }): Promise<boolean>;
}

export interface CoreHostRequestContext { actorId: string | null; metadata?: JsonObject; }
