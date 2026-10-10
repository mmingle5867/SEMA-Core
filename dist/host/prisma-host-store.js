import { Prisma, PrismaClient } from '@prisma/client';
import { encodeBase56, formatKeyId, normalizeTypeCode } from '../identity/base56.js';
const STATE_KEY = 'PRIMARY';
const object = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const strings = (value) => Array.isArray(value) ? value.filter((item) => typeof item === 'string') : [];
const counts = () => ({ PENDING: 0, RUNNING: 0, WAITING: 0, CANCELLED: 0, FAILED: 0, SUCCESS: 0 });
async function reserve(tx, input) {
    const rows = await tx.$queryRaw `
    UPDATE "sema_core_identity_state" SET "nextLocalId" = "nextLocalId" + ${BigInt(input.count)}, "updatedAt" = NOW()
    WHERE "stateKey" = ${STATE_KEY} AND "status" = 'ACTIVE'
    RETURNING "installationId", "nextLocalId" - ${BigInt(input.count)} AS "localValue"
  `;
    const first = rows[0];
    if (!first)
        throw new Error('SEMA Core KeyID allocator is unavailable');
    const reservationId = formatKeyId({ installationId: first.installationId, localValue: first.localValue });
    const typeCode = input.typeCode ? normalizeTypeCode(input.typeCode) : undefined;
    const reservation = { id: reservationId, installationId: first.installationId, firstLocalValue: first.localValue, count: input.count, typeCode, metadata: input.metadata, createdAt: new Date() };
    await tx.semaIdentifierReservation.create({ data: { ...reservation, metadata: input.metadata } });
    const identifiers = [];
    for (let index = 0; index < input.count; index += 1) {
        const localValue = first.localValue + BigInt(index);
        const id = formatKeyId({ installationId: first.installationId, localValue });
        await tx.semaIssuedIdentifier.create({ data: { semaId: id, reservationId, installationId: first.installationId, localValue, localCode: encodeBase56(localValue), typeCode, status: 'RESERVED', metadata: input.metadata } });
        identifiers.push({ id, reservationId, installationId: first.installationId, localValue, localCode: encodeBase56(localValue), typeCode, status: 'RESERVED', metadata: input.metadata });
    }
    return { reservation, identifiers };
}
/** PostgreSQL-backed shared Core store. It contains Core records only. */
export class PrismaSemaCoreHostStore {
    prisma;
    constructor(prisma = new PrismaClient()) {
        this.prisma = prisma;
    }
    async disconnect() { await this.prisma.$disconnect(); }
    async initializeIdentity(installationId) {
        const state = await this.prisma.semaCoreIdentityState.upsert({ where: { stateKey: STATE_KEY }, update: {}, create: { stateKey: STATE_KEY, installationId, nextLocalId: BigInt(1) } });
        if (state.installationId !== installationId || state.status !== 'ACTIVE')
            throw new Error('SEMA Core installation is unavailable');
        return { installationId: state.installationId, nextLocalId: state.nextLocalId, status: state.status };
    }
    async reserveIdentifiers(input) { return this.prisma.$transaction((tx) => reserve(tx, input)); }
    async consumeReservedIdentifier(reservationId, id, metadata = {}) {
        return this.prisma.$transaction(async (tx) => {
            const row = await tx.semaIssuedIdentifier.findUnique({ where: { semaId: id } });
            if (!row || row.reservationId !== reservationId)
                throw new Error('Identifier is not in this reservation');
            if (row.status !== 'RESERVED')
                throw new Error('Identifier has already been consumed');
            const updated = await tx.semaIssuedIdentifier.update({ where: { semaId: id }, data: { status: 'ISSUED', consumedAt: new Date(), metadata: { ...object(row.metadata), ...metadata } } });
            return { id: updated.semaId, reservationId, installationId: updated.installationId, localValue: updated.localValue, localCode: updated.localCode, typeCode: updated.typeCode ?? undefined, status: 'ISSUED', metadata: object(updated.metadata) };
        });
    }
    async createCommand(command) { await this.prisma.semaCoreCommand.create({ data: command }); return command; }
    async updateCommand(id, update) { const row = await this.prisma.semaCoreCommand.update({ where: { id }, data: update }); return { ...row, subjectIds: strings(row.subjectIds), context: object(row.context), payload: object(row.payload), status: row.status }; }
    async createExecution(execution) { await this.prisma.semaCoreExecution.create({ data: { ...execution, error: execution.error ?? Prisma.JsonNull } }); return execution; }
    async updateExecution(id, update) { const data = { ...(update.status !== undefined ? { status: update.status } : {}), ...(update.completedAt !== undefined ? { completedAt: update.completedAt } : {}), ...(update.error !== undefined ? { error: update.error ?? Prisma.JsonNull } : {}) }; const row = await this.prisma.semaCoreExecution.update({ where: { id }, data }); return { ...row, context: object(row.context), error: row.error ? object(row.error) : null, status: row.status }; }
    async createResult(result) { await this.prisma.semaCoreResult.create({ data: result }); return result; }
    async createEvent(event) { await this.prisma.semaCoreEvent.create({ data: event }); return event; }
    async createAudit(entry) { await this.prisma.semaCoreAuditEntry.create({ data: entry }); return entry; }
    async upsertCapability(capability) { const row = await this.prisma.semaCoreCapability.upsert({ where: { capabilityKey: capability.capabilityKey }, create: capability, update: { displayName: capability.displayName, description: capability.description, providerKey: capability.providerKey, version: capability.version, status: capability.status, metadata: capability.metadata } }); return { ...capability, id: row.id, metadata: object(row.metadata), status: row.status }; }
    async findCapability(capabilityKey) { const row = await this.prisma.semaCoreCapability.findUnique({ where: { capabilityKey } }); return row ? { ...row, metadata: object(row.metadata), status: row.status } : null; }
    async listCapabilities(query) { const rows = await this.prisma.semaCoreCapability.findMany({ where: { status: 'ACTIVE', ...(query ? { OR: [{ capabilityKey: { contains: query, mode: 'insensitive' } }, { displayName: { contains: query, mode: 'insensitive' } }] } : {}) }, orderBy: { displayName: 'asc' } }); return rows.map((row) => ({ ...row, metadata: object(row.metadata), status: row.status })); }
    async getHostSettings() { const row = await this.prisma.semaCoreHostSettings.findFirst(); return row ? { installationId: row.installationId, revision: row.revision, updatedAt: row.updatedAt, updatedById: row.updatedById, values: object(row.values) } : null; }
    async saveHostSettings(settings) { const values = settings.values; const row = await this.prisma.semaCoreHostSettings.upsert({ where: { installationId: settings.installationId }, create: { ...settings, values }, update: { revision: settings.revision, updatedAt: settings.updatedAt, updatedById: settings.updatedById, values } }); return { installationId: row.installationId, revision: row.revision, updatedAt: row.updatedAt, updatedById: row.updatedById, values: object(row.values) }; }
    async getCapabilitiesForHost() { const rows = await this.prisma.semaCoreCapability.findMany({ orderBy: { displayName: 'asc' } }); return rows.map((row) => ({ ...row, metadata: object(row.metadata), status: row.status })); }
    async getHostStatistics() {
        const [state, identifiers, reservations, commandRows, executionRows, results, events, auditEntries, capabilityRows] = await Promise.all([this.prisma.semaCoreIdentityState.findUnique({ where: { stateKey: STATE_KEY } }), this.prisma.semaIssuedIdentifier.groupBy({ by: ['status'], _count: true }), this.prisma.semaIdentifierReservation.count(), this.prisma.semaCoreCommand.groupBy({ by: ['status'], _count: true }), this.prisma.semaCoreExecution.groupBy({ by: ['status'], _count: true }), this.prisma.semaCoreResult.count(), this.prisma.semaCoreEvent.count(), this.prisma.semaCoreAuditEntry.count(), this.prisma.semaCoreCapability.groupBy({ by: ['status'], _count: true })]);
        if (!state)
            throw new Error('SEMA Core is not initialized');
        const commands = counts();
        const executions = counts();
        for (const row of commandRows)
            if (row.status in commands)
                commands[row.status] = row._count;
        for (const row of executionRows)
            if (row.status in executions)
                executions[row.status] = row._count;
        const byStatus = (rows, status) => rows.find((row) => row.status === status)?._count ?? 0;
        return { installationId: state.installationId, status: state.status, nextLocalId: state.nextLocalId, identifiers: { reserved: byStatus(identifiers, 'RESERVED'), issued: byStatus(identifiers, 'ISSUED'), reservations }, commands, executions, results, events, auditEntries, capabilities: { active: byStatus(capabilityRows, 'ACTIVE'), inactive: byStatus(capabilityRows, 'INACTIVE'), deprecated: byStatus(capabilityRows, 'DEPRECATED') }, capturedAt: new Date() };
    }
}
//# sourceMappingURL=prisma-host-store.js.map