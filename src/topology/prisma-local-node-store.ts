import { PrismaClient } from '@prisma/client';
import { isNodeType, type LocalNode, type LocalNodeStore } from './local-nodes.js';

type Row = { id: string; type: string; parentId: string | null; parentAddress: string | null; basis: string; issued: bigint; childCount: number; status: string };
const nodeType = (row: Row) => { if (!isNodeType(row.type)) throw new Error(`Node ${row.id} has an unknown type: ${row.type}`); return row.type; };
const toNode = (row: Row): LocalNode => ({ id: row.id, type: nodeType(row), ...(row.parentId ? { parentId: row.parentId } : {}), ...(row.parentAddress ? { parentAddress: row.parentAddress } : {}), basis: row.basis, issued: BigInt(row.issued), childCount: Number(row.childCount), status: row.status === 'RETIRED' ? 'RETIRED' : 'ACTIVE' });

/** PostgreSQL store for the nodes held by this Core. Plain SQL: the table is tiny and rows are locked while they change. A node's type is written once, on insert. */
export class PrismaLocalNodeStore implements LocalNodeStore {
  constructor(private readonly prisma: PrismaClient) {}
  async get(id: string) {
    const rows = await this.prisma.$queryRaw<Row[]>`SELECT "id", "type", "parentId", "parentAddress", "basis", "issued", "childCount", "status" FROM "sema_local_nodes" WHERE "id" = ${id}`;
    return rows[0] ? toNode(rows[0]) : undefined;
  }
  async list() {
    const rows = await this.prisma.$queryRaw<Row[]>`SELECT "id", "type", "parentId", "parentAddress", "basis", "issued", "childCount", "status" FROM "sema_local_nodes" ORDER BY "id"`;
    return rows.map(toNode);
  }
  async insert(node: LocalNode) {
    const inserted = await this.prisma.$executeRaw`
      INSERT INTO "sema_local_nodes" ("id", "type", "parentId", "parentAddress", "basis", "issued", "childCount", "status", "createdAt", "updatedAt")
      VALUES (${node.id}, ${node.type}, ${node.parentId ?? null}, ${node.parentAddress ?? null}, ${node.basis}, ${node.issued}, ${node.childCount}, ${node.status}, NOW(), NOW())
      ON CONFLICT ("id") DO NOTHING`;
    if (inserted !== 1) throw new Error(`Node already exists: ${node.id}`);
  }
  async mutate<T>(id: string, change: (node: LocalNode) => { node: LocalNode; result: T }) {
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Row[]>`SELECT "id", "type", "parentId", "parentAddress", "basis", "issued", "childCount", "status" FROM "sema_local_nodes" WHERE "id" = ${id} FOR UPDATE`;
      if (!rows[0]) throw new Error(`Node does not exist on this Core: ${id}`);
      const { node, result } = change(toNode(rows[0]));
      await tx.$executeRaw`UPDATE "sema_local_nodes" SET "parentId" = ${node.parentId ?? null}, "parentAddress" = ${node.parentAddress ?? null}, "basis" = ${node.basis}, "issued" = ${node.issued}, "childCount" = ${node.childCount}, "status" = ${node.status}, "updatedAt" = NOW() WHERE "id" = ${id}`;
      return result;
    });
  }
}
