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
  const host = new PrismaSemaCoreHostStore(prisma);
  // This test empties the node tables part-way, so it refuses any database that already has an identity.
  assert.equal(await host.storedInstallationId(), undefined, 'the test database must be empty: it must never be the live one');

  // A new machine joins: another Core issued its ID, and it records its identity and its machine node together, once.
  assert.deepEqual(await host.joinSystem({ id: '3-J', parentId: '3', parentAddress: 'http://parent.example:4310' }), { id: '3-J', type: 'MACHINE', parentId: '3', parentAddress: 'http://parent.example:4310', basis: '3-J', childCount: 0, status: 'ACTIVE' });
  assert.equal(await host.storedInstallationId(), '3-J');
  await assert.rejects(() => host.joinSystem({ id: '3-K', parentId: '3' }), /already joined/);
  assert.equal(await host.storedInstallationId(), '3-J', 'a second join changes nothing');
  // Starting afterwards keeps the node as it was recorded, with its parent, and issues from it.
  assert.equal((await host.initializeIdentity('3-J')).installationId, '3-J');
  await assert.rejects(() => host.initializeIdentity('3'), /unavailable/);
  assert.deepEqual(await new LocalNodes(new PrismaLocalNodeStore(prisma)).describe('3-J'), { id: '3-J', type: 'MACHINE', parentId: '3', parentAddress: 'http://parent.example:4310', basis: '3-J', childCount: 0, status: 'ACTIVE' });
  assert.equal((await host.reserveIdentifiers({ count: 1, metadata: {} })).identifiers[0].id, '3-J-3', 'a joined machine issues its IDs from its own node');
  // How an ID this Core issued was recorded, read back by ID; an ID it never issued has no record.
  assert.deepEqual(await host.issuedIdentifier('3-J-3'), { id: '3-J-3', reservationId: (await host.issuedIdentifier('3-J-3'))!.reservationId, installationId: '3-J', localValue: BigInt(1), localCode: '3', typeCode: undefined, status: 'RESERVED', metadata: {} });
  assert.equal(await host.issuedIdentifier('3-J-9'), undefined);
  // A ready basis on the machine node takes over inside the same statement that reserves ordinary IDs.
  const machineNodes = new LocalNodes(new PrismaLocalNodeStore(prisma));
  assert.equal((await machineNodes.setNextBasis('3-J', { basis: '3-Q', switchAt: 2 })).nextBasis, '3-Q');
  assert.equal((await host.reserveIdentifiers({ count: 1, metadata: {} })).identifiers[0].id, '3-J-4', 'value 2 is still within the limit');
  assert.deepEqual((await host.reserveIdentifiers({ count: 2, metadata: {} })).identifiers.map((identifier) => identifier.id), ['3-Q-3', '3-Q-4'], 'passing the limit switches to the ready basis first');
  const switched = (await machineNodes.describe('3-J'))!;
  assert.deepEqual([switched.id, switched.basis, switched.nextBasis, switched.switchAt], ['3-J', '3-Q', undefined, undefined], 'the node keeps its ID; the ready basis is used up');
  assert.equal((await host.issuedIdentifier('3-Q-3'))!.installationId, '3-Q', 'an ID records the basis it came from');
  assert.equal((await machineNodes.issueChildId('3-J', { type: 'USER' }).catch((error: Error) => error.message)), 'A USER cannot sit under a MACHINE. A MACHINE has no children in the tree', 'a machine still issues no children');

  // Back to an empty database for the rest: the first node of a new system.
  await prisma.$executeRaw`DELETE FROM "sema_issued_identifiers"`;
  await prisma.$executeRaw`DELETE FROM "sema_identifier_reservations"`;
  await prisma.$executeRaw`DELETE FROM "sema_local_nodes"`;
  await prisma.$executeRaw`DELETE FROM "sema_core_identity_state"`;

  // The block of first IDs a Core may assign: none until one is granted, then it counts up to the end and stops.
  assert.equal(await host.topLevelBlock(), undefined);
  assert.equal(await host.issueTopLevelValue(), undefined, 'a Core with no block assigns nothing');
  await host.grantTopLevelBlock({ block: 0, start: BigInt(2), end: BigInt(5) });
  assert.deepEqual(await host.topLevelBlock(), { block: 0, issued: BigInt(1), end: BigInt(5) });
  await assert.rejects(() => host.grantTopLevelBlock({ block: 1, start: BigInt(1_000_000), end: BigInt(2_000_000) }), /values left/);
  assert.deepEqual([await host.issueTopLevelValue(), await host.issueTopLevelValue(), await host.issueTopLevelValue()], [BigInt(2), BigInt(3), BigInt(4)]);
  assert.equal(await host.issueTopLevelValue(), undefined, 'it stops at the end of its block');
  assert.deepEqual(await host.topLevelBlock(), { block: 0, issued: BigInt(4), end: BigInt(5) });
  await host.grantTopLevelBlock({ block: 1, start: BigInt(1_000_000), end: BigInt(2_000_000) });
  assert.equal(await host.issueTopLevelValue(), BigInt(1_000_000), 'a used-up block can be replaced by another');

  // Core's own start-up: the machine node is created on the first start and left alone on the next.
  await host.initializeIdentity('3');
  await host.initializeIdentity('3');
  const nodes = new LocalNodes(new PrismaLocalNodeStore(prisma));
  assert.deepEqual(await nodes.describe('3'), { id: '3', type: 'MACHINE', basis: '3', childCount: 0, status: 'ACTIVE' });

  // Every type is stored and read back, and a node cannot be recorded without one.
  for (const [id, type] of [['3-T1', 'ORGANIZATION'], ['3-T2', 'GROUP'], ['3-T3', 'USER'], ['3-T4', 'MACHINE'], ['3-T6', 'SITE']] as const) {
    await nodes.accept({ id, type, parentId: '3', parentAddress: 'http://parent.example:4310' });
    assert.deepEqual(await nodes.describe(id), { id, type, parentId: '3', parentAddress: 'http://parent.example:4310', basis: id, childCount: 0, status: 'ACTIVE' });
  }
  await assert.rejects(() => nodes.accept({ id: '3-T5' } as never), /ORGANIZATION, GROUP, SITE, USER or MACHINE/);
  await assert.rejects(() => nodes.accept({ id: '3-T3', type: 'USER' }), /already exists/);
  assert.deepEqual((await nodes.list()).map((node) => [node.id, node.type]), [['3', 'MACHINE'], ['3-T1', 'ORGANIZATION'], ['3-T2', 'GROUP'], ['3-T3', 'USER'], ['3-T4', 'MACHINE'], ['3-T6', 'SITE']]);

  assert.equal((await nodes.listWithNextId()).find((node) => node.id === '3-T1')!.nextId, '3-T1-3');

  // Key limits are stored on an organization node, read back, kept through other changes, and cleared.
  assert.deepEqual((await nodes.setKeyLimits('3-T1', { maxSegments: 4, maxLastSegmentLength: 6 })).keyLimits, { maxSegments: 4, maxLastSegmentLength: 6 });
  assert.deepEqual((await nodes.describe('3-T1'))!.keyLimits, { maxSegments: 4, maxLastSegmentLength: 6 });
  assert.equal((await nodes.describe('3-T2'))!.keyLimits, undefined);

  // Changes keep the type: issuing, moving, rolling up and retiring.
  assert.deepEqual(await nodes.issueChildId('3-T1', { type: 'GROUP', address: 'http://child.example:4310' }), { value: '3-T1-3', childCount: 1 });
  assert.deepEqual(await nodes.children('3-T1'), [{ childId: '3-T1-3', type: 'GROUP', address: 'http://child.example:4310' }], 'an issued child is on the list in the same step');
  assert.equal((await nodes.setParent('3-T3', '3-T1')).type, 'USER');
  await nodes.accept({ id: '3-T1-3-3', type: 'GROUP', parentId: '3-T1-3' });
  assert.deepEqual(await nodes.setBasis('3-T1-3-3', '3-T9'), { previousBasis: '3-T1-3-3', basis: '3-T9' });
  assert.deepEqual(await nodes.addChildren('3-T1', [{ childId: '3-T3', type: 'USER' }, { childId: '3-T1-3', type: 'GROUP', address: 'http://moved.example:4310' }]), { childCount: 2 }, 'adding an entry already there updates it');
  assert.equal((await nodes.children('3-T1')).find((child) => child.childId === '3-T1-3')!.address, 'http://moved.example:4310');
  assert.deepEqual((await nodes.list()).find((node) => node.id === '3-T1')!.childCount, 2);
  assert.deepEqual(await nodes.removeChild('3-T1', '3-T1-3'), { removed: true, childCount: 1 });
  assert.deepEqual(await nodes.removeChild('3-T1', '3-T1-3'), { removed: false, childCount: 1 });
  assert.deepEqual(await nodes.setChildListComplete('3-T2', false), { childListComplete: false });
  assert.equal((await nodes.describe('3-T2'))!.childListIncomplete, true);
  await nodes.setChildListComplete('3-T2', true);
  assert.equal((await nodes.describe('3-T2'))!.childListIncomplete, undefined);
  assert.deepEqual(await nodes.retire('3-T1'), { parentId: '3', parentAddress: 'http://parent.example:4310', children: [{ childId: '3-T3', type: 'USER' }], childListComplete: true });
  assert.deepEqual(await nodes.describe('3-T1'), { id: '3-T1', type: 'ORGANIZATION', parentId: '3', parentAddress: 'http://parent.example:4310', basis: '3-T1', childCount: 1, keyLimits: { maxSegments: 4, maxLastSegmentLength: 6 }, status: 'RETIRED' }, 'a retired node keeps its list, and its limits survived every change');
  await assert.rejects(() => nodes.addChildren('3-T1', [{ childId: '3-T8', type: 'USER' }]), /retired/);

  // A check-in stamps the time on the child's entry, adding the entry if it was missing; a retired parent stamps nothing.
  const first = await nodes.checkIn('3-T6', { childId: '3-T6-3', type: 'MACHINE', address: 'http://pc.example:4310' });
  assert.equal(first.status === 'ACTIVE' && first.added, true, 'a missing entry is added');
  const second = await nodes.checkIn('3-T6', { childId: '3-T6-3', type: 'MACHINE' });
  assert.equal(second.status === 'ACTIVE' && second.added, false);
  assert.deepEqual(await nodes.children('3-T6'), [{ childId: '3-T6-3', type: 'MACHINE', address: 'http://pc.example:4310', lastSeenAt: second.status === 'ACTIVE' ? second.lastSeenAt : '' }], 'the time is stored; the entry keeps its address');
  assert.deepEqual(await nodes.checkIn('3-T1', { childId: '3-T3', type: 'USER' }), { status: 'RETIRED', parentId: '3', parentAddress: 'http://parent.example:4310' });
  await assert.rejects(() => nodes.checkIn('3-T6', { childId: '3-T9', type: 'USER' }), /cannot sit under a SITE/);

  // A suspension is stored on the parent's entry and on the node's own record, times in UTC, and both clear.
  const at = '2026-10-16T03:30:00.000Z';
  assert.deepEqual(await nodes.markChild('3-T6', { childId: '3-T6-3' }, { reason: 'Lost laptop', by: 'admin', at }), { marked: true });
  const suspendedEntry = await nodes.checkIn('3-T6', { childId: '3-T6-3', type: 'MACHINE' });
  assert.deepEqual(suspendedEntry.status === 'ACTIVE' ? suspendedEntry.shutdown : undefined, { nodeId: '3-T6-3', reason: 'Lost laptop', by: 'admin', at }, 'a check-in reply carries the mark');
  assert.deepEqual((await nodes.children('3-T6'))[0].suspension, { reason: 'Lost laptop', by: 'admin', at });
  assert.deepEqual(await nodes.markChild('3-T6', { childId: '3-T6-4', type: 'MACHINE' }, { reason: 'Gone', at }), { marked: true }, 'marking a child missing from the list adds it');
  assert.deepEqual(await nodes.markChild('3-T6', { childId: '3-T6-5' }, null), { marked: false }, 'clearing never adds an entry');
  await nodes.markChild('3-T6', { childId: '3-T6-3' }, null);
  assert.equal((await nodes.children('3-T6'))[0].suspension, undefined);
  assert.deepEqual((await nodes.setShutdown('3-T6', { nodeId: '3-T6', reason: 'Investigation', at, via: 'ORDER' })).shutdown, { nodeId: '3-T6', reason: 'Investigation', at, via: 'ORDER' });
  assert.deepEqual((await nodes.describe('3-T6'))!.shutdown, { nodeId: '3-T6', reason: 'Investigation', at, via: 'ORDER' }, 'the lock is stored, so a restart keeps it');
  await assert.rejects(() => nodes.issueChildId('3-T6', { type: 'MACHINE' }), /Node is suspended/);
  const lockedAnswer = await nodes.checkIn('3-T6', { childId: '3-T6-3', type: 'MACHINE' });
  assert.equal(lockedAnswer.status === 'ACTIVE' ? lockedAnswer.shutdown?.nodeId : undefined, '3-T6', 'a shut-down parent tells its children');
  assert.equal((await nodes.setShutdown('3-T6', null)).shutdown, undefined);
  assert.equal((await nodes.issueChildId('3-T6', { type: 'MACHINE' })).value, '3-T6-3', 'working again once cleared');

  // A child retired while away keeps its entry as the record, is not counted, and is told so if it checks in.
  const before = (await nodes.describe('3-T6'))!.childCount;
  assert.equal((await nodes.retireChild('3-T6', { childId: '3-T6-4' }, { reason: 'Stolen', by: 'admin', at })).childCount, before - 1);
  assert.deepEqual((await nodes.children('3-T6')).find((child) => child.childId === '3-T6-4')!.retired, { reason: 'Stolen', by: 'admin', at });
  assert.equal((await nodes.list()).find((node) => node.id === '3-T6')!.childCount, before - 1, 'the count of every node leaves it out too');
  assert.deepEqual(await nodes.checkIn('3-T6', { childId: '3-T6-4', type: 'MACHINE' }), { status: 'CHILD_RETIRED', retired: { reason: 'Stolen', by: 'admin', at } });
  await nodes.retireChild('3-T6', { childId: '3-T6-9', type: 'USER' }, { reason: 'Left', at });
  await assert.rejects(() => nodes.retireChild('3-T6', { childId: '3-T6-8', type: 'SITE' }, { reason: 'x', at }), /Only a user or a machine/);

  // A lost node's old ID is stored as retired, pointing at its replacement, and issues nothing.
  assert.deepEqual(await nodes.acceptRetired({ id: '3-T7', type: 'GROUP', replacementId: '3-T2', replacementAddress: 'http://here.example:4310' }), { id: '3-T7', type: 'GROUP', parentId: '3-T2', parentAddress: 'http://here.example:4310', basis: '3-T7', childCount: 0, status: 'RETIRED' });
  assert.deepEqual(await nodes.describe('3-T7'), { id: '3-T7', type: 'GROUP', parentId: '3-T2', parentAddress: 'http://here.example:4310', basis: '3-T7', childCount: 0, status: 'RETIRED' });
  await assert.rejects(() => nodes.issueChildId('3-T7', { type: 'USER' }), /retired/);
  await assert.rejects(() => nodes.acceptRetired({ id: '3-T2', type: 'GROUP', replacementId: '3-T1' }), /already exists/);

  // A row with a type Core does not know is reported, never read as something else.
  await prisma.$executeRaw`UPDATE "sema_local_nodes" SET "type" = 'PRINTER' WHERE "id" = '3-T4'`;
  await assert.rejects(() => nodes.describe('3-T4'), /unknown type/);
  console.log('PostgreSQL local nodes test passed.');
} finally {
  await prisma.$disconnect();
}
