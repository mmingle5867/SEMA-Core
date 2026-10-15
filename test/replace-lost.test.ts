import assert from 'node:assert/strict';
import net from 'node:net';
import { Conversations, HttpPeerDirectory, InMemoryLocalNodeStore, InMemorySemaCoreHostStore, LocalNodes, SemaCore, SemaCoreHost, startCoreHostHttpServer, type CoreHostAuthorization } from '../src/index.js';

// A machine is lost with its records. Its node is replaced by a new node with a new ID, and the children
// it had, which nobody holds a list of, find the replacement by themselves when they next connect.
{
  // Three machines: the parent, the machine that is lost and rebuilt, and a child that was offline.
  const parentCore = new LocalNodes(new InMemoryLocalNodeStore());
  let rebuilt = new LocalNodes(new InMemoryLocalNodeStore());
  const childCore = new LocalNodes(new InMemoryLocalNodeStore());
  const at = new Map<string, () => LocalNodes>([['parent.example', () => parentCore], ['lost.example', () => rebuilt], ['child.example', () => childCore]]);
  const talk = new Conversations({ find: async (_id, address) => at.get(address ?? 'parent.example')?.() });

  await parentCore.accept({ id: '3', type: 'ORGANIZATION' });
  const lost = await talk.createNode({ parentId: '3', parentAddress: 'parent.example', type: 'GROUP', newNodePeer: rebuilt });
  assert.equal(lost.id, '3-3');
  const child = await talk.createNode({ parentId: '3-3', parentAddress: 'lost.example', type: 'USER', newNodePeer: childCore });
  assert.equal(child.id, '3-3-3');
  const other = await talk.createNode({ parentId: '3-3', parentAddress: 'lost.example', type: 'USER', newNodePeer: childCore });
  assert.equal(other.id, '3-3-4');
  assert.equal((await parentCore.describe('3'))!.childCount, 1);

  // The machine is lost: its records are gone. It is rebuilt empty at the same address.
  rebuilt = new LocalNodes(new InMemoryLocalNodeStore());
  assert.equal((await talk.walkUp('3-3-3', 'child.example')).stoppedAt?.reason, 'UNKNOWN', 'the child can no longer find its parent');

  // The replacement is created like any other node: a new ID, which is its new basis.
  const replacement = await talk.createNode({ parentId: '3', parentAddress: 'parent.example', type: 'GROUP', newNodePeer: rebuilt });
  assert.equal(replacement.id, '3-4', 'the old ID 3-3 is never issued again');
  assert.equal((await parentCore.describe('3'))!.childCount, 2, 'the parent lists the lost node and its replacement');

  // The person records the loss. Nobody knows the lost node's children, so the replacement's list is marked as possibly incomplete.
  const recorded = await talk.replaceLost({ lostId: '3-3', type: 'GROUP', replacementId: '3-4', replacementAddress: 'lost.example', lostParentId: '3', lostParentAddress: 'parent.example' });
  assert.deepEqual(recorded, { lostId: '3-3', replacementId: '3-4', oldParentListStale: false });
  assert.deepEqual(await rebuilt.describe('3-3'), { id: '3-3', type: 'GROUP', parentId: '3-4', parentAddress: 'lost.example', basis: '3-3', childCount: 0, status: 'RETIRED' });
  assert.deepEqual(await rebuilt.describe('3-4'), { id: '3-4', type: 'GROUP', parentId: '3', parentAddress: 'parent.example', basis: '3-4', childCount: 0, childListIncomplete: true, status: 'ACTIVE' }, 'its list is empty, and marked as possibly incomplete');
  assert.deepEqual((await parentCore.children('3')).map((child) => child.childId), ['3-4'], 'the parent no longer lists the lost node');

  // The old basis is closed: nothing is ever issued from it again. New children come from the new basis.
  await assert.rejects(() => rebuilt.issueChildId('3-3', { type: 'USER' }), /retired/);
  await assert.rejects(() => rebuilt.issueBasis('3-3'), /retired/);
  assert.equal((await rebuilt.listWithNextId()).find((node) => node.id === '3-3')!.nextId, undefined);
  assert.equal((await rebuilt.issueBasis('3-4')).value, '3-4-3');

  // Each child fixes its own pointer when it next connects, and adds itself to the replacement's list. Its ID never changes.
  assert.deepEqual(await talk.repairParent('3-3-3', 'child.example'), { changed: true, parentId: '3-4' });
  assert.deepEqual(await rebuilt.children('3-4'), [{ childId: '3-3-3', type: 'USER', address: 'child.example' }], 'the replacement learns its children as they reconnect');
  assert.deepEqual(await childCore.describe('3-3-3'), { id: '3-3-3', type: 'USER', parentId: '3-4', parentAddress: 'lost.example', basis: '3-3-3', childCount: 0, status: 'ACTIVE' });
  assert.deepEqual((await talk.walkUp('3-3-3', 'child.example')).chain.map((node) => node.id), ['3-4', '3']);
  assert.equal((await childCore.describe('3-3-4'))!.parentId, '3-3', 'a child that has not connected yet still names the old ID');
  assert.deepEqual((await talk.walkUp('3-3-4', 'child.example')).chain.map((node) => [node.id, node.status]), [['3-3', 'RETIRED'], ['3-4', 'ACTIVE'], ['3', 'ACTIVE']], 'and can still walk up through the retired record');

  // Refusals. A node the Core still holds is not lost; the replacement must be live, reachable and different.
  await assert.rejects(() => talk.replaceLost({ lostId: '3-3', type: 'GROUP', replacementId: '3-4', replacementAddress: 'lost.example' }), /not lost/);
  await assert.rejects(() => talk.replaceLost({ lostId: '3-9', type: 'GROUP', replacementId: '3-9', replacementAddress: 'lost.example' }), /different node/);
  await assert.rejects(() => talk.replaceLost({ lostId: '3-9', type: 'GROUP', replacementId: '3-8', replacementAddress: 'lost.example' }), /not reachable/);
  await assert.rejects(() => talk.replaceLost({ lostId: '3-9', type: 'GROUP', replacementId: '3-3', replacementAddress: 'lost.example' }), /retired/);
  assert.equal(await rebuilt.describe('3-9'), undefined, 'a refused request records nothing');
  assert.equal((await rebuilt.describe('3-4'))!.childCount, 1);

  // A lost top node has no parent to take it off. An old parent that cannot be reached keeps the entry, one too many.
  const top = await talk.replaceLost({ lostId: '7', type: 'ORGANIZATION', replacementId: '3-4', replacementAddress: 'lost.example' });
  assert.equal(top.oldParentListStale, false);
  const stale = await talk.replaceLost({ lostId: '8', type: 'GROUP', replacementId: '3-4', replacementAddress: 'lost.example', lostParentId: '9', lostParentAddress: 'gone.example' });
  assert.equal(stale.oldParentListStale, true);

  // An administrator says the list is complete once every child has come back.
  assert.deepEqual(await talk.markChildList({ nodeId: '3-4', nodeAddress: 'lost.example', complete: true }), { childListComplete: true });
  assert.equal((await rebuilt.describe('3-4'))!.childListIncomplete, undefined);
}

