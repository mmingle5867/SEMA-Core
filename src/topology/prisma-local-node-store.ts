import { PrismaClient } from '@prisma/client';
import { isNodeType, type ChildEntry, type KeyLimits, type LocalNode, type LocalNodeStore, type NodeType, type Shutdown, type Suspension } from './local-nodes.js';

type Row = { id: string; type: string; parentId: string | null; parentAddress: string | null; basis: string; issued: bigint; childListComplete: boolean; status: string; maxSegments: number | null; maxSegmentLength: number | null; maxLastSegmentLength: number | null; nextBasis: string | null; switchAt: bigint | null; shutdownNodeId: string | null; shutdownReason: string | null; shutdownBy: string | null; shutdownAt: Date | null; shutdownVia: string | null };
const limitsOf = (row: Row): KeyLimits | undefined => { const limits: KeyLimits = { ...(row.maxSegments !== null ? { maxSegments: Number(row.maxSegments) } : {}), ...(row.maxSegmentLength !== null ? { maxSegmentLength: Number(row.maxSegmentLength) } : {}), ...(row.maxLastSegmentLength !== null ? { maxLastSegmentLength: Number(row.maxLastSegmentLength) } : {}) }; return Object.keys(limits).length ? limits : undefined; };
const shutdownOf = (row: Row): Shutdown | undefined => row.shutdownNodeId && row.shutdownReason && row.shutdownAt ? { nodeId: row.shutdownNodeId, reason: row.shutdownReason, ...(row.shutdownBy ? { by: row.shutdownBy } : {}), at: new Date(row.shutdownAt).toISOString(), via: row.shutdownVia === 'PARENT' ? 'PARENT' : 'ORDER' } : undefined;
type ChildRow = { childId: string; childType: string; childAddress: string | null; lastSeenAt: Date | null; suspendedReason: string | null; suspendedBy: string | null; suspendedAt: Date | null };
const suspensionOf = (row: Pick<ChildRow, 'suspendedReason' | 'suspendedBy' | 'suspendedAt'>): Suspension | undefined => row.suspendedReason && row.suspendedAt ? { reason: row.suspendedReason, ...(row.suspendedBy ? { by: row.suspendedBy } : {}), at: new Date(row.suspendedAt).toISOString() } : undefined;
const nodeType = (id: string, type: string) => { if (!isNodeType(type)) throw new Error(`Node ${id} has an unknown type: ${type}`); return type; };
const toNode = (row: Row): LocalNode => ({ id: row.id, type: nodeType(row.id, row.type), ...(limitsOf(row) ? { keyLimits: limitsOf(row) } : {}), ...(shutdownOf(row) ? { shutdown: shutdownOf(row) } : {}), ...(row.nextBasis && row.switchAt !== null ? { nextBasis: row.nextBasis, switchAt: BigInt(row.switchAt) } : {}), ...(row.parentId ? { parentId: row.parentId } : {}), ...(row.parentAddress ? { parentAddress: row.parentAddress } : {}), basis: row.basis, issued: BigInt(row.issued), childListComplete: Boolean(row.childListComplete), status: row.status === 'RETIRED' ? 'RETIRED' : 'ACTIVE' });
const toChild = (row: ChildRow): ChildEntry => ({ childId: row.childId, type: nodeType(row.childId, row.childType), ...(row.childAddress ? { address: row.childAddress } : {}), ...(row.lastSeenAt ? { lastSeenAt: new Date(row.lastSeenAt).toISOString() } : {}), ...(suspensionOf(row) ? { suspension: suspensionOf(row) } : {}) });
type Tx = Pick<PrismaClient, '$executeRaw' | '$queryRaw'>;

async function writeChildren(tx: Tx, id: string, entries: ChildEntry[]) {
  for (const child of entries) {
    await tx.$executeRaw`
      INSERT INTO "sema_local_node_children" ("parentId", "childId", "childType", "childAddress", "addedAt")
      VALUES (${id}, ${child.childId}, ${child.type}, ${child.address ?? null}, NOW())
      ON CONFLICT ("parentId", "childId") DO UPDATE SET "childType" = EXCLUDED."childType", "childAddress" = EXCLUDED."childAddress"`;
  }
}

/**
 * PostgreSQL store for the nodes held by this Core and their lists of children. Plain SQL: the tables are small,
 * and a node's row is locked while it or its list changes. A node's type is written once, on insert.
 */
