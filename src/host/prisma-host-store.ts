import { Prisma, PrismaClient } from '@prisma/client';
import { encodeBase56, formatKeyId, normalizeTypeCode } from '../identity/base56.js';
import type { CoreAuditEntry, CoreCapability, CoreCommand, CoreEvent, CoreExecution, CoreResult, JsonObject, SemaCoreStore, SemaIdentifier, SemaIdentifierReservation } from '../index.js';
import type { CoreHostStatistics, CoreHostStore, VersionedCoreHostSettings } from './types.js';

const STATE_KEY = 'PRIMARY';
type Db = Prisma.TransactionClient;
const object = (value: Prisma.JsonValue | null): JsonObject => value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
const strings = (value: Prisma.JsonValue): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
const counts = () => ({ PENDING: 0, RUNNING: 0, WAITING: 0, CANCELLED: 0, FAILED: 0, SUCCESS: 0 });

/**
 * The machine's own node is the single source of truth for the prefix and counter that every ID this Core
 * issues is built from. A roll-up of the machine node changes the prefix and restarts the counter here too.
 */
async function reserve(tx: Db, input: { count: number; typeCode?: string; metadata: JsonObject }) {
  const rows = await tx.$queryRaw<Array<{ installationId: string; localValue: bigint }>>`
    UPDATE "sema_local_nodes" AS n SET "issued" = n."issued" + ${BigInt(input.count)}, "updatedAt" = NOW()
    FROM "sema_core_identity_state" AS s
    WHERE s."stateKey" = ${STATE_KEY} AND s."status" = 'ACTIVE' AND n."id" = s."installationId" AND n."status" = 'ACTIVE'
    RETURNING n."basis" AS "installationId", n."issued" - ${BigInt(input.count)} + 1 AS "localValue"
  `;
  const first = rows[0];
  if (!first) throw new Error('SEMA Core KeyID allocator is unavailable');
  const reservationId = formatKeyId({ installationId: first.installationId, localValue: first.localValue });
  const typeCode = input.typeCode ? normalizeTypeCode(input.typeCode) : undefined;
  const reservation: SemaIdentifierReservation = { id: reservationId, installationId: first.installationId, firstLocalValue: first.localValue, count: input.count, typeCode, metadata: input.metadata, createdAt: new Date() };
  await tx.semaIdentifierReservation.create({ data: { ...reservation, metadata: input.metadata } });
  const identifiers: SemaIdentifier[] = [];
  for (let index = 0; index < input.count; index += 1) {
    const localValue = first.localValue + BigInt(index);
    const id = formatKeyId({ installationId: first.installationId, localValue });
    await tx.semaIssuedIdentifier.create({ data: { semaId: id, reservationId, installationId: first.installationId, localValue, localCode: encodeBase56(localValue), typeCode, status: 'RESERVED', metadata: input.metadata } });
    identifiers.push({ id, reservationId, installationId: first.installationId, localValue, localCode: encodeBase56(localValue), typeCode, status: 'RESERVED', metadata: input.metadata });
  }
  return { reservation, identifiers };
}

