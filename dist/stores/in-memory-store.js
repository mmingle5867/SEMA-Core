import { formatKeyId, encodeBase56, parseInstallationId } from '../identity/base56.js';
/** Test/reference store. Production adapters must provide database transactions. */
export class InMemorySemaCoreStore {
    state = null;
    reservations = new Map();
    identifiers = new Map();
    commands = new Map();
    executions = new Map();
    capabilities = new Map();
    results = [];
    events = [];
    audits = [];
    async initializeIdentity(installationId) {
        const normalized = parseInstallationId(installationId);
        if (!this.state)
            this.state = { installationId: normalized, nextLocalId: BigInt(1), status: 'ACTIVE' };
        if (this.state.installationId !== normalized)
            throw new Error('Configured InstallationID does not match initialized Core');
        if (this.state.status !== 'ACTIVE')
            throw new Error('SEMA Core installation is suspended');
        return { ...this.state };
    }
    async reserveIdentifiers(input) {
        if (!this.state)
            throw new Error('SEMA Core is not initialized');
        const firstLocalValue = this.state.nextLocalId;
        const reservationId = formatKeyId({ installationId: this.state.installationId, localValue: firstLocalValue });
        const reservation = {
            // A reservation is keyed by its first reserved permanent KeyID. It does
            // not consume an additional local number ahead of the requested objects.
            id: reservationId, installationId: this.state.installationId,
            firstLocalValue, count: input.count, typeCode: input.typeCode, metadata: input.metadata, createdAt: new Date(),
        };
        const identifiers = [];
        for (let index = 0; index < input.count; index += 1) {
            const localValue = firstLocalValue + BigInt(index);
            const id = formatKeyId({ installationId: this.state.installationId, localValue });
            const identifier = {
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
    async consumeReservedIdentifier(reservationId, id, metadata = {}) {
        if (!this.reservations.has(reservationId))
            throw new Error('Identifier reservation not found');
        const identifier = this.identifiers.get(id);
        if (!identifier || identifier.reservationId !== reservationId)
            throw new Error('Identifier is not in this reservation');
        if (identifier.status !== 'RESERVED')
            throw new Error('Identifier has already been consumed');
        const consumed = { ...identifier, status: 'ISSUED', metadata: { ...identifier.metadata, ...metadata } };
        this.identifiers.set(id, consumed);
        return { ...consumed };
    }
    async createCommand(command) { this.commands.set(command.id, command); return command; }
    async updateCommand(id, update) {
        const command = this.commands.get(id);
        if (!command)
            throw new Error('Command not found');
        const next = { ...command, ...update };
        this.commands.set(id, next);
        return next;
    }
    async createExecution(execution) { this.executions.set(execution.id, execution); return execution; }
    async updateExecution(id, update) {
        const execution = this.executions.get(id);
        if (!execution)
            throw new Error('Execution not found');
        const next = { ...execution, ...update };
        this.executions.set(id, next);
        return next;
    }
    async createResult(result) { this.results.push(result); return result; }
    async createEvent(event) { this.events.push(event); return event; }
    async createAudit(entry) { this.audits.push(entry); return entry; }
    async upsertCapability(capability) { this.capabilities.set(capability.capabilityKey, capability); return capability; }
    async findCapability(capabilityKey) { return this.capabilities.get(capabilityKey) ?? null; }
    async listCapabilities(query) {
        const needle = query.toLowerCase();
        return [...this.capabilities.values()].filter((capability) => capability.status === 'ACTIVE' && (!needle || capability.capabilityKey.toLowerCase().includes(needle) || capability.displayName.toLowerCase().includes(needle))).sort((a, b) => a.displayName.localeCompare(b.displayName));
    }
}
//# sourceMappingURL=in-memory-store.js.map