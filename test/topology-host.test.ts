import assert from 'node:assert/strict';
import net from 'node:net';
import { InMemorySemaCoreHostStore, InMemoryTopologyStore, LocalCoreHostAuthorization, SemaCore, SemaCoreHost, SemaTopology, startCoreHostHttpServer } from '../src/index.js';

const store = new InMemorySemaCoreHostStore();
const core = new SemaCore(store, { installationId: '3', maxReservationSize: 25 });
const host = new SemaCoreHost(core, store, new LocalCoreHostAuthorization(new Set(['admin'])), undefined, new SemaTopology(new InMemoryTopologyStore()));
await host.initialize({ actorId: 'admin' });
const server = await startCoreHostHttpServer(host, { port: 0 });
const base = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
const admin = { 'x-sema-actor-id': 'admin', 'content-type': 'application/json' };
const post = async (path: string, body: unknown, headers: Record<string, string> = admin) => {
  const response = await fetch(`${base}/v1/core/topology/${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() as Record<string, any> };
};

assert.equal((await post('nodes/top', { id: '3' })).status, 201);
const a = await post('nodes', { parentId: '3' });
assert.equal(a.status, 201);
assert.equal(a.body.id, '3-3');
const b = await post('nodes', { parentId: a.body.id });
const c = await post('nodes', { parentId: b.body.id });
assert.equal(c.body.id, '3-3-3-3');

const rolled = await post('nodes/rollup', { nodeId: c.body.id, issuerId: '3' });
assert.equal(rolled.status, 200);
assert.equal(rolled.body.basis, '3-4', 'the first value ancestor 3 had issued was 3-3, so the next is 3-4');
assert.equal((await post('nodes', { parentId: c.body.id })).body.id, '3-4-3');

const inserted = await post('nodes/insert', { childId: b.body.id });
assert.equal(inserted.status, 201);
assert.equal(inserted.body.parentId, a.body.id);
assert.equal((await post('nodes/rehome', { nodeId: b.body.id, parentId: '3' })).status, 200);
assert.equal((await post('nodes/rehome', { nodeId: '3', parentId: c.body.id })).status, 500, 'a cycle is refused');
const removed = await post('nodes/remove', { nodeId: b.body.id });
assert.deepEqual(removed.body.repointed, [c.body.id]);

const read = await (await fetch(`${base}/v1/core/topology/nodes?id=${encodeURIComponent(c.body.id)}`, { headers: admin })).json() as { node: { parentId: string }; ancestors: Array<{ id: string }> };
assert.equal(read.node.parentId, '3');
assert.deepEqual(read.ancestors.map((node) => node.id), ['3']);

// Only an administrator may change the tree, and every change is audited.
assert.equal((await post('nodes', { parentId: '3' }, { 'x-sema-actor-id': 'someone', 'content-type': 'application/json' })).status, 403);
assert.ok((await host.statistics({ actorId: 'admin' })).auditEntries >= 7);

// A Core without topology says so plainly.
const bare = new SemaCoreHost(core, store, new LocalCoreHostAuthorization(new Set(['admin'])));
await assert.rejects(() => bare.topologyGet({ actorId: 'admin' }, { id: '3' }), /not enabled/);

server.close();
console.log('Topology host test passed.');
