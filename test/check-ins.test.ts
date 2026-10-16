import assert from 'node:assert/strict';
import net from 'node:net';
import { Conversations, HttpPeerDirectory, InMemoryLocalNodeStore, InMemorySemaCoreHostStore, LocalNodes, SemaCore, SemaCoreHost, startCoreHostHttpServer, type CoreHostAuthorization } from '../src/index.js';

// On one Core: a node checks in with its own parent, which stamps the time on its entry.
{
  const nodes = new LocalNodes(new InMemoryLocalNodeStore());
  const talk = new Conversations({ find: async () => nodes });
  await nodes.accept({ id: '3', type: 'ORGANIZATION' });
  const site = await talk.createNode({ parentId: '3', type: 'SITE', newNodePeer: nodes });
  const machine = await talk.createNode({ parentId: site.id, type: 'MACHINE', newNodePeer: nodes });
  assert.equal((await nodes.children(site.id))[0].lastSeenAt, undefined, 'empty until the first check-in');

  const checked = await talk.checkIn({ nodeId: machine.id });
  assert.equal(checked.state, 'CHECKED_IN');
  assert.ok('lastSeenAt' in checked && checked.lastSeenAt);
  assert.equal((await nodes.children(site.id))[0].lastSeenAt, checked.lastSeenAt, 'the parent stamped the time on the entry');
  assert.equal('addedToList' in checked, false);
  assert.deepEqual(await talk.checkIn({ nodeId: '3' }), { state: 'TOP' }, 'a top node has no parent to check in with');

  // A child missing from its parent's list is put back: the child's pointer is the truth, and a list may hold too many, never too few.
  await nodes.removeChild(site.id, machine.id);
  const back = await talk.checkIn({ nodeId: machine.id });
  assert.equal('addedToList' in back && back.addedToList, true);
  assert.deepEqual((await nodes.children(site.id)).map((child) => [child.childId, child.type]), [[machine.id, 'MACHINE']]);

  // A check-in by a type the parent may not hold is refused, like any other way of gaining a child.
  await assert.rejects(() => nodes.checkIn(site.id, { childId: '3-9', type: 'USER' }), /cannot sit under a SITE/);
  await assert.rejects(() => nodes.checkIn(site.id, { childId: site.id, type: 'SITE' }), /own child/);

  // A parent that was retired answers with its own pointer, and the child follows the chain to the nearest live ancestor.
  const group = await talk.createNode({ parentId: '3', type: 'GROUP', newNodePeer: nodes });
  const user = await talk.createNode({ parentId: group.id, type: 'USER', newNodePeer: nodes });
  await nodes.retire(group.id);
  assert.deepEqual(await nodes.checkIn(group.id, { childId: user.id, type: 'USER' }), { status: 'RETIRED', parentId: '3' }, 'a retired parent stamps nothing');
  assert.deepEqual(await talk.checkIn({ nodeId: user.id }), { state: 'PARENT_RETIRED', parentId: group.id, newParentId: '3' });
  assert.equal((await nodes.describe(user.id))!.parentId, '3');
  assert.ok((await nodes.children('3')).some((child) => child.childId === user.id));
  assert.equal((await talk.checkIn({ nodeId: user.id })).state, 'CHECKED_IN', 'the next check-in goes to the new parent');
  assert.deepEqual(await talk.checkIn({ nodeId: group.id }), { state: 'RETIRED' }, 'a retired node does not check in');
}

// Between two Cores: the machine's Core checks in with the site on the other Core, on start and on request.
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
    const call = async (method: string, path: string) => {
      const response = await fetch(address + path, { method, headers: { 'x-sema-application-key': 'peer', 'x-sema-application-secret': 'peer-secret' } });
      return { status: response.status, payload: await response.json() as any };
    };
    return { nodes, host, server, address, call };
  };
  const office = await start('3'), pc = await start('4');
  await office.nodes.accept({ id: '3', type: 'ORGANIZATION' });
  await office.nodes.issueChildId('3', { type: 'SITE' });
  await office.nodes.accept({ id: '3-3', type: 'SITE', parentId: '3' });
  await office.nodes.issueChildId('3-3', { type: 'MACHINE', address: pc.address });
  await pc.nodes.accept({ id: '3-3-3', type: 'MACHINE', parentId: '3-3', parentAddress: office.address });

  assert.equal((await pc.call('GET', '/v1/core/topology/check-in-status')).payload, null, 'no report before the first round');
  const report = (await pc.call('POST', '/v1/core/topology/check-in')).payload;
  assert.equal(report.nodes.length, 1);
  assert.deepEqual([report.nodes[0].nodeId, report.nodes[0].parentId, report.nodes[0].state], ['3-3-3', '3-3', 'CHECKED_IN']);
  const entry = (await office.nodes.children('3-3'))[0];
  assert.deepEqual([entry.childId, entry.address, entry.lastSeenAt], ['3-3-3', pc.address, report.nodes[0].lastSeenAt], 'the site on the other Core stamped the time');
  assert.equal((await pc.call('GET', '/v1/core/topology/check-in-status')).payload.checkedAt, report.checkedAt, 'the last report is kept');

  // The office Core's own nodes: the site checks in with the organization; the organization is the top.
  const own = (await office.call('POST', '/v1/core/topology/check-in')).payload.nodes;
  assert.deepEqual(own.map((node: any) => [node.nodeId, node.state]), [['3', 'TOP'], ['3-3', 'CHECKED_IN']]);
  assert.ok((await office.nodes.children('3')).find((child) => child.childId === '3-3')!.lastSeenAt);

  // A parent's Core that does not answer is reported, not guessed at.
  office.server.close();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual((await pc.call('POST', '/v1/core/topology/check-in')).payload.nodes.map((node: any) => [node.nodeId, node.state]), [['3-3-3', 'UNREACHABLE']]);

  granted.delete('core.topology.write');
  assert.equal((await pc.call('POST', '/v1/core/topology/check-in')).status, 403);
  pc.server.close();
}

console.log('Check-ins test passed.');
