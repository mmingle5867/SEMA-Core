import assert from 'node:assert/strict';
import net from 'node:net';
import { Conversations, InMemoryLocalNodeStore, InMemorySemaCoreHostStore, LocalNodes, SemaCore, SemaCoreHost, startCoreHostHttpServer, type CoreHostAuthorization, type PeerDirectory } from '../src/index.js';

// Named users and devices: a seat is taken when a user or machine is added, in its organization and every one above.
const nodes = new LocalNodes(new InMemoryLocalNodeStore());
const talk = new Conversations({ find: async () => nodes });
const used = async (id: string) => { const seats = (await nodes.describe(id))!.seats!; return [seats.users.used, seats.machines.used]; };
const make = async (parentId: string, type: 'ORGANIZATION' | 'GROUP' | 'SITE' | 'USER' | 'MACHINE') => (await talk.createNode({ parentId, type, newNodePeer: nodes })).id;

await nodes.accept({ id: '3', type: 'ORGANIZATION' });
assert.deepEqual((await nodes.describe('3'))!.seats, { users: { used: 0 }, machines: { used: 0 } }, 'a new organization has no seats in use and no limit');
await talk.setSeatLimits({ nodeId: '3', users: 2, machines: 5 });
const team = await make('3', 'GROUP'), site = await make('3', 'SITE');
const first = await make(team, 'USER'), second = await make(team, 'USER');
await make(site, 'MACHINE');
assert.deepEqual(await used('3'), [2, 1], 'groups and sites take no seats; users and machines do');
const nextBefore = (await nodes.listWithNextId()).find((node) => node.id === team)!.nextId;
await assert.rejects(() => make(team, 'USER'), /No user seat left in 3: 2 of 2 in use/);
assert.equal((await nodes.listWithNextId()).find((node) => node.id === team)!.nextId, nextBefore, 'a full organization uses no ID');
assert.equal((await nodes.children(team)).length, 2);

// A division: its own limit cannot exceed its parent's, and its people count in the parent too.
const division = await make('3', 'ORGANIZATION');
await assert.rejects(() => talk.setSeatLimits({ nodeId: division, users: 5 }), /cannot allow 5 user seats: its parent organization 3 allows 2/);
await talk.setSeatLimits({ nodeId: division, users: 2 });
await assert.rejects(() => make(division, 'USER'), /No user seat left in 3/, 'the division has room but the company does not');
assert.deepEqual(await used(division), [0, 0], 'a refused add gives back what it took on the way');
await talk.remove({ nodeId: first });
assert.deepEqual(await used('3'), [1, 1], 'removing a user gives its seat back');
const inside = await make(division, 'USER');
assert.deepEqual([await used(division), await used('3')], [[1, 0], [2, 1]]);

// Moving: a user into another organization takes a seat there and gives one back here; a move inside one changes nothing.
await nodes.accept({ id: '4', type: 'ORGANIZATION' });
const otherTeam = await make('4', 'GROUP');
await talk.rehome({ nodeId: inside, newParentId: team });
assert.deepEqual([await used(division), await used('3')], [[0, 0], [2, 1]], 'from the division into the company: only the division gives back');
await talk.rehome({ nodeId: inside, newParentId: otherTeam });
assert.deepEqual([await used('3'), await used('4')], [[1, 1], [1, 0]]);
await assert.rejects(() => talk.rehome({ nodeId: team, newParentId: '4' }), /Moving a GROUP to a different organization is not built yet/);
await assert.rejects(() => talk.rehome({ nodeId: team, newParentId: division }), /Moving a GROUP to a different organization/, 'a division is a different organization too');

// A division moves with its own counts.
await make(division, 'USER');
assert.deepEqual([await used(division), await used('3')], [[1, 0], [2, 1]]);
await talk.rehome({ nodeId: division, newParentId: '4' });
assert.deepEqual([await used('3'), await used('4'), await used(division)], [[1, 1], [2, 0], [1, 0]]);

// Removing a machine gives its seat back.
const machine = (await nodes.children(site))[0].childId;
await talk.remove({ nodeId: machine });
assert.deepEqual(await used('3'), [1, 0]);

