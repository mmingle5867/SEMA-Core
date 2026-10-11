import assert from 'node:assert/strict';
import net from 'node:net';
import { Conversations, HttpNodePeer, HttpPeerDirectory, InMemoryLocalNodeStore, InMemorySemaCoreHostStore, LocalCoreHostAuthorization, LocalNodes, SemaCore, SemaCoreHost, startCoreHostHttpServer } from '../src/index.js';

// Three real Cores, each with its own node store, talking over HTTP with the shared application credential.
const credentials = { applicationKey: 'peer', secret: 'peer-secret' };
async function startCore(installationId: string, nodes: LocalNodes) {
  const store = new InMemorySemaCoreHostStore();
  const core = new SemaCore(store, { installationId, maxReservationSize: 25 });
  const host = new SemaCoreHost(core, store, new LocalCoreHostAuthorization(new Set(['peer'])), undefined, nodes);
  await host.initialize({ actorId: 'peer' });
  const server = await startCoreHostHttpServer(host, { port: 0, applicationClients: [credentials] });
  return { server, address: `http://127.0.0.1:${(server.address() as net.AddressInfo).port}` };
}
const nodesA = new LocalNodes(new InMemoryLocalNodeStore()), nodesB = new LocalNodes(new InMemoryLocalNodeStore()), nodesC = new LocalNodes(new InMemoryLocalNodeStore());
const A = await startCore('3', nodesA), B = await startCore('4', nodesB), C = await startCore('5', nodesC);
const talk = new Conversations(new HttpPeerDirectory({ credentials }));

await nodesA.accept({ id: '3' }); // the central authority's top node lives on A

// Create across machines: A issues, B records. B stores A's address beside its pointer.
const onB = await talk.createNode({ parentId: '3', parentAddress: A.address, newNodePeer: new HttpNodePeer(B.address, credentials) });
assert.equal(onB.id, '3-3');
assert.deepEqual(await nodesB.describe('3-3'), { id: '3-3', parentId: '3', parentAddress: A.address, basis: '3-3', childCount: 0, status: 'ACTIVE' });
assert.equal((await nodesA.describe('3'))!.childCount, 1);
const onC = await talk.createNode({ parentId: '3-3', parentAddress: B.address, newNodePeer: new HttpNodePeer(C.address, credentials) });
assert.equal(onC.id, '3-3-3');

// Walking up follows the stored addresses, one machine at a time.
const up = await talk.walkUp('3-3-3', C.address);
assert.deepEqual(up.chain.map((n) => [n.id, n.address]), [['3-3', B.address], ['3', A.address]]);
assert.equal(up.stoppedAt, undefined);

// Roll-up across machines: A issues, C adopts.
const rolled = await talk.rollUp({ nodeId: '3-3-3', nodeAddress: C.address });
assert.deepEqual(rolled, { issuerId: '3', previousBasis: '3-3-3', basis: '3-4' });
assert.equal((await nodesC.describe('3-3-3'))!.basis, '3-4');

// A machine that is down simply ends the walk and blocks roll-up beyond it.
await new Promise<void>((resolve) => B.server.close(() => resolve()));
const broken = await talk.walkUp('3-3-3', C.address);
assert.deepEqual(broken.chain, []);
assert.deepEqual(broken.stoppedAt, { nodeId: '3-3', reason: 'UNREACHABLE' });
await assert.rejects(() => talk.rollUp({ nodeId: '3-3-3', nodeAddress: C.address }), /No reachable ancestor/);

// A wrong credential is the same as unreachable.
const stranger = new Conversations(new HttpPeerDirectory({ credentials: { applicationKey: 'peer', secret: 'wrong' } }));
assert.equal((await stranger.walkUp('3-3-3', C.address)).stoppedAt?.reason, 'UNREACHABLE');

A.server.close(); C.server.close();
console.log('Core-to-core test passed.');
