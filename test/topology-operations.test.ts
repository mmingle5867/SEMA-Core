import assert from 'node:assert/strict';
import net from 'node:net';
import { HttpPeerDirectory, InMemoryLocalNodeStore, InMemorySemaCoreHostStore, LocalCoreHostAuthorization, LocalNodes, SemaCore, SemaCoreHost, startCoreHostHttpServer } from '../src/index.js';

// Three real Cores. The operator talks only to Core A (as the System Console will); A runs every conversation.
const credentials = { applicationKey: 'peer', secret: 'peer-secret' };
type Running = { server: import('node:http').Server; address: string; nodes: LocalNodes };
async function start(installationId: string): Promise<Running> {
  const store = new InMemorySemaCoreHostStore();
  const core = new SemaCore(store, { installationId, maxReservationSize: 25 });
  const nodes = new LocalNodes(new InMemoryLocalNodeStore());
  // The port is only known after listening, so the host reads its topology lazily through a holder.
  const holder: { topology?: ConstructorParameters<typeof SemaCoreHost>[5] } = {};
  const host = new SemaCoreHost(core, store, new LocalCoreHostAuthorization(new Set(['peer'])), undefined, nodes, {
    get peers() { return holder.topology!.peers; }, get address() { return holder.topology!.address; },
  } as NonNullable<ConstructorParameters<typeof SemaCoreHost>[5]>);
  await host.initialize({ actorId: 'peer' });
  const server = await startCoreHostHttpServer(host, { port: 0, applicationClients: [credentials] });
  const address = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
  holder.topology = { address, peers: new HttpPeerDirectory({ credentials, local: { address, peer: nodes } }) };
  return { server, address, nodes };
}
const A = await start('3'), B = await start('4'), C = await start('5');
const call = async (core: Running, method: 'GET' | 'POST', path: string, body?: unknown) => {
  const response = await fetch(core.address + path, { method, headers: { 'x-sema-application-key': 'peer', 'x-sema-application-secret': 'peer-secret', ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const payload = await response.json() as any;
  return { status: response.status, payload };
};

await A.nodes.accept({ id: '3' }); // the first node, created by hand on the first machine

// Create on another machine: A issues, B records, and B stores A's address beside its pointer.
let r = await call(A, 'POST', '/v1/core/topology/create', { parentId: '3', newNodeAddress: B.address });
assert.equal(r.status, 201); assert.equal(r.payload.id, '3-3'); assert.equal(r.payload.address, B.address);
assert.deepEqual(await B.nodes.describe('3-3'), { id: '3-3', parentId: '3', parentAddress: A.address, basis: '3-3', childCount: 0, status: 'ACTIVE' });
// Create on this same machine (no address given).
r = await call(A, 'POST', '/v1/core/topology/create', { parentId: '3' });
assert.equal(r.payload.id, '3-4');
assert.equal((await A.nodes.describe('3-4'))!.parentAddress, A.address);
// Under a node held by B, placed on C.
r = await call(A, 'POST', '/v1/core/topology/create', { parentId: '3-3', parentAddress: B.address, newNodeAddress: C.address });
assert.equal(r.payload.id, '3-3-3');

// What A holds, and walking up from a node on C.
r = await call(A, 'GET', '/v1/core/topology/local');
assert.equal(r.payload.address, A.address); assert.deepEqual(r.payload.nodes.map((n: any) => n.id), ['3', '3-4']);
r = await call(A, 'GET', `/v1/core/topology/walk-up?nodeId=3-3-3&nodeAddress=${encodeURIComponent(C.address)}`);
assert.deepEqual(r.payload.chain.map((n: any) => n.id), ['3-3', '3']);

// Roll-up: A issues a fresh basis and C adopts it.
r = await call(A, 'POST', '/v1/core/topology/roll-up', { nodeId: '3-3-3', nodeAddress: C.address });
assert.deepEqual([r.payload.issuerId, r.payload.basis], ['3', '3-5']);

// Rehome across machines, then remove.
r = await call(A, 'POST', '/v1/core/topology/rehome', { nodeId: '3-3-3', nodeAddress: C.address, newParentId: '3-4' });
assert.equal(r.payload.changed, true);
assert.equal((await C.nodes.describe('3-3-3'))!.parentId, '3-4');
assert.equal((await C.nodes.describe('3-3-3'))!.parentAddress, A.address);
assert.equal((await A.nodes.describe('3-4'))!.childCount, 1);
assert.equal((await B.nodes.describe('3-3'))!.childCount, 0);
r = await call(A, 'POST', '/v1/core/topology/remove', { nodeId: '3-3', nodeAddress: B.address });
assert.equal(r.status, 200); assert.equal((await B.nodes.describe('3-3'))!.status, 'RETIRED');
assert.equal((await A.nodes.describe('3'))!.childCount, 1); // 3-4 remains; the removed node's slot is gone

// Refusals come back as errors, not silent changes.
r = await call(A, 'POST', '/v1/core/topology/rehome', { nodeId: '3-4', newParentId: '3-4' });
assert.ok(r.status >= 400);
r = await call(A, 'POST', '/v1/core/topology/create', { parentId: '3', newNodeAddress: 'http://127.0.0.1:9' });
assert.ok(r.status >= 400);
assert.equal((await A.nodes.describe('3'))!.childCount, 1); // a failed create leaves the count where it was

for (const core of [A, B, C]) core.server.close();
console.log('Topology operations test passed.');
