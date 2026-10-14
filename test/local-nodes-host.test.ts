import assert from 'node:assert/strict';
import net from 'node:net';
import { InMemoryLocalNodeStore, InMemorySemaCoreHostStore, LocalCoreHostAuthorization, LocalNodes, SemaCore, SemaCoreHost, startCoreHostHttpServer } from '../src/index.js';

const store = new InMemorySemaCoreHostStore();
const core = new SemaCore(store, { installationId: '3', maxReservationSize: 25 });
const host = new SemaCoreHost(core, store, new LocalCoreHostAuthorization(new Set(['admin'])), undefined, new LocalNodes(new InMemoryLocalNodeStore()));
await host.initialize({ actorId: 'admin' });
const server = await startCoreHostHttpServer(host, { port: 0 });
const base = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}/v1/core/topology/nodes`;
const admin = { 'x-sema-actor-id': 'admin', 'content-type': 'application/json' };
const post = async (path: string, body: unknown, headers: Record<string, string> = admin) => {
  const response = await fetch(`${base}/${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() as Record<string, any> };
};
const describe = async (id: string) => (await (await fetch(`${base}?id=${encodeURIComponent(id)}`, { headers: admin })).json()) as Record<string, any> | null;

assert.equal((await post('accept', { id: '3-3', type: 'MACHINE' })).status, 201, 'a node on this machine, placed by a console operation');
assert.deepEqual(await describe('3-3'), { id: '3-3', type: 'MACHINE', basis: '3-3', childCount: 0, status: 'ACTIVE' });
assert.equal((await post('accept', { id: '3-8' })).status, 400, 'a node cannot be recorded without its type');
assert.equal((await post('accept', { id: '3-8', type: 'PRINTER' })).status, 400);
assert.equal(await describe('3-8'), null);
assert.equal(await describe('3-4'), null, 'a node on another machine is simply not here');

assert.equal((await post('issue-child', { nodeId: '3-3' })).status, 400, 'a child cannot be issued without saying what it is');
const child = await post('issue-child', { nodeId: '3-3', type: 'USER', address: 'http://elsewhere.example' });
assert.equal(child.status, 201);
assert.deepEqual(child.body, { value: '3-3-3', childCount: 1 });
assert.deepEqual(await (await fetch(`${base}/children?id=3-3`, { headers: admin })).json(), [{ childId: '3-3-3', type: 'USER', address: 'http://elsewhere.example' }]);
const basis = await post('issue-basis', { nodeId: '3-3' });
assert.equal(basis.body.value, '3-3-4');
assert.equal((await describe('3-3'))!.childCount, 1, 'issuing a basis is not adding a child');

assert.equal((await post('accept', { id: '3-3-9', type: 'USER', parentId: '3-3' })).status, 201);
assert.equal((await describe('3-3-9'))!.type, 'USER');
assert.equal((await post('set-parent', { nodeId: '3-3-9', parentId: '3' })).body.parentId, '3');
assert.deepEqual((await post('add-children', { nodeId: '3', children: [] })).status, 500, 'only a node held here gains children');
assert.deepEqual((await post('add-children', { nodeId: '3-3', children: [{ childId: '3-3-9', type: 'USER' }] })).body, { childCount: 2 });
assert.equal((await post('add-children', { nodeId: '3-3', children: [{ childId: '3-3-7', type: 'PRINTER' }] })).status, 400);
assert.equal((await post('add-children', { nodeId: '3-3', children: 'nope' })).status, 400);
assert.deepEqual((await post('remove-child', { nodeId: '3-3', childId: '3-3-3' })).body, { removed: true, childCount: 1 });
assert.deepEqual((await post('remove-child', { nodeId: '3-3', childId: '3-3-3' })).body, { removed: false, childCount: 1 });
assert.deepEqual((await post('child-list-complete', { nodeId: '3-3', complete: false })).body, { childListComplete: false });
assert.equal((await describe('3-3'))!.childListIncomplete, true);
assert.equal((await post('child-list-complete', { nodeId: '3-3', complete: 'yes' })).status, 400);
await post('child-list-complete', { nodeId: '3-3', complete: true });
assert.equal((await post('set-basis', { nodeId: '3-3-9', basis: '3-3-9' })).status, 500, 'a roll-up must shorten');
assert.equal((await post('retire', { nodeId: '3-3-9' })).body.parentId, '3');
assert.equal((await describe('3-3-9'))!.status, 'RETIRED');

// Only an administrator may change nodes, and every change is audited.
assert.equal((await post('issue-child', { nodeId: '3-3', type: 'USER' }, { 'x-sema-actor-id': 'someone', 'content-type': 'application/json' })).status, 403);
assert.ok((await host.statistics({ actorId: 'admin' })).auditEntries >= 7);

// A Core without local nodes says so plainly.
const bare = new SemaCoreHost(core, store, new LocalCoreHostAuthorization(new Set(['admin'])));
await assert.rejects(() => bare.nodeDescribe({ actorId: 'admin' }, { id: '3' }), /not enabled/);

server.close();
console.log('Local nodes host test passed.');
