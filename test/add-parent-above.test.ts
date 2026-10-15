import assert from 'node:assert/strict';
import net from 'node:net';
import { Conversations, HttpPeerDirectory, InMemoryLocalNodeStore, InMemorySemaCoreHostStore, LocalNodes, SemaCore, SemaCoreHost, startCoreHostHttpServer, type CoreHostAuthorization, type NodePeer } from '../src/index.js';

// Growing from the ground up: a parent is added above a node that has none.
{
  const nodes = new LocalNodes(new InMemoryLocalNodeStore());
  const talk = new Conversations({ find: async () => nodes });
  await nodes.accept({ id: '3', type: 'GROUP' });
  const child = await talk.createNode({ parentId: '3', type: 'USER', newNodePeer: nodes });
  assert.equal(child.id, '3-3');

  // The top node has no parent to issue the ID, so here it issues it itself: its basis plus the next number.
  const first = await talk.addParentAbove({ nodeId: '3', type: 'ORGANIZATION', newNodePeer: nodes });
  assert.deepEqual(first, { id: '3-4', childId: '3', issuerId: '3' });
  assert.deepEqual(await nodes.describe('3-4'), { id: '3-4', type: 'ORGANIZATION', basis: '3-4', childCount: 1, status: 'ACTIVE' });
  assert.equal((await nodes.describe('3'))!.parentId, '3-4');
  assert.equal((await nodes.describe('3'))!.childCount, 1, 'the new parent is not the issuer\'s child');
  assert.deepEqual((await talk.walkUp('3-3')).chain.map((node) => node.id), ['3', '3-4']);

  // A second parent, above the first. Offered node 3, the shortest basis issues, so the new top stays short.
  const second = await talk.addParentAbove({ nodeId: '3-4', type: 'ORGANIZATION', newNodePeer: nodes, alsoConsider: [{ id: '3', basis: '3' }] });
  assert.deepEqual(second, { id: '3-5', childId: '3-4', issuerId: '3' });
  assert.equal((await nodes.describe('3'))!.childCount, 1);
  assert.equal((await nodes.describe('3-4'))!.parentId, '3-5');
  assert.deepEqual((await talk.walkUp('3-3')).chain.map((node) => node.id), ['3', '3-4', '3-5']);

  // Left to itself the top node issues, and a named issuer is used as given.
  const third = await talk.addParentAbove({ nodeId: '3-5', type: 'ORGANIZATION', newNodePeer: nodes });
  assert.deepEqual(third, { id: '3-5-3', childId: '3-5', issuerId: '3-5' });
  const fourth = await talk.addParentAbove({ nodeId: '3-5-3', type: 'ORGANIZATION', newNodePeer: nodes, issuerId: '3-4' });
  assert.deepEqual(fourth, { id: '3-4-3', childId: '3-5-3', issuerId: '3-4' });

  // The new top issues its own children from its own basis, and nothing was ever issued twice.
  assert.equal((await talk.createNode({ parentId: '3-4-3', type: 'USER', newNodePeer: nodes })).id, '3-4-3-3');
  const all = await nodes.list();
  assert.equal(new Set(all.map((node) => node.id)).size, all.length);
  assert.equal(new Set(all.map((node) => node.basis)).size, all.length);

  // Refusals: a node that already has a parent, a retired node, and a node that is not there.
  await assert.rejects(() => talk.addParentAbove({ nodeId: '3', type: 'GROUP', newNodePeer: nodes }), /already has a parent/);
  await assert.rejects(() => talk.addParentAbove({ nodeId: '9', type: 'GROUP', newNodePeer: nodes }), /not reachable/);
  const alone = new LocalNodes(new InMemoryLocalNodeStore());
  await alone.accept({ id: '7', type: 'MACHINE' }); await alone.retire('7');
  await assert.rejects(() => new Conversations({ find: async () => alone }).addParentAbove({ nodeId: '7', type: 'GROUP', newNodePeer: alone }), /retired/);

  // If the new node cannot be recorded, the value is left unused and the top node is untouched.
  const lone = new LocalNodes(new InMemoryLocalNodeStore());
  await lone.accept({ id: '3', type: 'MACHINE' });
  const refusing = { accept: async () => { throw new Error('refused'); } } as unknown as NodePeer;
  await assert.rejects(() => new Conversations({ find: async () => lone }).addParentAbove({ nodeId: '3', type: 'SITE', newNodePeer: refusing }), /refused/);
  assert.deepEqual(await lone.describe('3'), { id: '3', type: 'MACHINE', basis: '3', childCount: 0, status: 'ACTIVE' });
  assert.equal((await lone.listWithNextId())[0].nextId, '3-4', 'the refused value 3-3 is never used again');
}

// Through the host: its own permission, and the shortest basis this Core holds is the issuer.
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
  await nodes.accept({ id: '3', type: 'MACHINE' });

  // Being allowed to change the tree is not enough: adding a top needs its own permission.
  let r = await post('/v1/core/topology/add-parent-above', { nodeId: '3', type: 'ORGANIZATION' });
  assert.equal(r.status, 403);
  assert.equal((await nodes.describe('3'))!.parentId, undefined, 'a refused request changes nothing');
  assert.equal((await nodes.listWithNextId())[0].nextId, '3-3', 'and issues nothing');

  granted.add('core.authority.add-top');
  r = await post('/v1/core/topology/add-parent-above', { nodeId: '3' });
  assert.equal(r.status, 400, 'the type of the new parent must be named');
  r = await post('/v1/core/topology/add-parent-above', { nodeId: '3', type: 'ORGANIZATION' });
  assert.equal(r.status, 400, 'a machine sits under a site, not directly under an organization');
  assert.equal((await nodes.listWithNextId())[0].nextId, '3-3', 'checked before anything is issued');
  assert.equal((await nodes.list()).length, 1, 'and no node is left behind');
  r = await post('/v1/core/topology/add-parent-above', { nodeId: '3', type: 'SITE' });
  assert.equal(r.status, 201);
  assert.deepEqual(r.payload, { id: '3-3', childId: '3', issuerId: '3', type: 'SITE', address });
  assert.equal((await nodes.describe('3'))!.parentAddress, address, 'the top node stores where its new parent lives');

  // Above that new top: node 3 is held here and has the shortest basis, so it issues, not the current top.
  r = await post('/v1/core/topology/add-parent-above', { nodeId: '3-3', type: 'ORGANIZATION' });
  assert.equal(r.status, 201);
  assert.deepEqual([r.payload.id, r.payload.issuerId], ['3-4', '3']);
  assert.deepEqual((await nodes.list()).map((node) => [node.id, node.parentId ?? null, node.childCount]), [['3', '3-3', 0], ['3-3', '3-4', 1], ['3-4', null, 1]]);

  r = await post('/v1/core/topology/add-parent-above', { nodeId: '3', type: 'GROUP' });
  assert.ok(r.status >= 400, 'a node that has a parent is refused');
  server.close();
}

console.log('Add parent above top test passed.');