// A recount corrects a count, and only raises it when part of the tree did not answer.
await nodes.setSeatsUsed('4', { users: 9, machines: 9 }, true);
const recount = await talk.recountSeats({ nodeId: '4' });
assert.deepEqual([recount.counted, recount.complete, await used('4')], [{ users: 2, machines: 0 }, true, [2, 0]], 'its own user plus the division\'s count');
await nodes.setSeatsUsed('3', { users: 0, machines: 0 }, true);
await make(site, 'MACHINE');
await nodes.setSeatsUsed('3', { users: 0, machines: 0 }, true);
assert.deepEqual((await talk.recountSeats({ nodeId: '3' })).counted, { users: 1, machines: 1 }, 'a count left too low is put right');

// Across two Cores, with the organization's Core away: nothing is added, and a removal leaves the count high.
{
  const office = new LocalNodes(new InMemoryLocalNodeStore()), laptop = new LocalNodes(new InMemoryLocalNodeStore());
  let officeOnline = true;
  const directory: PeerDirectory = { async find(_id, address) { return address === 'http://office' ? (officeOnline ? office : undefined) : laptop; } };
  const across = new Conversations(directory);
  await office.accept({ id: '5', type: 'ORGANIZATION' });
  await office.issueChildId('5', { type: 'GROUP', address: 'http://laptop' });
  await laptop.accept({ id: '5-3', type: 'GROUP', parentId: '5', parentAddress: 'http://office' });
  const person = (await across.createNode({ parentId: '5-3', type: 'USER', newNodePeer: laptop })).id;
  assert.equal((await office.describe('5'))!.seats!.users.used, 1, 'the organization on the other Core counted it');
  officeOnline = false;
  await assert.rejects(() => across.createNode({ parentId: '5-3', type: 'USER', newNodePeer: laptop }), /Seats cannot be counted: 5, above 5-3, is not reachable/);
  await across.remove({ nodeId: person });
  officeOnline = true;
  assert.equal((await office.describe('5'))!.seats!.users.used, 1, 'the count stays high, the safe way, until a recount');
  const fixed = await across.recountSeats({ nodeId: '5', nodeAddress: 'http://office' });
  assert.deepEqual([fixed.counted.users, fixed.complete], [0, true]);
}

// Over HTTP: setting limits needs its own permission, and a full organization answers 409.
{
  const granted = new Set(['core.topology.read', 'core.topology.write']);
  const authorization: CoreHostAuthorization = { canRead: async ({ resource }) => granted.has(resource), canAdminister: async ({ resource }) => granted.has(resource) };
  const store = new InMemorySemaCoreHostStore();
  const core = new SemaCore(store, { installationId: '3', maxReservationSize: 25 });
  const local = new LocalNodes(new InMemoryLocalNodeStore());
  const host = new SemaCoreHost(core, store, authorization, undefined, local, { peers: { find: async () => local, at: async () => local }, address: undefined });
  await host.initialize({ actorId: 'console' });
  const server = await startCoreHostHttpServer(host, { port: 0, applicationClients: [{ applicationKey: 'console', secret: 'console-secret' }] });
  const address = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
  const post = async (path: string, body: unknown) => { const response = await fetch(address + path, { method: 'POST', headers: { 'x-sema-application-key': 'console', 'x-sema-application-secret': 'console-secret', 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: response.status, payload: await response.json() as any }; };
  await local.accept({ id: '7', type: 'ORGANIZATION' });
  assert.equal((await post('/v1/core/topology/seat-limits', { nodeId: '7', users: 1 })).status, 403, 'setting limits needs core.authority.seats');
  granted.add('core.authority.seats');
  assert.deepEqual((await post('/v1/core/topology/seat-limits', { nodeId: '7', users: 1 })).payload, { users: { used: 0, allowed: 1 }, machines: { used: 0 } });
  assert.equal((await post('/v1/core/topology/seat-limits', { nodeId: '7', users: 1.5 })).status, 400);
  assert.equal((await post('/v1/core/topology/create', { parentId: '7', type: 'USER' })).status, 201);
  const full = await post('/v1/core/topology/create', { parentId: '7', type: 'USER' });
  assert.deepEqual([full.status, full.payload.error.code], [409, 'NO_SEAT']);
  assert.deepEqual((await post('/v1/core/topology/seat-limits', { nodeId: '7', users: null })).payload.users, { used: 1 }, 'null clears a limit');
  assert.equal((await post('/v1/core/topology/recount-seats', { nodeId: '7' })).payload.complete, true);
  server.close();
}

console.log('Seats test passed.');