/** PostgreSQL-backed shared Core store. It contains Core records only. */
export class PrismaSemaCoreHostStore implements SemaCoreStore, CoreHostStore {
  constructor(private readonly prisma = new PrismaClient()) {}
  async disconnect() { await this.prisma.$disconnect(); }
  /** This machine's node: its current basis and how many values it has issued from it. */
  private async machineNode() {
    const rows = await this.prisma.$queryRaw<Array<{ basis: string; issued: bigint; status: string }>>`
      SELECT n."basis", n."issued", n."status" FROM "sema_local_nodes" n JOIN "sema_core_identity_state" s ON s."installationId" = n."id" WHERE s."stateKey" = ${STATE_KEY}`;
    const row = rows[0];
    if (!row || row.status !== 'ACTIVE') throw new Error('SEMA Core machine node is unavailable');
    return { basis: row.basis, issued: BigInt(row.issued) };
  }
  /** The node this Core is, once it has an identity. Undefined on a Core that has not joined a system yet. */
  async storedInstallationId() {
    const state = await this.prisma.semaCoreIdentityState.findUnique({ where: { stateKey: STATE_KEY } });
    return state?.installationId;
  }
  /**
   * Gives a Core that has none its identity: the node ID another Core issued for it, and the parent that issued it.
   * Both records are written together, and only once: a Core that already has an identity refuses.
   */
  async joinSystem(input: { id: string; parentId: string; parentAddress?: string }) {
    await this.prisma.$transaction(async (tx) => {
      const created = await tx.$executeRaw`
        INSERT INTO "sema_core_identity_state" ("stateKey", "installationId", "nextLocalId", "status", "updatedAt")
        VALUES (${STATE_KEY}, ${input.id}, 1, 'ACTIVE', NOW())
        ON CONFLICT ("stateKey") DO NOTHING`;
      if (created !== 1) throw new Error('This Core has already joined a system');
      const recorded = await tx.$executeRaw`
        INSERT INTO "sema_local_nodes" ("id", "type", "parentId", "parentAddress", "basis", "issued", "childCount", "status", "createdAt", "updatedAt")
        VALUES (${input.id}, 'MACHINE', ${input.parentId}, ${input.parentAddress ?? null}, ${input.id}, 0, 0, 'ACTIVE', NOW(), NOW())
        ON CONFLICT ("id") DO NOTHING`;
      if (recorded !== 1) throw new Error(`Node already exists: ${input.id}`);
    });
    return { id: input.id, type: 'MACHINE' as const, parentId: input.parentId, ...(input.parentAddress ? { parentAddress: input.parentAddress } : {}), basis: input.id, childCount: 0, status: 'ACTIVE' as const };
  }
  async initializeIdentity(installationId: string) {
    const state = await this.prisma.semaCoreIdentityState.upsert({ where: { stateKey: STATE_KEY }, update: {}, create: { stateKey: STATE_KEY, installationId, nextLocalId: BigInt(1) } });
    if (state.installationId !== installationId || state.status !== 'ACTIVE') throw new Error('SEMA Core installation is unavailable');
    // The machine node is created on first start from the existing counter, so IDs already issued are untouched. Its type is MACHINE.
    await this.prisma.$executeRaw`
      INSERT INTO "sema_local_nodes" ("id", "type", "parentId", "parentAddress", "basis", "issued", "childCount", "status", "createdAt", "updatedAt")
      VALUES (${installationId}, 'MACHINE', NULL, NULL, ${installationId}, ${state.nextLocalId - BigInt(1)}, 0, 'ACTIVE', NOW(), NOW())
      ON CONFLICT ("id") DO NOTHING`;
    const node = await this.machineNode();
    return { installationId: state.installationId, nextLocalId: node.issued + BigInt(1), status: state.status as 'ACTIVE' | 'SUSPENDED' };
  }
  async reserveIdentifiers(input: { count: number; typeCode?: string; metadata: JsonObject }) { return this.prisma.$transaction((tx) => reserve(tx, input)); }
  async consumeReservedIdentifier(reservationId: string, id: string, metadata: JsonObject = {}) {
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.semaIssuedIdentifier.findUnique({ where: { semaId: id } });
      if (!row || row.reservationId !== reservationId) throw new Error('Identifier is not in this reservation');
      if (row.status !== 'RESERVED') throw new Error('Identifier has already been consumed');
      const updated = await tx.semaIssuedIdentifier.update({ where: { semaId: id }, data: { status: 'ISSUED', consumedAt: new Date(), metadata: { ...object(row.metadata), ...metadata } } });
      return { id: updated.semaId, reservationId, installationId: updated.installationId, localValue: updated.localValue, localCode: updated.localCode, typeCode: updated.typeCode ?? undefined, status: 'ISSUED' as const, metadata: object(updated.metadata) };
    });
  }
  async createCommand(command: CoreCommand) { await this.prisma.semaCoreCommand.create({ data: command }); return command; }
  async updateCommand(id: string, update: Partial<Pick<CoreCommand, 'status'>>) { const row = await this.prisma.semaCoreCommand.update({ where: { id }, data: update }); return { ...row, subjectIds: strings(row.subjectIds), context: object(row.context), payload: object(row.payload), status: row.status as CoreCommand['status'] }; }
  async findCommand(id: string) { const row = await this.prisma.semaCoreCommand.findUnique({ where: { id } }); return row ? { ...row, subjectIds: strings(row.subjectIds), context: object(row.context), payload: object(row.payload), status: row.status as CoreCommand['status'] } : null; }
  async listCommands(input: { actorId?: string | null; commandTypePrefix?: string; status?: CoreCommand['status']; limit?: number }) { const rows = await this.prisma.semaCoreCommand.findMany({ where: { ...(input.actorId !== undefined ? { actorId: input.actorId } : {}), ...(input.commandTypePrefix ? { commandType: { startsWith: input.commandTypePrefix } } : {}), ...(input.status ? { status: input.status } : {}) }, orderBy: { createdAt: 'desc' }, take: input.limit ?? 100 }); return rows.map((row) => ({ ...row, subjectIds: strings(row.subjectIds), context: object(row.context), payload: object(row.payload), status: row.status as CoreCommand['status'] })); }
  async createExecution(execution: CoreExecution) { await this.prisma.semaCoreExecution.create({ data: { ...execution, error: execution.error ?? Prisma.JsonNull } }); return execution; }
  async updateExecution(id: string, update: Partial<Pick<CoreExecution, 'status' | 'completedAt' | 'error'>>) { const data = { ...(update.status !== undefined ? { status: update.status } : {}), ...(update.completedAt !== undefined ? { completedAt: update.completedAt } : {}), ...(update.error !== undefined ? { error: update.error ?? Prisma.JsonNull } : {}) }; const row = await this.prisma.semaCoreExecution.update({ where: { id }, data }); return { ...row, context: object(row.context), error: row.error ? object(row.error) : null, status: row.status as CoreExecution['status'] }; }
  async createResult(result: CoreResult) { await this.prisma.semaCoreResult.create({ data: result }); return result; }
  async createEvent(event: CoreEvent) { await this.prisma.semaCoreEvent.create({ data: event }); return event; }
  async createAudit(entry: CoreAuditEntry) { await this.prisma.semaCoreAuditEntry.create({ data: entry }); return entry; }
  async upsertCapability(capability: CoreCapability) { const row = await this.prisma.semaCoreCapability.upsert({ where: { capabilityKey: capability.capabilityKey }, create: capability, update: { displayName: capability.displayName, description: capability.description, providerKey: capability.providerKey, version: capability.version, status: capability.status, metadata: capability.metadata } }); return { ...capability, id: row.id, metadata: object(row.metadata), status: row.status as CoreCapability['status'] }; }
  async findCapability(capabilityKey: string) { const row = await this.prisma.semaCoreCapability.findUnique({ where: { capabilityKey } }); return row ? { ...row, metadata: object(row.metadata), status: row.status as CoreCapability['status'] } : null; }
  async listCapabilities(query: string) { const rows = await this.prisma.semaCoreCapability.findMany({ where: { status: 'ACTIVE', ...(query ? { OR: [{ capabilityKey: { contains: query, mode: 'insensitive' } }, { displayName: { contains: query, mode: 'insensitive' } }] } : {}) }, orderBy: { displayName: 'asc' } }); return rows.map((row) => ({ ...row, metadata: object(row.metadata), status: row.status as CoreCapability['status'] })); }
  async getHostSettings() { const row = await this.prisma.semaCoreHostSettings.findFirst(); return row ? { installationId: row.installationId, revision: row.revision, updatedAt: row.updatedAt, updatedById: row.updatedById, values: object(row.values) as unknown as VersionedCoreHostSettings['values'] } : null; }
  async saveHostSettings(settings: VersionedCoreHostSettings) { const values = settings.values as unknown as Prisma.InputJsonValue; const row = await this.prisma.semaCoreHostSettings.upsert({ where: { installationId: settings.installationId }, create: { ...settings, values }, update: { revision: settings.revision, updatedAt: settings.updatedAt, updatedById: settings.updatedById, values } }); return { installationId: row.installationId, revision: row.revision, updatedAt: row.updatedAt, updatedById: row.updatedById, values: object(row.values) as unknown as VersionedCoreHostSettings['values'] }; }
  async getCapabilitiesForHost() { const rows = await this.prisma.semaCoreCapability.findMany({ orderBy: { displayName: 'asc' } }); return rows.map((row) => ({ ...row, metadata: object(row.metadata), status: row.status as CoreCapability['status'] })); }
  async getHostStatistics(): Promise<CoreHostStatistics> {
    const [state, identifiers, reservations, commandRows, executionRows, results, events, auditEntries, capabilityRows] = await Promise.all([this.prisma.semaCoreIdentityState.findUnique({ where: { stateKey: STATE_KEY } }), this.prisma.semaIssuedIdentifier.groupBy({ by: ['status'], _count: true }), this.prisma.semaIdentifierReservation.count(), this.prisma.semaCoreCommand.groupBy({ by: ['status'], _count: true }), this.prisma.semaCoreExecution.groupBy({ by: ['status'], _count: true }), this.prisma.semaCoreResult.count(), this.prisma.semaCoreEvent.count(), this.prisma.semaCoreAuditEntry.count(), this.prisma.semaCoreCapability.groupBy({ by: ['status'], _count: true })]);
    if (!state) throw new Error('SEMA Core is not initialized');
    const machine = await this.machineNode();
    const commands = counts(); const executions = counts();
    for (const row of commandRows) if (row.status in commands) commands[row.status as keyof typeof commands] = row._count;
    for (const row of executionRows) if (row.status in executions) executions[row.status as keyof typeof executions] = row._count;
    const byStatus = (rows: Array<{ status: string; _count: number }>, status: string) => rows.find((row) => row.status === status)?._count ?? 0;
    return { installationId: state.installationId, status: state.status as 'ACTIVE' | 'SUSPENDED', nextLocalId: machine.issued + BigInt(1), identifiers: { reserved: byStatus(identifiers, 'RESERVED'), issued: byStatus(identifiers, 'ISSUED'), reservations }, commands, executions, results, events, auditEntries, capabilities: { active: byStatus(capabilityRows, 'ACTIVE'), inactive: byStatus(capabilityRows, 'INACTIVE'), deprecated: byStatus(capabilityRows, 'DEPRECATED') }, capturedAt: new Date() };
  }
}
