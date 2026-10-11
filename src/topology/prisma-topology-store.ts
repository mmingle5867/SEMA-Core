import { Prisma, PrismaClient } from '@prisma/client';
import type { TopologyNode, TopologyStore } from './topology.js';

type Db = PrismaClient | Prisma.TransactionClient;
type Row = { id: string; parentId: string | null; basis: string; status: string };
const toNode = (row: Row): TopologyNode => ({ id: row.id, ...(row.parentId ? { parentId: row.parentId } : {}), basis: row.basis, status: row.status === 'RETIRED' ? 'RETIRED' : 'ACTIVE' });

/**
 * PostgreSQL store for the node topology. Plain SQL is used on purpose: the counter must advance
 * atomically in one statement, and the tables are tiny.
 */
class PrismaTopologyStoreOn implements TopologyStore {
  constructor(private readonly db: Db, private readonly root: PrismaClient) {}

  async getNode(id: string) {
    const rows = await this.db.$queryRaw<Row[]>`SELECT "id", "parentId", "basis", "status" FROM "sema_topology_nodes" WHERE "id" = ${id}`;
    return rows[0] ? toNode(rows[0]) : undefined;
  }
  async putNode(node: TopologyNode) {
    await this.db.$executeRaw`
      INSERT INTO "sema_topology_nodes" ("id", "parentId", "basis", "status", "createdAt", "updatedAt")
      VALUES (${node.id}, ${node.parentId ?? null}, ${node.basis}, ${node.status}, NOW(), NOW())
      ON CONFLICT ("id") DO UPDATE SET "parentId" = EXCLUDED."parentId", "basis" = EXCLUDED."basis", "status" = EXCLUDED."status", "updatedAt" = NOW()`;
  }
  async childrenOf(parentId: string) {
    const rows = await this.db.$queryRaw<Row[]>`SELECT "id", "parentId", "basis", "status" FROM "sema_topology_nodes" WHERE "parentId" = ${parentId} ORDER BY "id"`;
    return rows.map(toNode);
  }
  async nextValue(basis: string) {
    const rows = await this.db.$queryRaw<Array<{ lastValue: bigint }>>`
      INSERT INTO "sema_topology_counters" ("basis", "lastValue") VALUES (${basis}, 1)
      ON CONFLICT ("basis") DO UPDATE SET "lastValue" = "sema_topology_counters"."lastValue" + 1
      RETURNING "lastValue"`;
    return BigInt(rows[0]!.lastValue);
  }
  async recordHolder(value: string, holderId: string) {
    const inserted = await this.db.$executeRaw`INSERT INTO "sema_topology_holders" ("value", "holderId", "issuedAt") VALUES (${value}, ${holderId}, NOW()) ON CONFLICT ("value") DO NOTHING`;
    if (inserted !== 1) throw new Error(`Value ${value} already has a holder`);
  }
  async transaction<T>(work: (store: TopologyStore) => Promise<T>): Promise<T> {
    // Already inside a transaction: join it.
    if (!('$transaction' in this.db)) return work(this);
    return this.root.$transaction((tx) => work(new PrismaTopologyStoreOn(tx, this.root)));
  }
}

export class PrismaTopologyStore extends PrismaTopologyStoreOn {
  constructor(prisma: PrismaClient) { super(prisma, prisma); }
}
