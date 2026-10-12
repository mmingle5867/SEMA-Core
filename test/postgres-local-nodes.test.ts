import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { LocalNodes } from '../src/topology/local-nodes.js';
import { PrismaLocalNodeStore } from '../src/topology/prisma-local-node-store.js';
import { PrismaSemaCoreHostStore } from '../src/host/prisma-host-store.js';

// The PostgreSQL stores, against a real database. The other tests use the in-memory stores, so a mistake
// in the SQL is only caught here. Point SEMA_CORE_TEST_DATABASE_URL at an empty, migrated database that
// is NOT the live one: this test writes nodes into it.
const url = process.env.SEMA_CORE_TEST_DATABASE_URL;
if (!url) { console.log('PostgreSQL local nodes test skipped (SEMA_CORE_TEST_DATABASE_URL is not set).'); process.exit(0); }

const prisma = new PrismaClient({ datasources: { db: { url } } });
try {
  // Core's own start-up: the machine node is created on the first start and left alone on the next.
  const host = new PrismaSemaCoreHostStore(prisma);
  await host.initializeIdentity('3');
  await host.initializeIdentity('3');
  const nodes = new LocalNodes(new PrismaLocalNodeStore(prisma));
  assert.deepEqual(await nodes.describe('3'), { id: '3', type: 'MACHINE', basis: '3', childCount: 0, status: 'ACTIVE' });

  // Every type is stored and read back, and a node cannot be recorded without one.
  for (const [id, type] of [['3-T1', 'ORGANIZATION'], ['3-T2', 'GROUP'], ['3-T3', 'USER'], ['3-T4', 'MACHINE']] as const) {
    await nodes.accept({ id, type, parentId: '3', parentAddress: 'http://parent.example:4310' });
    assert.deepEqual(await nodes.describe(id), { id, type, parentId: '3', parentAddress: 'http://parent.example:4310', basis: id, childCount: 0, status: 'ACTIVE' });
  }
  await assert.rejects(() => nodes.accept({ id: '3-T5' } as never), /ORGANIZATION, GROUP, USER or MACHINE/);
  await assert.rejects(() => nodes.accept({ id: '3-T3', type: 'USER' }), /already exists/);
  assert.deepEqual((await nodes.list()).map((node) => [node.id, node.type]), [['3', 'MACHINE'], ['3-T1', 'ORGANIZATION'], ['3-T2', 'GROUP'], ['3-T3', 'USER'], ['3-T4', 'MACHINE']]);

  // Changes keep the type: issuing, moving, rolling up and retiring.
  assert.equal((await nodes.issueChildId('3-T1')).value, '3-T1-3');
  assert.equal((await nodes.setParent('3-T3', '3-T1')).type, 'USER');
  await nodes.accept({ id: '3-T1-3-3', type: 'GROUP', parentId: '3-T1-3' });
  assert.deepEqual(await nodes.setBasis('3-T1-3-3', '3-T9'), { previousBasis: '3-T1-3-3', basis: '3-T9' });
  assert.equal((await nodes.adjustChildCount('3-T1', 1)).childCount, 2);
  await nodes.retire('3-T3');
  assert.deepEqual(await nodes.describe('3-T3'), { id: '3-T3', type: 'USER', parentId: '3-T1', basis: '3-T3', childCount: 0, status: 'RETIRED' });

  // A row with a type Core does not know is reported, never read as something else.
  await prisma.$executeRaw`UPDATE "sema_local_nodes" SET "type" = 'PRINTER' WHERE "id" = '3-T4'`;
  await assert.rejects(() => nodes.describe('3-T4'), /unknown type/);
  console.log('PostgreSQL local nodes test passed.');
} finally {
  await prisma.$disconnect();
}
