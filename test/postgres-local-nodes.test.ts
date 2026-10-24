import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { LocalNodes } from '../src/topology/local-nodes.js';
import { PrismaLocalNodeStore } from '../src/topology/prisma-local-node-store.js';
import { PrismaSemaCoreHostStore } from '../src/host/prisma-host-store.js';
import { PrismaClientKeyStore } from '../src/keys/client-keys.js';
import { PrismaCapabilityStore } from '../src/capabilities/prisma-capability-store.js';
import { PrismaWorkStore } from '../src/capabilities/prisma-work-store.js';

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
    assert.deepEqual(await nodes.describe(id), { id, type, parentId: '3', parentAddress: 'http://parent.example:4310', basis: id, childCount: 0, ...(type === 'ORGANIZATION' ? { seats: { users: { used: 0 }, machines: { used: 0 } } } : {}), status: 'ACTIVE' });
  }
  await assert.rejects(() => nodes.accept({ id: '3-T5' } as never), /ORGANIZATION, GROUP, SITE, USER or MACHINE/);
  await assert.rejects(() => nodes.accept({ id: '3-T3', type: 'USER' }), /already exists/);
  assert.deepEqual((await nodes.list()).map((node) => [node.id, node.type]), [['3', 'MACHINE'], ['3-T1', 'ORGANIZATION'], ['3-T2', 'GROUP'], ['3-T3', 'USER'], ['3-T4', 'MACHINE'], ['3-T6', 'SITE']]);

  assert.equal((await nodes.listWithNextId()).find((node) => node.id === '3-T1')!.nextId, '3-T1-3');

  // Key limits are stored on an organization node, read back, kept through other changes, and cleared.
  assert.deepEqual((await nodes.setKeyLimits('3-T1', { maxSegments: 4, maxLastSegmentLength: 6 })).keyLimits, { maxSegments: 4, maxLastSegmentLength: 6 });
  assert.deepEqual((await nodes.describe('3-T1'))!.keyLimits, { maxSegments: 4, maxLastSegmentLength: 6 });
  assert.equal((await nodes.describe('3-T2'))!.keyLimits, undefined);

  // Seats are stored on an organization node, in use and allowed, and kept through other changes.
  assert.deepEqual((await nodes.describe('3-T1'))!.seats, { users: { used: 0 }, machines: { used: 0 } });
  await nodes.setSeatLimits('3-T1', { users: 3 });
  assert.deepEqual(await nodes.changeSeats('3-T1', { users: 2, machines: 1 }), { users: { used: 2, allowed: 3 }, machines: { used: 1 } });
  await assert.rejects(() => nodes.changeSeats('3-T1', { users: 2 }), /No user seat left in 3-T1: 2 of 3 in use/);
  assert.deepEqual(await nodes.changeSeats('3-T1', { users: -1, machines: -5 }), { users: { used: 1, allowed: 3 }, machines: { used: 0 } }, 'giving back never goes below zero');
  assert.deepEqual(await nodes.setSeatsUsed('3-T1', { users: 0, machines: 4 }, false), { users: { used: 1, allowed: 3 }, machines: { used: 4 } }, 'an incomplete recount only raises');
  await nodes.setSeatsUsed('3-T1', { users: 0, machines: 0 }, true);
  await nodes.setSeatLimits('3-T1', { users: null });
  assert.equal((await nodes.describe('3-T2'))!.seats, undefined, 'only an organization node has seats');
  await assert.rejects(() => nodes.changeSeats('3-T2', { users: 1 }), /Seats are held on an organization node/);

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
  assert.deepEqual(await nodes.describe('3-T1'), { id: '3-T1', type: 'ORGANIZATION', parentId: '3', parentAddress: 'http://parent.example:4310', basis: '3-T1', childCount: 1, keyLimits: { maxSegments: 4, maxLastSegmentLength: 6 }, seats: { users: { used: 0 }, machines: { used: 0 } }, status: 'RETIRED' }, 'a retired node keeps its list, and its limits survived every change');
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
  // Programs' public keys: added once, listed by program, revoked but kept as a record.
  const clientKeys = new PrismaClientKeyStore(prisma);
  const jwk = { kty: 'EC', crv: 'P-256', x: 'qIVYZVLCrPZHGHjP17CTW0_-D9Lfw0EkjqF7xB4FivA', y: 'Mc4nN9LTDOBhfoUeg8Ye9WedFRhnZXZJA12Qp0zZ6F0' };
  const addedKey = await clientKeys.add({ keyId: 'test-key', applicationKey: 'console', publicJwk: jwk });
  assert.deepEqual([addedKey.keyId, addedKey.applicationKey, addedKey.publicJwk, addedKey.revokedAt], ['test-key', 'console', jwk, undefined]);
  assert.ok(Math.abs(Date.parse(addedKey.createdAt) - Date.now()) < 60_000, `a time the database fills in is UTC like every other (got ${addedKey.createdAt})`);
  await assert.rejects(() => clientKeys.add({ keyId: 'test-key', applicationKey: 'other', publicJwk: jwk }), /already registered/);
  assert.deepEqual((await clientKeys.list('console')).map((key) => key.keyId), ['test-key']);
  assert.deepEqual(await clientKeys.list('other'), []);
  assert.equal(await clientKeys.revoke('test-key'), true);
  assert.equal(await clientKeys.revoke('test-key'), false, 'revoking twice changes nothing');
  const revokedAt = (await clientKeys.get('test-key'))!.revokedAt;
  assert.ok(revokedAt && Math.abs(Date.parse(revokedAt) - Date.now()) < 60_000, 'a revoked key stays as a record, with its time in UTC');
  // The capability and service records: written and read back whole, times in UTC, each kept once.
  const capabilities = new PrismaCapabilityStore(prisma);
  const when = new Date().toISOString();
  const capability = { id: 'cap-1', capabilityKey: 'neo.listing.write-copy', version: '1.0.0', displayName: 'Write copy', description: 'Writes copy', operations: [{ key: 'write', required: true, input: { type: 'object' } }], choosing: ['bound' as const, 'consensus' as const], approved: false, legacy: false, status: 'ACTIVE' as const, createdAt: when };
  await capabilities.addCapabilityVersion(capability);
  assert.deepEqual(await capabilities.getCapabilityVersion('cap-1'), capability);
  assert.deepEqual(await capabilities.findCapabilityVersion('neo.listing.write-copy', '1.0.0'), capability);
  await assert.rejects(() => capabilities.addCapabilityVersion({ ...capability, id: 'cap-2' }), /already exists/, 'one record per key and version');
  const service = { id: 'svc-1', serviceKey: 'neo.ai.copy', version: '1.0.0', capabilityVersionId: 'cap-1', displayName: 'Copy', operations: ['write', 'translate'], extensions: ['translate'], declarations: { runsWhere: 'remote', offline: false, systems: ['windows'] }, legacy: false, status: 'ACTIVE' as const, createdAt: when };
  await capabilities.addServiceVersion(service);
  assert.deepEqual(await capabilities.findServiceVersion('neo.ai.copy', '1.0.0', 'cap-1'), service);
  const installation = { id: 'ins-1', serviceVersionId: 'svc-1', machineNodeId: '3', endpointUrl: 'http://127.0.0.1:4320/x', installedAt: when };
  await capabilities.addInstallation(installation);
  assert.deepEqual(await capabilities.findInstallation('svc-1'), installation);
  await assert.rejects(() => capabilities.addInstallation({ ...installation, id: 'ins-2' }), /already exists/, 'installed once per machine');
  const instance = { id: 'run-1', installationId: 'ins-1', startedAt: when, lastCheckInAt: when, capacity: 2, resources: { memoryMb: 900 }, state: 'RUNNING' as const, applicationKey: 'neo.ai.copy' };
  await capabilities.addInstance(instance);
  const later = new Date(Date.now() + 1000).toISOString();
  assert.deepEqual(await capabilities.updateInstance('run-1', { lastCheckInAt: later, resources: { memoryMb: 400 } }), { ...instance, lastCheckInAt: later, resources: { memoryMb: 400 } });
  assert.deepEqual(await capabilities.updateInstance('run-1', { state: 'STOPPED' }), { ...instance, lastCheckInAt: later, resources: { memoryMb: 400 }, state: 'STOPPED' }, 'a change leaves the rest as it was');
  await assert.rejects(() => capabilities.updateInstance('run-9', { state: 'STOPPED' }), /does not exist/);
  assert.deepEqual([(await capabilities.listCapabilityVersions()).length, (await capabilities.listServiceVersions()).length, (await capabilities.listInstallations()).length, (await capabilities.listInstances()).length], [1, 1, 1, 1]);
  const stored = (await prisma.$queryRaw<Array<{ text: string }>>`SELECT "createdAt"::text AS text FROM "sema_core_capability_versions" WHERE "id" = 'cap-1'`)[0].text;
  assert.equal(stored.replace(' ', 'T').slice(0, 19), when.slice(0, 19), 'stored as UTC wall time');
  // Capability commands' executions and results, in Core's execution and result tables.
  const work = new PrismaWorkStore(prisma);
  const t0 = new Date(Date.now() - 2000).toISOString(), t1 = new Date(Date.now() - 1000).toISOString(), t2 = new Date().toISOString();
  await work.addExecution({ id: 'ex-1', commandId: 'cmd-1', serviceVersionId: 'svc-1', status: 'PENDING', createdAt: t0 });
  await work.addExecution({ id: 'ex-2', commandId: 'cmd-1', serviceVersionId: 'svc-1', status: 'PENDING', createdAt: t1 });
  assert.deepEqual(await work.getExecution('ex-1'), { id: 'ex-1', commandId: 'cmd-1', serviceVersionId: 'svc-1', status: 'PENDING', createdAt: t0 });
  const offered = (await work.claim('svc-1', 'run-1', t2, t0))!;
  assert.deepEqual([offered.id, offered.status, offered.instanceId, offered.offeredAt], ['ex-1', 'WAITING', 'run-1', t2], 'the oldest waiting execution is offered');
  assert.equal((await work.claim('svc-1', 'run-2', t2, t0))!.id, 'ex-2', 'a fresh offer is not offered again');
  assert.equal(await work.claim('svc-1', 'run-2', t2, t0), undefined);
  assert.equal(await work.claim('svc-9', 'run-2', t2, t0), undefined, 'only work for its own service version');
  assert.equal((await work.claim('svc-1', 'run-2', t2, new Date(Date.now() + 1000).toISOString()))!.id, 'ex-1', 'an offer never answered is offered again once stale');
  assert.equal(await work.change('ex-1', { status: 'WAITING', instanceId: 'run-1' }, { status: 'RUNNING', startedAt: t2 }), false, 'only the instance it was last offered to may answer');
  assert.equal(await work.change('ex-1', { status: 'WAITING', instanceId: 'run-2' }, { status: 'RUNNING', startedAt: t2 }), true);
  assert.equal(await work.change('ex-2', { status: 'WAITING', instanceId: 'run-2' }, { status: 'FAILED', completedAt: t2, notNow: { answer: 'decline', reason: 'busy' } }), true);
  assert.deepEqual(await work.getExecution('ex-2'), { id: 'ex-2', commandId: 'cmd-1', serviceVersionId: 'svc-1', status: 'FAILED', instanceId: 'run-2', offeredAt: t2, completedAt: t2, notNow: { answer: 'decline', reason: 'busy' }, createdAt: t1 });
  assert.equal(await work.change('ex-1', { status: 'RUNNING', instanceId: 'run-2' }, { status: 'FAILED', completedAt: t2, error: 'broke' }), true);
  assert.equal((await work.getExecution('ex-1'))!.error, 'broke');
  assert.deepEqual((await work.listExecutions('cmd-1')).map((execution) => execution.id), ['ex-1', 'ex-2']);
  await work.addAnswer('res-1', { executionId: 'ex-1', outcome: 'achieved', answer: { text: 'hi' }, recordedAt: t2 });
  assert.deepEqual(await work.getAnswer('ex-1'), { executionId: 'ex-1', outcome: 'achieved', answer: { text: 'hi' }, recordedAt: t2 });
  const commandResult = { id: 'res-2', commandId: 'cmd-1', entries: [{ executionId: 'ex-1', serviceVersionId: 'svc-1', serviceKey: 'neo.ai.copy', status: 'SUCCESS' as const, answer: { text: 'hi' } }], recordedAt: t2 };
  assert.equal(await work.addResult(commandResult), true);
  assert.equal(await work.addResult({ ...commandResult, id: 'res-3' }), false, 'one command, one result');
  assert.deepEqual(await work.getResult('cmd-1'), commandResult);
  // Phase 3a: a deferred execution is not offered before its time; progress is kept; waiting work can be cancelled.
  const soon = new Date(Date.now() + 60_000).toISOString(), now3 = new Date().toISOString();
  await work.addExecution({ id: 'ex-3', commandId: 'cmd-3', serviceVersionId: 'svc-3', status: 'PENDING', createdAt: now3 });
  assert.equal((await work.claim('svc-3', 'run-3', now3, t0))!.id, 'ex-3');
  assert.equal(await work.change('ex-3', { status: 'WAITING', instanceId: 'run-3' }, { status: 'PENDING', deferred: { until: soon, reason: 'warming up' } }), true);
  assert.deepEqual((await work.getExecution('ex-3'))!.deferred, { until: soon, reason: 'warming up' });
  assert.equal(await work.claim('svc-3', 'run-3', new Date().toISOString(), t0), undefined, 'not offered before its time');
  assert.equal((await work.claim('svc-3', 'run-3', new Date(Date.now() + 61_000).toISOString(), t0))!.id, 'ex-3', 'offered once its time has come');
  assert.equal(await work.change('ex-3', { status: 'WAITING', instanceId: 'run-3' }, { status: 'RUNNING', startedAt: now3 }), true);
  const progressed = { at: new Date().toISOString(), percent: 40, note: 'drafting' };
  assert.equal(await work.change('ex-3', { status: 'RUNNING', instanceId: 'run-3' }, { progress: progressed }), true);
  assert.deepEqual((await work.getExecution('ex-3'))!.progress, progressed);
  assert.deepEqual((await work.getExecution('ex-3'))!.deferred, { until: soon, reason: 'warming up' }, 'a later change keeps what was there');
  assert.deepEqual((await work.listRunning()).map((execution) => execution.id), ['ex-3']);
  await work.addExecution({ id: 'ex-4', commandId: 'cmd-3', serviceVersionId: 'svc-4', status: 'PENDING', createdAt: now3 });
  await work.cancelPending('cmd-3', new Date().toISOString());
  assert.deepEqual((await work.listExecutions('cmd-3')).map((execution) => [execution.id, execution.status]), [['ex-3', 'RUNNING'], ['ex-4', 'CANCELLED']], 'only work still waiting is cancelled');
  console.log('PostgreSQL local nodes test passed.');
} finally {
  await prisma.$disconnect();
}
