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

/** The report of the last round of check-ins: each active node this Core holds checks in with its own parent. */
export interface CheckInRun {
  checkedAt: string;
  intervalSeconds: number;
  note?: string;
  nodes: Array<{
    nodeId: string;
    parentId?: string;
    /** CHECKED_IN: the parent stamped the time. TOP: no parent to check in with. UNREACHABLE: the parent's Core did not answer. PARENT_RETIRED: the parent is retired; the node followed the chain (newParentId when it moved). FAILED: the parent refused or the check-in broke (see reason). */
    state: 'CHECKED_IN' | 'TOP' | 'UNREACHABLE' | 'PARENT_RETIRED' | 'RETIRED_WHILE_AWAY' | 'FAILED';
    lastSeenAt?: string;
    /** The parent's list did not have this node, and now does. */
    addedToList?: true;
    newParentId?: string;
    reason?: string;
  }>;
}

/** The report of the check that fetches a ready basis before a node's counter reaches its organization's length limit. */
export interface KeyLimitCheck {
  checkedAt: string;
  note?: string;
  nodes: Array<{
    nodeId: string;
    basis: string;
    issued: string;
    /** NO_LIMIT: none applies. OK: below nine tenths. READY: a ready basis waits. NEEDS_BASIS: near the limit and none could be fetched. OVER_LIMIT: past the limit with none, still issuing. UNCHECKED: the check could not run for this node. */
    state: 'NO_LIMIT' | 'OK' | 'READY' | 'NEEDS_BASIS' | 'OVER_LIMIT' | 'UNCHECKED';
    limitLength?: number;
    maxValue?: string;
    nextBasis?: string;
    switchAt?: string;
    reason?: string;
    /** Information, not warnings: where the basis, or a ready basis, breaks the organization's limits because of segments issued under a parent's rules. */
    notes?: string[];
  }>;
}