// Through the host: its own permission, on the operation and on the record another Core is asked to keep.
{
  const credentials = { applicationKey: 'peer', secret: 'peer-secret' };
  const granted = new Set(['core.topology.read', 'core.topology.write']);
  const authorization: CoreHostAuthorization = { canRead: async ({ resource }) => granted.has(resource), canAdminister: async ({ resource }) => granted.has(resource) };
  const store = new InMemorySemaCoreHostStore();
  const core = new SemaCore(store, { installationId: '3', maxReservationSize: 25 });
  const nodes = new LocalNodes(new InMemoryLocalNodeStore());
  const holder: { topology?: ConstructorParameters<typeof SemaCoreHost>[5] } = {};
  const host = new SemaCoreHost(core, store, authorization, undefined, nodes, { get peers() { return holder.topology!.peers; }, get address() { return holder.topology!.address; } } as NonNullable<ConstructorParameters<typeof SemaCoreHost>[5]>);
  await host.initialize({ actorId: 'peer' });
  const server = await startCoreHostHttpServer(host, { port: 0, applicationClients: [credentials] });
  const address = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
  holder.topology = { address, peers: new HttpPeerDirectory({ credentials, local: { address, peer: nodes } }) };
  const post = async (path: string, body: unknown) => {
    const response = await fetch(address + path, { method: 'POST', headers: { 'x-sema-application-key': 'peer', 'x-sema-application-secret': 'peer-secret', 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, payload: await response.json() as any };
  };
  await nodes.accept({ id: '3', type: 'ORGANIZATION' });
  await nodes.accept({ id: '3-4', type: 'GROUP', parentId: '3', parentAddress: address });
  await nodes.addChildren('3', [{ childId: '3-3', type: 'GROUP' }, { childId: '3-4', type: 'GROUP' }]); // the lost node 3-3 and its replacement 3-4

  const request = { lostId: '3-3', type: 'GROUP', replacementId: '3-4', lostParentId: '3' };
  assert.equal((await post('/v1/core/topology/replace-lost', request)).status, 403, 'being allowed to change the tree is not enough');
  assert.equal((await post('/v1/core/topology/nodes/accept-retired', { id: '3-3', type: 'GROUP', replacementId: '3-4' })).status, 403);
  assert.equal(await nodes.describe('3-3'), undefined, 'a refused request records nothing');

  granted.add('core.authority.replace-lost');
  assert.equal((await post('/v1/core/topology/replace-lost', { ...request, type: 'PRINTER' })).status, 400);
  const done = await post('/v1/core/topology/replace-lost', request);
  assert.equal(done.status, 201);
  assert.deepEqual(done.payload, { lostId: '3-3', replacementId: '3-4', oldParentListStale: false });
  assert.deepEqual((await nodes.list()).map((node) => [node.id, node.status, node.parentId ?? null, node.childCount, node.childListIncomplete ?? false]).sort(), [['3', 'ACTIVE', null, 1, false], ['3-3', 'RETIRED', '3-4', 0, false], ['3-4', 'ACTIVE', '3', 0, true]]);
  assert.ok((await post('/v1/core/topology/replace-lost', request)).status >= 400, 'it cannot be recorded twice');
  server.close();
}

console.log('Replace lost node test passed.');
