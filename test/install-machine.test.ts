import assert from 'node:assert/strict';
import net from 'node:net';
import { FIRST_NODE_ID, HttpPeerDirectory, InMemoryLocalNodeStore, InMemorySemaCoreHostStore, LocalCoreHostAuthorization, LocalNodes, SemaCore, SemaCoreHost, joiningPeer, resolveStart, startCoreHostHttpServer, startJoinServer, type JoinRequest, type NodeDescription } from '../src/index.js';

// How a Core starts. Its database decides which node it is; an ID typed into its settings never does.
assert.equal(FIRST_NODE_ID, '3');
assert.deepEqual(resolveStart({ storedId: '3' }), { mode: 'run', installationId: '3' });
assert.deepEqual(resolveStart({ storedId: '3', configuredId: '3' }), { mode: 'run', installationId: '3' }, 'the setting may stay as a cross-check');
assert.deepEqual(resolveStart({ storedId: '3-7', startNewSystem: true }), { mode: 'run', installationId: '3-7' }, 'a Core with an identity keeps it');
assert.throws(() => resolveStart({ storedId: '3-7', configuredId: '3' }), /cannot be changed by its settings/);
assert.deepEqual(resolveStart({}), { mode: 'join' }, 'a Core with no identity waits to be joined');
assert.deepEqual(resolveStart({ configuredId: '3' }), { mode: 'join' }, 'a typed ID alone does not create an identity');
assert.deepEqual(resolveStart({ configuredId: '9-9' }), { mode: 'join' });
assert.deepEqual(resolveStart({ startNewSystem: true }), { mode: 'run', installationId: '3' }, 'the first node of a new system is always 3');
assert.deepEqual(resolveStart({ startNewSystem: true, configuredId: '3' }), { mode: 'run', installationId: '3' });
assert.throws(() => resolveStart({ startNewSystem: true, configuredId: '4' }), /always 3/);

