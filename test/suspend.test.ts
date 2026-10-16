import assert from 'node:assert/strict';
import net from 'node:net';
import { Conversations, InMemoryLocalNodeStore, InMemorySemaCoreHostStore, LocalNodes, SemaCore, SemaCoreHost, startCoreHostHttpServer, type CoreHostAuthorization, type PeerDirectory } from '../src/index.js';

// On one Core: suspending marks the node at its parent and locks it; nodes below lock at their next check-in.
{
  const nodes = new LocalNodes(new InMemoryLocalNodeStore());
  const talk = new Conversations({ find: async () => nodes });
  await nodes.accept({ id: '3', type: 'ORGANIZATION' });
  const make = async (parentId: string, type: 'GROUP' | 'SITE' | 'USER' | 'MACHINE') => (await talk.createNode({ parentId, type, newNodePeer: nodes })).id;
  const site = await make('3', 'SITE'), pc = await make(site, 'MACHINE');
  const team = await make('3', 'GROUP'), person = await make(team, 'USER');

  await assert.rejects(() => talk.suspend({ nodeId: site, reason: ' ' }), /needs a reason/);
  const suspended = await talk.suspend({ nodeId: site, reason: 'Investigation', by: 'admin' });
  assert.deepEqual([suspended.parentId, suspended.parentMarked, suspended.nodeLocked], ['3', true, true]);
  const own = (await nodes.describe(site))!.shutdown!;
  assert.deepEqual([own.nodeId, own.reason, own.by, own.via], [site, 'Investigation', 'admin', 'ORDER']);
  assert.equal((await nodes.children('3')).find((child) => child.childId === site)!.suspension!.reason, 'Investigation', 'the parent carries the mark every other Core sees');
  await assert.rejects(() => nodes.issueChildId(site, { type: 'MACHINE' }), /Node is suspended: 3-3\. Reason: Investigation/);
  await assert.rejects(() => nodes.issueBasis(site), /suspended/);
  assert.equal((await nodes.children(site)).length, 1, 'a suspended node stays readable');

  // The machine under the site has not heard yet; it locks at its next check-in, learning it from its parent.
  await nodes.issueBasis(pc);
  const checked = await talk.checkIn({ nodeId: pc });
  assert.equal('locked' in checked && checked.locked, true);
  assert.deepEqual([(await nodes.describe(pc))!.shutdown!.nodeId, (await nodes.describe(pc))!.shutdown!.via], [site, 'PARENT']);
  await assert.rejects(() => nodes.issueBasis(pc), /Node is suspended: 3-3-3 \(because 3-3 is suspended\)/);
  assert.equal('locked' in (await talk.checkIn({ nodeId: pc })), false, 'checking in again changes nothing');
  assert.equal((await talk.checkIn({ nodeId: site })).state, 'CHECKED_IN');
  assert.equal((await nodes.describe(site))!.shutdown!.via, 'ORDER', 'a lock from an order is not replaced by the parent\'s report');
  await talk.checkIn({ nodeId: person });
  assert.equal((await nodes.describe(person))!.shutdown, undefined, 'another branch is not affected');

  // The tree shows both: the mark at the parent and what each node's own record says.
  const tree = await talk.walkDown({ nodeId: '3' });
  const siteNode = tree.children.find((node) => node.id === site)!;
  assert.deepEqual([siteNode.suspension?.reason, siteNode.shutdown?.via, siteNode.children[0].shutdown?.nodeId], ['Investigation', 'ORDER', site]);

  // Resuming the machine does nothing while its ancestor is suspended: resume the site instead.
  assert.equal((await talk.resume({ nodeId: pc })).stillLockedBy, site);
  const resumed = await talk.resume({ nodeId: site });
  assert.deepEqual([resumed.parentCleared, resumed.nodeCleared], [true, true]);
  assert.equal((await nodes.describe(site))!.shutdown, undefined);
  assert.equal((await nodes.children('3')).find((child) => child.childId === site)!.suspension, undefined);
  await nodes.issueBasis(site);
  const after = await talk.checkIn({ nodeId: pc });
  assert.equal('unlocked' in after && after.unlocked, true, 'the machine unlocks at its next check-in');
  await nodes.issueBasis(pc);
}

