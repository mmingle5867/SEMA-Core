import { PrismaClient } from '@prisma/client';
import { isNodeType, type ChildEntry, type KeyLimits, type LocalNode, type LocalNodeStore } from './local-nodes.js';

type Row = { id: string; type: string; parentId: string | null; parentAddress: string | null; basis: string; issued: bigint; childListComplete: boolean; status: string; maxSegments: number | null; maxSegmentLength: number | null; maxLastSegmentLength: number | null; nextBasis: string | null; switchAt: bigint | null };
const limitsOf = (row: Row): KeyLimits | undefined => { const limits: KeyLimits = { ...(row.maxSegments !== null ? { maxSegments: Number(row.maxSegments) } : {}), ...(row.maxSegmentLength !== null ? { maxSegmentLength: Number(row.maxSegmentLength) } : {}), ...(row.maxLastSegmentLength !== null ? { maxLastSegmentLength: Number(row.maxLastSegmentLength) } : {}) }; return Object.keys(limits).length ? limits : undefined; };
type ChildRow = { childId: string; childType: string; childAddress: string | null; lastSeenAt: Date | null };
const nodeType = (id: string, type: string) => { if (!isNodeType(type)) throw new Error(`Node ${id} has an unknown type: ${type}`); return type; };
const toNode = (row: Row): LocalNode => ({ id: row.id, type: nodeType(row.id, row.type), ...(limitsOf(row) ? { keyLimits: limitsOf(row) } : {}), ...(row.nextBasis && row.switchAt !== null ? { nextBasis: row.nextBasis, switchAt: BigInt(row.switchAt) } : {}), ...(row.parentId ? { parentId: row.parentId } : {}), ...(row.parentAddress ? { parentAddress: row.parentAddress } : {}), basis: row.basis, issued: BigInt(row.issued), childListComplete: Boolean(row.childListComplete), status: row.status === 'RETIRED' ? 'RETIRED' : 'ACTIVE' });
const toChild = (row: ChildRow): ChildEntry => ({ childId: row.childId, type: nodeType(row.childId, row.childType), ...(row.childAddress ? { address: row.childAddress } : {}), ...(row.lastSeenAt ? { lastSeenAt: new Date(row.lastSeenAt).toISOString() } : {}) });
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
    const rows = await this.prisma.$queryRaw<Row[]>`SELECT "id", "type", "parentId", "parentAddress", "basis", "issued", "childListComplete", "status", "maxSegments", "maxSegmentLength", "maxLastSegmentLength", "nextBasis", "switchAt" FROM "sema_local_nodes" WHERE "id" = ${id}`;
    return rows[0] ? toNode(rows[0]) : undefined;
  }
  async list() {
    const rows = await this.prisma.$queryRaw<Row[]>`SELECT "id", "type", "parentId", "parentAddress", "basis", "issued", "childListComplete", "status", "maxSegments", "maxSegmentLength", "maxLastSegmentLength", "nextBasis", "switchAt" FROM "sema_local_nodes" ORDER BY "id"`;
    return rows.map(toNode);
  }
  async insert(node: LocalNode) {
    const inserted = await this.prisma.$executeRaw`
      INSERT INTO "sema_local_nodes" ("id", "type", "parentId", "parentAddress", "basis", "issued", "childListComplete", "status", "maxSegments", "maxSegmentLength", "maxLastSegmentLength", "nextBasis", "switchAt", "createdAt", "updatedAt")
      VALUES (${node.id}, ${node.type}, ${node.parentId ?? null}, ${node.parentAddress ?? null}, ${node.basis}, ${node.issued}, ${node.childListComplete}, ${node.status}, ${node.keyLimits?.maxSegments ?? null}, ${node.keyLimits?.maxSegmentLength ?? null}, ${node.keyLimits?.maxLastSegmentLength ?? null}, ${node.nextBasis ?? null}, ${node.switchAt ?? null}, NOW(), NOW())
      ON CONFLICT ("id") DO NOTHING`;
    if (inserted !== 1) throw new Error(`Node already exists: ${node.id}`);
  }
  async mutate<T>(id: string, change: (node: LocalNode) => { node: LocalNode; result: T; addChildren?: ChildEntry[] }) {
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Row[]>`SELECT "id", "type", "parentId", "parentAddress", "basis", "issued", "childListComplete", "status", "maxSegments", "maxSegmentLength", "maxLastSegmentLength", "nextBasis", "switchAt" FROM "sema_local_nodes" WHERE "id" = ${id} FOR UPDATE`;
      if (!rows[0]) throw new Error(`Node does not exist on this Core: ${id}`);
      const { node, result, addChildren } = change(toNode(rows[0]));
      await tx.$executeRaw`UPDATE "sema_local_nodes" SET "parentId" = ${node.parentId ?? null}, "parentAddress" = ${node.parentAddress ?? null}, "basis" = ${node.basis}, "issued" = ${node.issued}, "childListComplete" = ${node.childListComplete}, "status" = ${node.status}, "maxSegments" = ${node.keyLimits?.maxSegments ?? null}, "maxSegmentLength" = ${node.keyLimits?.maxSegmentLength ?? null}, "maxLastSegmentLength" = ${node.keyLimits?.maxLastSegmentLength ?? null}, "nextBasis" = ${node.nextBasis ?? null}, "switchAt" = ${node.switchAt ?? null}, "updatedAt" = NOW() WHERE "id" = ${id}`;
      if (addChildren?.length) await writeChildren(tx, id, addChildren);
      return result;
    });
  }
  async children(id: string) {
    const rows = await this.prisma.$queryRaw<ChildRow[]>`SELECT "childId", "childType", "childAddress", "lastSeenAt" FROM "sema_local_node_children" WHERE "parentId" = ${id} ORDER BY "addedAt", "childId"`;
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
      const stamped = await tx.$executeRaw`UPDATE "sema_local_node_children" SET "lastSeenAt" = (${at.toISOString()}::timestamptz AT TIME ZONE 'UTC') WHERE "parentId" = ${id} AND "childId" = ${child.childId}`;
      if (stamped === 1) return { added: false };
      await tx.$executeRaw`
        INSERT INTO "sema_local_node_children" ("parentId", "childId", "childType", "childAddress", "addedAt", "lastSeenAt")
        VALUES (${id}, ${child.childId}, ${child.type}, ${child.address ?? null}, NOW(), (${at.toISOString()}::timestamptz AT TIME ZONE 'UTC'))`;
      return { added: true };
    });
  }
}