// A Core that has not joined answers its health and the join request, and nothing else.
const recorded: JoinRequest[] = [];
const record = async (request: JoinRequest): Promise<NodeDescription> => { recorded.push(request); return { id: request.id, type: 'MACHINE', parentId: request.parentId, ...(request.parentAddress ? { parentAddress: request.parentAddress } : {}), basis: request.id, childCount: 0, status: 'ACTIVE' }; };
const addressOf = (server: { address(): unknown }) => `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
const send = async (base: string, path: string, body?: unknown) => {
  const response = await fetch(base + path, { method: body ? 'POST' : 'GET', headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  return { status: response.status, payload: await response.json() as any };
};
{
  const closed = await startJoinServer({ port: 0, version: 'test', record });
  const base = addressOf(closed.server);
  assert.deepEqual((await send(base, '/v1/core/health')).payload, { status: 'NOT_JOINED', version: 'test' });
  assert.equal((await send(base, '/v1/core/topology/local')).status, 503);
  assert.equal((await send(base, '/v1/core/topology/create', { parentId: '3', type: 'USER' })).status, 503);
  const refused = await send(base, '/v1/core/join', { id: '3-3', parentId: '3', joinCode: '' });
  assert.equal(refused.status, 503, 'a Core with no join code cannot be joined');
  assert.equal(refused.payload.error.code, 'NO_JOIN_CODE');
  closed.server.close();
}
const waiting = await startJoinServer({ port: 0, version: 'test', joinCode: 'the-join-code', record });
const newCore = addressOf(waiting.server);
assert.equal((await send(newCore, '/v1/core/join', { id: '3-3', parentId: '3', joinCode: 'wrong' })).status, 403);
assert.equal((await send(newCore, '/v1/core/join', { id: '3-3', parentId: '3' })).status, 403);
assert.equal((await send(newCore, '/v1/core/join', { id: '3--3', parentId: '3', joinCode: 'the-join-code' })).status, 400);
assert.equal((await send(newCore, '/v1/core/join', { id: '3', parentId: '3', joinCode: 'the-join-code' })).status, 400);
assert.equal((await send(newCore, '/v1/core/join', { id: '3-3', joinCode: 'the-join-code' })).status, 400, 'a joining Core must be told its parent');
assert.equal(recorded.length, 0, 'a refused request records nothing');

// An existing Core installs it: the parent issues the ID and counts the child, and the new Core records it.
const credentials = { applicationKey: 'peer', secret: 'peer-secret' };
async function startCore(withAddress: boolean) {
  const store = new InMemorySemaCoreHostStore();
  const core = new SemaCore(store, { installationId: '3', maxReservationSize: 25 });
  const nodes = new LocalNodes(new InMemoryLocalNodeStore());
  const holder: { topology?: ConstructorParameters<typeof SemaCoreHost>[5] } = {};
  const host = new SemaCoreHost(core, store, new LocalCoreHostAuthorization(new Set(['peer'])), undefined, nodes, { get peers() { return holder.topology!.peers; }, get address() { return holder.topology!.address; }, joining: joiningPeer } as NonNullable<ConstructorParameters<typeof SemaCoreHost>[5]>);
  await host.initialize({ actorId: 'peer' });
  const server = await startCoreHostHttpServer(host, { port: 0, applicationClients: [credentials] });
  const address = addressOf(server);
  holder.topology = { address: withAddress ? address : undefined, peers: new HttpPeerDirectory({ credentials, local: { address, peer: nodes } }) };
  const post = async (path: string, body: unknown) => {
    const response = await fetch(address + path, { method: 'POST', headers: { 'x-sema-application-key': 'peer', 'x-sema-application-secret': 'peer-secret', 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, payload: await response.json() as any };
  };
  await nodes.accept({ id: '3', type: 'MACHINE' });
  return { server, address, nodes, post, store };
}
const A = await startCore(true);

// A wrong join code: the new Core refuses, the parent takes the child back off its count, and the number is spent.
let r = await A.post('/v1/core/topology/install-machine', { parentId: '3', newCoreAddress: newCore, joinCode: 'wrong' });
assert.ok(r.status >= 400);
assert.match(r.payload.error.message, /join code is not correct/);
assert.equal((await A.nodes.describe('3'))!.childCount, 0);
assert.equal(recorded.length, 0);

r = await A.post('/v1/core/topology/install-machine', { parentId: '3', newCoreAddress: newCore, joinCode: 'the-join-code' });
assert.equal(r.status, 201);
assert.deepEqual(r.payload, { id: '3-4', type: 'MACHINE', parentId: '3', parentAddress: A.address, basis: '3-4', childCount: 0, status: 'ACTIVE', address: newCore });
assert.deepEqual(recorded, [{ id: '3-4', parentId: '3', parentAddress: A.address }], 'the new Core was told its ID and where its parent lives');
assert.deepEqual(await waiting.joinedAs, { id: '3-4', parentId: '3', parentAddress: A.address });
assert.equal((await A.nodes.describe('3'))!.childCount, 1);
assert.equal(await A.nodes.describe('3-4'), undefined, 'the new node lives on the new machine, not here');
const audits = JSON.stringify(A.store.audits);
assert.ok(audits.includes('core.topology.machine-installed') && audits.includes('3-4'), 'the install is audited');
assert.ok(!audits.includes('the-join-code'), 'the join code is never recorded');

// A Core joins once. A second install aimed at it is refused, and the parent's count is handed back.
r = await A.post('/v1/core/topology/install-machine', { parentId: '3', newCoreAddress: newCore, joinCode: 'the-join-code' });
assert.ok(r.status >= 400);
assert.match(r.payload.error.message, /already joined/);
assert.equal((await A.nodes.describe('3'))!.childCount, 1);
assert.equal(recorded.length, 1);

// What the request must say, and what this Core needs before it can install anything.
assert.equal((await A.post('/v1/core/topology/install-machine', { parentId: '3', newCoreAddress: newCore })).status, 400);
assert.equal((await A.post('/v1/core/topology/install-machine', { parentId: '3', joinCode: 'x' })).status, 400);
assert.equal((await A.post('/v1/core/topology/install-machine', { parentId: '3', newCoreAddress: A.address, joinCode: 'x' })).status, 400, 'the new machine cannot be this Core');
const B = await startCore(false);
r = await B.post('/v1/core/topology/install-machine', { parentId: '3', newCoreAddress: newCore, joinCode: 'the-join-code' });
assert.equal(r.status, 400);
assert.match(r.payload.error.message, /must be able to reach its parent/);
assert.equal((await B.nodes.listWithNextId())[0].nextId, '3-3', 'nothing was issued');

for (const server of [A.server, B.server, waiting.server]) server.close();
console.log('Install machine test passed.');