// A node whose machine is offline is still suspended: its parent marks it, and the machine locks when it comes back.
{
  const office = new LocalNodes(new InMemoryLocalNodeStore()), laptop = new LocalNodes(new InMemoryLocalNodeStore());
  let laptopOnline = false;
  const directory: PeerDirectory = { async find(_id, address) { return address === 'http://laptop' ? (laptopOnline ? laptop : undefined) : office; } };
  const talk = new Conversations(directory);
  await office.accept({ id: '3', type: 'SITE' });
  await office.issueChildId('3', { type: 'MACHINE', address: 'http://laptop' });
  await laptop.accept({ id: '3-3', type: 'MACHINE', parentId: '3', parentAddress: 'http://office' });

  await assert.rejects(() => talk.suspend({ nodeId: '3-3', nodeAddress: 'http://laptop', reason: 'Lost laptop' }), /Name its parent/);
  const away = await talk.suspend({ nodeId: '3-3', nodeAddress: 'http://laptop', parentId: '3', reason: 'Lost laptop' });
  assert.deepEqual([away.parentMarked, away.nodeLocked], [true, false]);
  laptopOnline = true;
  const back = await talk.checkIn({ nodeId: '3-3', nodeAddress: 'http://laptop' });
  assert.equal('locked' in back && back.locked, true, 'it learns at its first check-in after coming back');
  assert.deepEqual([(await laptop.describe('3-3'))!.shutdown!.reason, (await laptop.describe('3-3'))!.shutdown!.via], ['Lost laptop', 'PARENT']);

  // Resumed while it is away again: the mark is cleared at once, and its own lock clears at its next check-in.
  laptopOnline = false;
  assert.deepEqual(await talk.resume({ nodeId: '3-3', nodeAddress: 'http://laptop', parentId: '3' }), { nodeId: '3-3', parentCleared: true, nodeCleared: false, nodeUnreachable: true });
  laptopOnline = true;
  assert.equal((await talk.checkIn({ nodeId: '3-3', nodeAddress: 'http://laptop' }) as { unlocked?: true }).unlocked, true);

  // A top node has no parent to mark it, so an offline top node cannot be suspended from outside.
  laptopOnline = false;
  await assert.rejects(() => talk.suspend({ nodeId: '9', nodeAddress: 'http://laptop', reason: 'x' }), /could not be reached/);
}

// The whole Core: suspending its own machine node locks it. It refuses changes and work, stays readable, and resumes with its own permission.
{
  const granted = new Set(['core.topology.read', 'core.topology.write', 'core.authority.suspend', 'core.health.read', 'core.identifiers.reserve']);
  const authorization: CoreHostAuthorization = { canRead: async ({ resource }) => granted.has(resource), canAdminister: async ({ resource }) => granted.has(resource) };
  const store = new InMemorySemaCoreHostStore();
  const core = new SemaCore(store, { installationId: '3', maxReservationSize: 25 });
  const nodes = new LocalNodes(new InMemoryLocalNodeStore());
  const holder: { topology?: ConstructorParameters<typeof SemaCoreHost>[5] } = {};
  const host = new SemaCoreHost(core, store, authorization, undefined, nodes, { get peers() { return holder.topology!.peers; }, get address() { return holder.topology!.address; } } as NonNullable<ConstructorParameters<typeof SemaCoreHost>[5]>);
  await host.initialize({ actorId: 'admin' });
  const server = await startCoreHostHttpServer(host, { port: 0, applicationClients: [{ applicationKey: 'console', secret: 'console-secret' }] });
  const address = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
  holder.topology = { address, peers: { find: async () => nodes, at: async () => nodes } };
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(address + path, { method, headers: { 'x-sema-application-key': 'console', 'x-sema-application-secret': 'console-secret', ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, payload: await response.json() as any };
  };
  await nodes.accept({ id: '3', type: 'MACHINE' });

  assert.equal((await call('POST', '/v1/core/identifiers/reservations', { count: 1 })).status, 201);
  assert.equal((await call('POST', '/v1/core/topology/suspend', { nodeId: '3' })).status, 400, 'a reason is required');
  const stopped = await call('POST', '/v1/core/topology/suspend', { nodeId: '3', reason: 'Security check' });
  assert.equal(stopped.status, 200);
  assert.deepEqual([stopped.payload.parentMarked, stopped.payload.nodeLocked], [false, true], 'a top node has only its own record');

  const refused = await call('POST', '/v1/core/identifiers/reservations', { count: 1 });
  assert.deepEqual([refused.status, refused.payload.error.code], [423, 'LOCKED']);
  assert.match(refused.payload.error.message, /This Core is shut down: Security check/);
  assert.equal((await call('POST', '/v1/core/topology/create', { parentId: '3', type: 'USER' })).status, 423);
  assert.equal((await call('GET', '/v1/core/topology/local')).status, 200, 'it stays readable');
  assert.equal((await call('GET', '/v1/core/health')).payload.shutdown.reason, 'Security check', 'health says why');
  assert.equal((await call('POST', '/v1/core/topology/key-limit-check')).status, 423);

  assert.equal((await call('POST', '/v1/core/topology/resume', { nodeId: '3' })).status, 403, 'resuming needs its own permission');
  granted.add('core.authority.resume');
  const resumed = await call('POST', '/v1/core/topology/resume', { nodeId: '3' });
  assert.deepEqual([resumed.status, resumed.payload.nodeCleared], [200, true]);
  assert.equal((await call('POST', '/v1/core/identifiers/reservations', { count: 1 })).status, 201, 'working again');
  assert.equal((await call('GET', '/v1/core/health')).payload.shutdown, undefined);
  server.close();
}

console.log('Suspend test passed.');
