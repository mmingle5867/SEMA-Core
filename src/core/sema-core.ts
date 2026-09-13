import { formatKeyId, normalizeTypeCode, parseInstallationId } from '../identity/base56.js';
import type { SemaCoreStore } from './store.js';
import type {
  CoreCapability, CoreCommand, CoreEvent, CoreExecution, CoreLifecycleStatus, CoreResult,
  JsonObject, SemaIdentifier, SemaIdentifierReservation,
} from './types.js';

export interface SemaCoreOptions {
  installationId: string;
  /** Configurable policy limit; no caller can silently reserve an unlimited block. */
  maxReservationSize: number;
}

export class SemaCore {
  private readonly installationId: string;

  constructor(private readonly store: SemaCoreStore, private readonly options: SemaCoreOptions) {
    this.installationId = parseInstallationId(options.installationId);
    if (!Number.isSafeInteger(options.maxReservationSize) || options.maxReservationSize < 1) {
      throw new Error('maxReservationSize must be a positive integer');
    }
  }

  async initialize() {
    return this.store.initializeIdentity(this.installationId);
  }

  getMaxReservationSize() { return this.options.maxReservationSize; }

  /** Installation administration may change this bounded policy at runtime. */
  setMaxReservationSize(value: number) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error('maxReservationSize must be a positive integer');
    this.options.maxReservationSize = value;
  }

  async issueIdentifier(typeCode?: string, metadata: JsonObject = {}) {
    const { identifiers } = await this.reserveIdentifiers(1, typeCode, metadata);
    return this.consumeReservedIdentifier(identifiers[0]!.id, identifiers[0]!.reservationId, metadata);
  }

  /**
   * Reserves real permanent IDs in one atomic operation. Unconsumed entries
   * remain reserved; they are never returned to the allocator or reused.
   */
  async reserveIdentifiers(count: number, typeCode?: string, metadata: JsonObject = {}) {
    if (!Number.isSafeInteger(count) || count < 1 || count > this.options.maxReservationSize) {
      throw new Error(`Reservation count must be between 1 and ${this.options.maxReservationSize}`);
    }
    return this.store.reserveIdentifiers({ count, typeCode: typeCode ? normalizeTypeCode(typeCode) : undefined, metadata });
  }

  async consumeReservedIdentifier(id: string, reservationId: string, metadata: JsonObject = {}) {
    return this.store.consumeReservedIdentifier(reservationId, id, metadata);
  }

  /** A child installation's InstallationID is a normal permanent object ID of its parent. */
  async issueChildInstallation(metadata: JsonObject = {}) {
    return this.issueIdentifier('INSTALLATION', metadata);
  }

  async createCommand(input: {
    commandType: string;
    actorId?: string | null;
    workspaceId?: string | null;
    subjectIds?: string[];
    context?: JsonObject;
    payload?: JsonObject;
  }) {
    const issued = await this.issueIdentifier('COMMAND', { commandType: input.commandType });
    const command: CoreCommand = {
      id: issued.id, commandType: input.commandType, actorId: input.actorId ?? null,
      workspaceId: input.workspaceId ?? null, subjectIds: input.subjectIds ?? [],
      context: input.context ?? {}, payload: input.payload ?? {}, status: 'PENDING', createdAt: new Date(),
    };
    return this.store.createCommand(command);
  }

  async startExecution(input: { commandId: string; providerId?: string | null; context?: JsonObject }) {
    const issued = await this.issueIdentifier('EXECUTION', { commandId: input.commandId });
    await this.store.updateCommand(input.commandId, { status: 'RUNNING' });
    const execution: CoreExecution = {
      id: issued.id, commandId: input.commandId, providerId: input.providerId ?? null, status: 'RUNNING',
      startedAt: new Date(), completedAt: null, context: input.context ?? {}, error: null,
    };
    return this.store.createExecution(execution);
  }

  async completeExecution(input: {
    execution: CoreExecution;
    status: Extract<CoreLifecycleStatus, 'SUCCESS' | 'FAILED' | 'CANCELLED' | 'WAITING'>;
    resultType?: string;
    subjectIds?: string[];
    result?: JsonObject;
    error?: JsonObject;
  }) {
    const execution = await this.store.updateExecution(input.execution.id, {
      status: input.status, completedAt: new Date(), error: input.error ?? null,
    });
    await this.store.updateCommand(execution.commandId, { status: input.status });
    let result: CoreResult | null = null;
    if (input.resultType) {
      const issued = await this.issueIdentifier('RESULT', { executionId: execution.id });
      result = await this.store.createResult({
        id: issued.id, executionId: execution.id, resultType: input.resultType,
        subjectIds: input.subjectIds ?? [], data: input.result ?? {}, createdAt: new Date(),
      });
    }
    const event = await this.recordEvent({
      eventType: `execution.${input.status.toLowerCase()}`, commandId: execution.commandId,
      executionId: execution.id, subjectIds: input.subjectIds, data: input.result ?? input.error ?? {},
    });
    return { execution, result, event };
  }

  async recordEvent(input: { eventType: string; commandId?: string | null; executionId?: string | null; subjectIds?: string[]; data?: JsonObject }) {
    const issued = await this.issueIdentifier('EVENT', { eventType: input.eventType });
    const event: CoreEvent = {
      id: issued.id, eventType: input.eventType, commandId: input.commandId ?? null,
      executionId: input.executionId ?? null, subjectIds: input.subjectIds ?? [], data: input.data ?? {}, occurredAt: new Date(),
    };
    return this.store.createEvent(event);
  }

  async recordAudit(input: { action: string; actorId?: string | null; commandId?: string | null; executionId?: string | null; subjectIds?: string[]; evidence?: JsonObject }) {
    const issued = await this.issueIdentifier('AUDIT', { action: input.action });
    return this.store.createAudit({
      id: issued.id, action: input.action, actorId: input.actorId ?? null, commandId: input.commandId ?? null,
      executionId: input.executionId ?? null, subjectIds: input.subjectIds ?? [], evidence: input.evidence ?? {}, occurredAt: new Date(),
    });
  }

  async registerCapability(input: Omit<CoreCapability, 'id' | 'status'> & { status?: CoreCapability['status'] }) {
    const existing = await this.store.findCapability(input.capabilityKey);
    const identifier = existing?.id ?? (await this.issueIdentifier('CAPABILITY', { capabilityKey: input.capabilityKey })).id;
    return this.store.upsertCapability({ ...input, id: identifier, status: input.status ?? 'ACTIVE' });
  }

  async discoverCapabilities(query = '') {
    return this.store.listCapabilities(query);
  }

  async authorizeInvocation(input: { capabilityKey: string; actorId?: string | null; workspaceId?: string | null }) {
    const capability = await this.store.findCapability(input.capabilityKey);
    const allowed = capability?.status === 'ACTIVE';
    const decision = { allowed, reason: allowed ? 'local-active-capability' : 'capability-unavailable', capabilityId: capability?.id ?? null };
    await this.recordAudit({
      action: 'policy.invocation.decision', actorId: input.actorId, subjectIds: capability ? [capability.id] : [],
      evidence: { capabilityKey: input.capabilityKey, workspaceId: input.workspaceId ?? null, ...decision },
    });
    return decision;
  }

  async resolveCapability(input: { capabilityKey: string; actorId?: string | null; workspaceId?: string | null }) {
    const decision = await this.authorizeInvocation(input);
    if (!decision.allowed) throw new Error(`Capability is unavailable: ${input.capabilityKey}`);
    const capability = await this.store.findCapability(input.capabilityKey);
    if (!capability) throw new Error(`Capability disappeared during resolution: ${input.capabilityKey}`);
    await this.recordAudit({
      action: 'resolution.capability.selected', actorId: input.actorId, subjectIds: [capability.id],
      evidence: { capabilityKey: capability.capabilityKey, providerKey: capability.providerKey, workspaceId: input.workspaceId ?? null },
    });
    return capability;
  }
}
