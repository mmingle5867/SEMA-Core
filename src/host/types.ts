import type { CoreCapability, CoreLifecycleStatus, JsonObject, SemaIdentifier } from '../core/types.js';

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
   * The block of first IDs this Core may assign to new systems, if it holds one. `issued` is the last value
   * given out and `end` is the first value beyond the block.
   */
  topLevelBlock(): Promise<{ block: number; issued: bigint; end: bigint } | undefined>;
  /**
   * Gives this Core a block. Refused while it holds a block that still has values left, so a block is never
   * dropped by mistake. `start` is the first value the block may give out.
   */
  grantTopLevelBlock(input: { block: number; start: bigint; end: bigint }): Promise<void>;
  /**
   * The next value from this Core's block. It never goes backwards and never gives a value twice.
   * Undefined when this Core holds no block, or its block is used up.
   */
  issueTopLevelValue(): Promise<bigint | undefined>;
  /** How an ID this Core issued was recorded, or undefined when this Core has no record of issuing it. */
  issuedIdentifier(id: string): Promise<SemaIdentifier | undefined>;
}

export interface CoreHostAuthorization {
  canRead(input: { actorId: string | null; resource: string }): Promise<boolean>;
  canAdminister(input: { actorId: string | null; resource: string }): Promise<boolean>;
}

export interface CoreHostRequestContext { actorId: string | null; metadata?: JsonObject; }
