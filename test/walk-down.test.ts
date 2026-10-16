import assert from 'node:assert/strict';
import net from 'node:net';
import { Conversations, HttpPeerDirectory, InMemoryLocalNodeStore, InMemorySemaCoreHostStore, LocalNodes, SemaCore, SemaCoreHost, startCoreHostHttpServer, type CoreHostAuthorization, type TreeNode } from '../src/index.js';

const shape = (node: TreeNode): unknown => [node.id, node.stopped ?? '', node.children.map(shape)];

// On one Core: the organization view shows everything below and stops at another organization; the global view shows only organizations.
{
  const nodes = new LocalNodes(new InMemoryLocalNodeStore());
  const talk = new Conversations({ find: async () => nodes });
  await nodes.accept({ id: '3', type: 'ORGANIZATION' });
  const make = async (parentId: string, type: 'ORGANIZATION' | 'GROUP' | 'SITE' | 'USER' | 'MACHINE') => (await talk.createNode({ parentId, type, newNodePeer: nodes })).id;
  const site = await make('3', 'SITE'), pc = await make(site, 'MACHINE');
  const team = await make('3', 'GROUP'), person = await make(team, 'USER');
  const division = await make('3', 'ORGANIZATION'), inside = await make(division, 'USER');
  const gone = await make(team, 'USER');
  await talk.remove({ nodeId: gone });
  await talk.checkIn({ nodeId: pc });

  const tree = await talk.walkDown({ nodeId: '3' });
  assert.deepEqual(shape(tree), ['3', '', [[site, '', [[pc, '', []]]], [team, '', [[person, '', []]]], [division, 'ORGANIZATION', []]]], 'everything below, stopping at the division');
  const pcNode = tree.children[0].children[0];
  assert.deepEqual([pcNode.type, pcNode.status], ['MACHINE', 'ACTIVE']);
  assert.ok(pcNode.lastSeenAt, 'the last check-in comes from the parent\'s entry');
  assert.equal(tree.children[1].children[0].lastSeenAt, undefined, 'a node that never checked in has no time');
  assert.equal(tree.children[2].childCount, 1, 'the division says how many it holds, without showing them');

  assert.deepEqual(shape(await talk.walkDown({ nodeId: division })), [division, '', [[inside, '', []]]], 'starting at the division shows inside it');

  const global = await talk.walkDown({ nodeId: '3', view: 'global' });
  assert.deepEqual(shape(global), ['3', '', [[division, '', []]]], 'only organizations');
  assert.deepEqual([global.hiddenChildren, global.children[0].hiddenChildren], [2, 1], 'what is inside each organization is counted, not shown');

  assert.deepEqual(shape(await talk.walkDown({ nodeId: '3', maxDepth: 1 })), ['3', '', [[site, 'DEPTH', []], [team, 'DEPTH', []], [division, 'ORGANIZATION', []]]]);
  assert.equal((await talk.walkDown({ nodeId: '3', maxNodes: 3 })).stopped, 'LIMIT');
  assert.equal((await talk.walkDown({ nodeId: gone })).stopped, 'RETIRED', 'a retired node keeps its list as a record; it is not shown as live');
  assert.equal((await talk.walkDown({ nodeId: '9' })).stopped, 'UNKNOWN');
}

// Across two Cores, over HTTP: the walk asks the other Core, and a Core that does not answer ends that branch.
{
  const credentials = { applicationKey: 'peer', secret: 'peer-secret' };
  const granted = new Set(['core.topology.read', 'core.topology.write']);
  const authorization: CoreHostAuthorization = { canRead: async ({ resource }) => granted.has(resource), canAdminister: async ({ resource }) => granted.has(resource) };
  const start = async (installationId: string) => {
    const store = new InMemorySemaCoreHostStore();
    const core = new SemaCore(store, { installationId, maxReservationSize: 25 });
    const nodes = new LocalNodes(new InMemoryLocalNodeStore());
    const holder: { topology?: ConstructorParameters<typeof SemaCoreHost>[5] } = {};
    const host = new SemaCoreHost(core, store, authorization, undefined, nodes, { get peers() { return holder.topology!.peers; }, get address() { return holder.topology!.address; } } as NonNullable<ConstructorParameters<typeof SemaCoreHost>[5]>);
    await host.initialize({ actorId: 'peer' });
    const server = await startCoreHostHttpServer(host, { port: 0, applicationClients: [credentials] });
    const address = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
    holder.topology = { address, peers: new HttpPeerDirectory({ credentials, local: { address, peer: nodes } }) };
    const get = async (path: string) => {
      const response = await fetch(address + path, { headers: { 'x-sema-application-key': 'peer', 'x-sema-application-secret': 'peer-secret' } });
      return { status: response.status, payload: await response.json() as any };
    };
    return { nodes, server, address, get };
  };
  const office = await start('3'), pc = await start('4');
  await office.nodes.accept({ id: '3', type: 'ORGANIZATION' });
  await office.nodes.issueChildId('3', { type: 'SITE' });
  await office.nodes.accept({ id: '3-3', type: 'SITE', parentId: '3' });
  await office.nodes.issueChildId('3-3', { type: 'MACHINE', address: pc.address });
  await pc.nodes.accept({ id: '3-3-3', type: 'MACHINE', parentId: '3-3', parentAddress: office.address });

  const tree = (await office.get('/v1/core/topology/walk-down?nodeId=3')).payload;
  assert.deepEqual(shape(tree), ['3', '', [['3-3', '', [['3-3-3', '', []]]]]]);
  assert.deepEqual([tree.children[0].children[0].address, tree.children[0].children[0].type], [pc.address, 'MACHINE'], 'the machine was described by its own Core');
  assert.equal((await office.get('/v1/core/topology/walk-down?nodeId=3&view=sideways')).status, 400);

  pc.server.close();
  await new Promise((resolve) => setTimeout(resolve, 50));
  const without = (await office.get('/v1/core/topology/walk-down?nodeId=3')).payload;
  assert.deepEqual(shape(without), ['3', '', [['3-3', '', [['3-3-3', 'UNREACHABLE', []]]]]], 'the branch ends where a Core does not answer');
  assert.equal(without.children[0].children[0].type, 'MACHINE', 'what the parent\'s list says is still shown');

  granted.delete('core.topology.read');
  assert.equal((await office.get('/v1/core/topology/walk-down?nodeId=3')).status, 403);
  office.server.close();
}

console.log('Walk-down test passed.');
