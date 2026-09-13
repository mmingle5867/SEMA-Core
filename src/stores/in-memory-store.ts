import { formatKeyId, encodeBase56, parseInstallationId } from '../identity/base56.js';
import type { CoreIdentityState, SemaCoreStore } from '../core/store.js';
import type {
  CoreAuditEntry, CoreCapability, CoreCommand, CoreEvent, CoreExecution, CoreResult,
  JsonObject, SemaIdentifier, SemaIdentifierReservation,
} from '../core/types.js';

/** Test/reference store. Production adapters must provide database transactions. */
export class InMemorySemaCoreStore implements SemaCoreStore {
  protected state: CoreIdentityState | null = null;
  protected readonly reservations = new Map<string, SemaIdentifierReservation>();
  protected readonly identifiers = new Map<string, SemaIdentifier>();
  protected readonly commands = new Map<string, CoreCommand>();
  protected readonly executions = new Map<string, CoreExecution>();
  protected readonly capabilities = new Map<string, CoreCapability>();
  readonly results: CoreResult[] = [];
  readonly events: CoreEvent[] = [];
  readonly audits: CoreAuditEntry[] = [];

  async initializeIdentity(installationId: string) {
    const normalized = parseInstallationId(installationId);
    if (!this.state) this.state = { installationId: normalized, nextLocalId: BigInt(1), status: 'ACTIVE' };
    if (this.state.installationId !== normalized) throw new Error('Configured InstallationID does not match initialized Core');
    if (this.state.status !== 'ACTIVE') throw new Error('SEMA Core installation is suspended');
    return { ...this.state };
  }

  async reserveIdentifiers(input: { count: number; typeCode?: string; metadata: JsonObject }) {
    if (!this.state) throw new Error('SEMA Core is not initialized');
    const firstLocalValue = this.state.nextLocalId;
    const reservation: SemaIdentifierReservation = {
      id: `reservation-${this.reservations.size + 1}`, installationId: this.state.installationId,
      firstLocalValue, count: input.count, typeCode: input.typeCode, metadata: input.metadata, createdAt: new Date(),
    };
    const identifiers: SemaIdentifier[] = [];
    for (let index = 0; index < input.count; index += 1) {
      const localValue = firstLocalValue + BigInt(index);
      const id = formatKeyId({ installationId: this.state.installationId, localValue });
      const identifier: SemaIdentifier = {
        id, installationId: this.state.installationId, localValue, localCode: encodeBase56(localValue),
        typeCode: input.typeCode, status: 'RESERVED', metadata: input.metadata, reservationId: reservation.id,
      };
      this.identifiers.set(id, identifier);
      identifiers.push({ ...identifier });
    }
    this.state.nextLocalId += BigInt(input.count);
    this.reservations.set(reservation.id, reservation);
    return { reservation: { ...reservation }, identifiers };
  }

  async consumeReservedIdentifier(reservationId: string, id: string, metadata: JsonObject = {}) {
    if (!this.reservations.has(reservationId)) throw new Error('Identifier reservation not found');
    const identifier = this.identifiers.get(id);
    if (!identifier || identifier.reservationId !== reservationId) throw new Error('Identifier is not in this reservation');
    if (identifier.status !== 'RESERVED') throw new Error('Identifier has already been consumed');
    const consumed = { ...identifier, status: 'ISSUED' as const, metadata: { ...identifier.metadata, ...metadata } };
    this.identifiers.set(id, consumed);
    return { ...consumed };
  }

  async createCommand(command: CoreCommand) { this.commands.set(command.id, command); return command; }
  async updateCommand(id: string, update: Partial<Pick<CoreCommand, 'status'>>) {
    const command = this.commands.get(id); if (!command) throw new Error('Command not found');
    const next = { ...command, ...update }; this.commands.set(id, next); return next;
  }
  async createExecution(execution: CoreExecution) { this.executions.set(execution.id, execution); return execution; }
  async updateExecution(id: string, update: Partial<Pick<CoreExecution, 'status' | 'completedAt' | 'error'>>) {
    const execution = this.executions.get(id); if (!execution) throw new Error('Execution not found');
    const next = { ...execution, ...update }; this.executions.set(id, next); return next;
  }
  async createResult(result: CoreResult) { this.results.push(result); return result; }
  async createEvent(event: CoreEvent) { this.events.push(event); return event; }
  async createAudit(entry: CoreAuditEntry) { this.audits.push(entry); return entry; }
  async upsertCapability(capability: CoreCapability) { this.capabilities.set(capability.capabilityKey, capability); return capability; }
  async findCapability(capabilityKey: string) { return this.capabilities.get(capabilityKey) ?? null; }
  async listCapabilities(query: string) {
    const needle = query.toLowerCase();
    return [...this.capabilities.values()].filter((capability) => capability.status === 'ACTIVE' && (!needle || capability.capabilityKey.toLowerCase().includes(needle) || capability.displayName.toLowerCase().includes(needle))).sort((a, b) => a.displayName.localeCompare(b.displayName));
  }
}