export class PrismaLocalNodeStore implements LocalNodeStore {
  constructor(private readonly prisma: PrismaClient) {}
  async get(id: string) {
    const rows = await this.prisma.$queryRaw<Row[]>`SELECT "id", "type", "parentId", "parentAddress", "basis", "issued", "childListComplete", "status", "maxSegments", "maxSegmentLength", "maxLastSegmentLength", "nextBasis", "switchAt", "shutdownNodeId", "shutdownReason", "shutdownBy", "shutdownAt", "shutdownVia" FROM "sema_local_nodes" WHERE "id" = ${id}`;
    return rows[0] ? toNode(rows[0]) : undefined;
  }
  async list() {
    const rows = await this.prisma.$queryRaw<Row[]>`SELECT "id", "type", "parentId", "parentAddress", "basis", "issued", "childListComplete", "status", "maxSegments", "maxSegmentLength", "maxLastSegmentLength", "nextBasis", "switchAt", "shutdownNodeId", "shutdownReason", "shutdownBy", "shutdownAt", "shutdownVia" FROM "sema_local_nodes" ORDER BY "id"`;
    return rows.map(toNode);
  }
  async insert(node: LocalNode) {
    const inserted = await this.prisma.$executeRaw`
      INSERT INTO "sema_local_nodes" ("id", "type", "parentId", "parentAddress", "basis", "issued", "childListComplete", "status", "maxSegments", "maxSegmentLength", "maxLastSegmentLength", "nextBasis", "switchAt", "shutdownNodeId", "shutdownReason", "shutdownBy", "shutdownAt", "shutdownVia", "createdAt", "updatedAt")
      VALUES (${node.id}, ${node.type}, ${node.parentId ?? null}, ${node.parentAddress ?? null}, ${node.basis}, ${node.issued}, ${node.childListComplete}, ${node.status}, ${node.keyLimits?.maxSegments ?? null}, ${node.keyLimits?.maxSegmentLength ?? null}, ${node.keyLimits?.maxLastSegmentLength ?? null}, ${node.nextBasis ?? null}, ${node.switchAt ?? null}, ${node.shutdown?.nodeId ?? null}, ${node.shutdown?.reason ?? null}, ${node.shutdown?.by ?? null}, (${node.shutdown?.at ?? null}::timestamptz AT TIME ZONE 'UTC'), ${node.shutdown?.via ?? null}, NOW(), NOW())
      ON CONFLICT ("id") DO NOTHING`;
    if (inserted !== 1) throw new Error(`Node already exists: ${node.id}`);
  }
  async mutate<T>(id: string, change: (node: LocalNode) => { node: LocalNode; result: T; addChildren?: ChildEntry[] }) {
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Row[]>`SELECT "id", "type", "parentId", "parentAddress", "basis", "issued", "childListComplete", "status", "maxSegments", "maxSegmentLength", "maxLastSegmentLength", "nextBasis", "switchAt", "shutdownNodeId", "shutdownReason", "shutdownBy", "shutdownAt", "shutdownVia" FROM "sema_local_nodes" WHERE "id" = ${id} FOR UPDATE`;
      if (!rows[0]) throw new Error(`Node does not exist on this Core: ${id}`);
      const { node, result, addChildren } = change(toNode(rows[0]));
      await tx.$executeRaw`UPDATE "sema_local_nodes" SET "parentId" = ${node.parentId ?? null}, "parentAddress" = ${node.parentAddress ?? null}, "basis" = ${node.basis}, "issued" = ${node.issued}, "childListComplete" = ${node.childListComplete}, "status" = ${node.status}, "maxSegments" = ${node.keyLimits?.maxSegments ?? null}, "maxSegmentLength" = ${node.keyLimits?.maxSegmentLength ?? null}, "maxLastSegmentLength" = ${node.keyLimits?.maxLastSegmentLength ?? null}, "nextBasis" = ${node.nextBasis ?? null}, "switchAt" = ${node.switchAt ?? null}, "shutdownNodeId" = ${node.shutdown?.nodeId ?? null}, "shutdownReason" = ${node.shutdown?.reason ?? null}, "shutdownBy" = ${node.shutdown?.by ?? null}, "shutdownAt" = (${node.shutdown?.at ?? null}::timestamptz AT TIME ZONE 'UTC'), "shutdownVia" = ${node.shutdown?.via ?? null}, "updatedAt" = NOW() WHERE "id" = ${id}`;
      if (addChildren?.length) await writeChildren(tx, id, addChildren);
      return result;
    });
  }
  async children(id: string) {
    const rows = await this.prisma.$queryRaw<ChildRow[]>`SELECT "childId", "childType", "childAddress", "lastSeenAt", "suspendedReason", "suspendedBy", "suspendedAt" FROM "sema_local_node_children" WHERE "parentId" = ${id} ORDER BY "addedAt", "childId"`;
    return rows.map(toChild);
  }
  async countChildren() {
    const rows = await this.prisma.$queryRaw<Array<{ parentId: string; count: number }>>`SELECT "parentId", COUNT(*)::int AS "count" FROM "sema_local_node_children" GROUP BY "parentId"`;
    return new Map(rows.map((row) => [row.parentId, Number(row.count)]));
  }
  async addChildren(id: string, entries: ChildEntry[]) {
    await this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ status: string }>>`SELECT "status" FROM "sema_local_nodes" WHERE "id" = ${id} FOR UPDATE`;
      if (!rows[0]) throw new Error(`Node does not exist on this Core: ${id}`);
      if (rows[0].status !== 'ACTIVE') throw new Error(`Node is retired: ${id}`);
      await writeChildren(tx, id, entries);
    });
  }
  async removeChild(id: string, childId: string) {
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "sema_local_nodes" WHERE "id" = ${id} FOR UPDATE`;
      if (!rows[0]) throw new Error(`Node does not exist on this Core: ${id}`);
      return (await tx.$executeRaw`DELETE FROM "sema_local_node_children" WHERE "parentId" = ${id} AND "childId" = ${childId}`) === 1;
    });
  }
  async checkIn(id: string, child: ChildEntry, at: Date) {
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ status: string }>>`SELECT "status" FROM "sema_local_nodes" WHERE "id" = ${id} FOR UPDATE`;
      if (!rows[0]) throw new Error(`Node does not exist on this Core: ${id}`);
      if (rows[0].status !== 'ACTIVE') throw new Error(`Node is retired: ${id}`);
      // The column has no time zone: the time is written as UTC, which is how it is read back.
      const stamped = await tx.$queryRaw<Array<Pick<ChildRow, 'suspendedReason' | 'suspendedBy' | 'suspendedAt'>>>`UPDATE "sema_local_node_children" SET "lastSeenAt" = (${at.toISOString()}::timestamptz AT TIME ZONE 'UTC') WHERE "parentId" = ${id} AND "childId" = ${child.childId} RETURNING "suspendedReason", "suspendedBy", "suspendedAt"`;
      if (stamped[0]) { const suspension = suspensionOf(stamped[0]); return { added: false, ...(suspension ? { suspension } : {}) }; }
      await tx.$executeRaw`
        INSERT INTO "sema_local_node_children" ("parentId", "childId", "childType", "childAddress", "addedAt", "lastSeenAt")
        VALUES (${id}, ${child.childId}, ${child.type}, ${child.address ?? null}, NOW(), (${at.toISOString()}::timestamptz AT TIME ZONE 'UTC'))`;
      return { added: true };
    });
  }
  async markChild(id: string, child: { childId: string; type?: NodeType; address?: string }, suspension: Suspension | null) {
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "sema_local_nodes" WHERE "id" = ${id} FOR UPDATE`;
      if (!rows[0]) throw new Error(`Node does not exist on this Core: ${id}`);
      const updated = await tx.$executeRaw`UPDATE "sema_local_node_children" SET "suspendedReason" = ${suspension?.reason ?? null}, "suspendedBy" = ${suspension?.by ?? null}, "suspendedAt" = (${suspension?.at ?? null}::timestamptz AT TIME ZONE 'UTC') WHERE "parentId" = ${id} AND "childId" = ${child.childId}`;
      if (updated === 1) return true;
      if (!suspension) return false;
      if (!child.type) throw new Error(`${child.childId} is not on the list of ${id}, and its type is not known`);
      await tx.$executeRaw`
        INSERT INTO "sema_local_node_children" ("parentId", "childId", "childType", "childAddress", "addedAt", "suspendedReason", "suspendedBy", "suspendedAt")
        VALUES (${id}, ${child.childId}, ${child.type}, ${child.address ?? null}, NOW(), ${suspension.reason}, ${suspension.by ?? null}, (${suspension.at}::timestamptz AT TIME ZONE 'UTC'))`;
      return true;
    });
  }
}
