import type {
  CoreAuditEntry, CoreCapability, CoreCommand, CoreEvent, CoreExecution, CoreResult,
  JsonObject, SemaIdentifier, SemaIdentifierReservation,
} from './types.js';

export interface CoreIdentityState {
  installationId: string;
  nextLocalId: bigint;
  status: 'ACTIVE' | 'SUSPENDED';
}

/**
 * The only persistence boundary required by SEMA Core. Implementations must
 * make reserveIdentifiers atomic and must never recycle reserved LocalIDs.
 */
export interface SemaCoreStore {
  initializeIdentity(installationId: string): Promise<CoreIdentityState>;
  reserveIdentifiers(input: {
    count: number;
    typeCode?: string;
    metadata: JsonObject;
  }): Promise<{ reservation: SemaIdentifierReservation; identifiers: SemaIdentifier[] }>;
  consumeReservedIdentifier(reservationId: string, id: string, metadata?: JsonObject): Promise<SemaIdentifier>;
  createCommand(command: CoreCommand): Promise<CoreCommand>;
  updateCommand(id: string, update: Partial<Pick<CoreCommand, 'status'>>): Promise<CoreCommand>;
  createExecution(execution: CoreExecution): Promise<CoreExecution>;
  updateExecution(id: string, update: Partial<Pick<CoreExecution, 'status' | 'completedAt' | 'error'>>): Promise<CoreExecution>;
  createResult(result: CoreResult): Promise<CoreResult>;
  createEvent(event: CoreEvent): Promise<CoreEvent>;
  createAudit(entry: CoreAuditEntry): Promise<CoreAuditEntry>;
  upsertCapability(capability: CoreCapability): Promise<CoreCapability>;
  findCapability(capabilityKey: string): Promise<CoreCapability | null>;
  listCapabilities(query: string): Promise<CoreCapability[]>;
}
