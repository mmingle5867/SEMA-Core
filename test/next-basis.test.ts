import assert from 'node:assert/strict';
import net from 'node:net';
import { Conversations, HttpPeerDirectory, InMemoryLocalNodeStore, InMemorySemaCoreHostStore, LocalNodes, SemaCore, SemaCoreHost, startCoreHostHttpServer, type CoreHostAuthorization } from '../src/index.js';

// A ready basis: fetched early, it takes over in the same step that would pass the limit, so nothing waits.
{
  const nodes = new LocalNodes(new InMemoryLocalNodeStore());
  await nodes.accept({ id: '5', type: 'ORGANIZATION' });
  assert.equal((await nodes.issueChildId('5', { type: 'GROUP' })).value, '5-3');
  await nodes.accept({ id: '5-3', type: 'GROUP', parentId: '5' });
  for (let i = 0; i < 3; i += 1) await nodes.issueChildId('5-3', { type: 'USER' });   // 5-3-3, 5-3-4, 5-3-5
  await assert.rejects(() => nodes.setNextBasis('5-3', { basis: '5-3-9', switchAt: 4 }), /issued by an ancestor/);
  await assert.rejects(() => nodes.setNextBasis('5-3', { basis: '6-4', switchAt: 0 }), /at least 1/);
  const kept = await nodes.setNextBasis('5-3', { basis: '6-4', switchAt: 4 }); // hand-written bases come from another tree, 6, so they never meet values 5 issues
  assert.deepEqual([kept.nextBasis, kept.switchAt], ['6-4', '4']);
  assert.equal((await nodes.setNextBasis('5-3', { basis: '6-5', switchAt: 9 })).nextBasis, '6-4', 'a node holds one ready basis; a second value is never used');
  assert.equal((await nodes.listWithNextId()).find((node) => node.id === '5-3')!.nextId, '5-3-6', 'below the switch the old basis still issues');
  assert.equal((await nodes.issueChildId('5-3', { type: 'USER' })).value, '5-3-6', 'value 4 is still under the limit');
  assert.equal((await nodes.listWithNextId()).find((node) => node.id === '5-3')!.nextId, '6-4-3', 'the shown next ID follows the switch');
  assert.equal((await nodes.issueChildId('5-3', { type: 'USER' })).value, '6-4-3', 'value 5 would pass the limit, so the ready basis takes over');
  const after = (await nodes.describe('5-3'))!;
  assert.deepEqual([after.basis, after.nextBasis, after.switchAt], ['6-4', undefined, undefined], 'the ready basis is used up');
  assert.equal(after.id, '5-3', 'the node keeps its own ID');
  assert.equal((await nodes.issueBasis('5-3')).value, '6-4-4', 'a basis issued for others also comes from the new basis');

  // A roll-up gives a new basis, so a ready one meant for the old basis is dropped.
  await nodes.setNextBasis('5-3', { basis: '6-6', switchAt: 50 });
  await nodes.accept({ id: '5-3-7-9', type: 'GROUP', parentId: '5-3' });
  await nodes.setNextBasis('5-3-7-9', { basis: '6-7', switchAt: 50 });
  await nodes.setBasis('5-3-7-9', '6-8');
  assert.equal((await nodes.describe('5-3-7-9'))!.nextBasis, undefined);

  // The conversation picks the issuer as a roll-up would: inside the organization, the highest reachable.
  const talk = new Conversations({ find: async () => nodes });
  await nodes.accept({ id: '5-3-7', type: 'GROUP', parentId: '5-3' });
  const prepared = await talk.prepareNextBasis({ nodeId: '5-3-7', switchAt: BigInt(55) });
  assert.deepEqual([prepared.issuerId, prepared.nextBasis, prepared.switchAt, prepared.alreadyReady], ['5', '5-4', '55', false]);
  assert.equal((await talk.prepareNextBasis({ nodeId: '5-3-7', switchAt: BigInt(55) })).alreadyReady, true, 'asking again changes nothing');
}

// The check: it finds each node's limit through its organization, fetches a ready basis at nine tenths, and reports
// a node past its limit that has no way to get one. That node keeps issuing.
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
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(address + path, { method, headers: { 'x-sema-application-key': 'peer', 'x-sema-application-secret': 'peer-secret', ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, payload: await response.json() as any };
  };

  // One-character segments: a counter may reach 55 (z). Nine tenths is 50.
  await nodes.accept({ id: '7', type: 'ORGANIZATION' });
  await nodes.setKeyLimits('7', { maxSegmentLength: 1 });
  await nodes.issueChildId('7', { type: 'GROUP' });
  await nodes.accept({ id: '7-3', type: 'GROUP', parentId: '7', parentAddress: address });
  for (let i = 0; i < 49; i += 1) await nodes.issueChildId('7-3', { type: 'USER' });
  await nodes.accept({ id: '8', type: 'ORGANIZATION' });   // an organization on its own, with nothing above it
  await nodes.setKeyLimits('8', { maxSegmentLength: 1 });
  for (let i = 0; i < 56; i += 1) await nodes.issueChildId('8', { type: 'USER' });
  await nodes.accept({ id: '9', type: 'ORGANIZATION' });   // no limits at all

  assert.equal((await call('GET', '/v1/core/topology/key-limit-status')).payload, null, 'no report before the first run');
  let report = (await call('POST', '/v1/core/topology/key-limit-check')).payload;
  const state = (id: string) => report.nodes.find((node: any) => node.nodeId === id);
  assert.equal(state('7-3').state, 'OK', 'at 49 of 55 it is still below nine tenths');
  assert.equal(state('9').state, 'NO_LIMIT');
  assert.equal(state('8').state, 'OVER_LIMIT', 'past its limit, with no ancestor inside its organization to issue');
  assert.match(state('8').reason, /No reachable ancestor/);
  assert.equal((await nodes.issueChildId('8', { type: 'USER' })).value, '8-33', 'it keeps issuing (value 57, two characters): a limit is a preference');

  await nodes.issueChildId('7-3', { type: 'USER' });        // the 50th value
  report = (await call('POST', '/v1/core/topology/key-limit-check')).payload;
  assert.deepEqual([state('7-3').state, state('7-3').nextBasis, state('7-3').switchAt, state('7-3').maxValue], ['READY', '7-4', '55', '55'], 'at nine tenths the organization issues a ready basis');
  assert.deepEqual((await call('GET', '/v1/core/topology/key-limit-status')).payload.nodes.find((node: any) => node.nodeId === '7-3').state, 'READY', 'the last report is kept');
  for (let i = 0; i < 5; i += 1) await nodes.issueChildId('7-3', { type: 'USER' });   // up to 55
  assert.equal((await nodes.issueChildId('7-3', { type: 'USER' })).value, '7-4-3', 'the 56th value comes from the ready basis');

  granted.delete('core.topology.read');
  assert.equal((await call('GET', '/v1/core/topology/key-limit-status')).status, 403);
  server.close();
}

console.log('Next basis test passed.');
