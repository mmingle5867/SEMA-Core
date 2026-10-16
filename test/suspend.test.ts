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

  // The notice went straight down the list: the machine under the site is locked already, learning it from above.
  assert.deepEqual(suspended.notice, { told: [pc], unreachable: [], failed: [] });
  assert.deepEqual([(await nodes.describe(pc))!.shutdown!.nodeId, (await nodes.describe(pc))!.shutdown!.via], [site, 'PARENT']);
  await assert.rejects(() => nodes.issueBasis(pc), /Node is suspended: 3-3-3 \(because 3-3 is suspended\)/);
  assert.equal('locked' in (await talk.checkIn({ nodeId: pc })), false, 'its next check-in agrees, so nothing changes');
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
  assert.deepEqual([resumed.parentCleared, resumed.nodeCleared, resumed.stillLockedBy], [true, true, undefined]);
  assert.deepEqual('notice' in resumed && resumed.notice, { told: [pc], unreachable: [], failed: [] }, 'the news goes down too');
  assert.equal((await nodes.describe(site))!.shutdown, undefined);
  assert.equal((await nodes.children('3')).find((child) => child.childId === site)!.suspension, undefined);
  await nodes.issueBasis(site);
  await nodes.issueBasis(pc);
}

// Suspensions inside suspensions: each node follows the nearest suspension above it, and resuming one never frees what another still holds.
{
  const nodes = new LocalNodes(new InMemoryLocalNodeStore());
  const talk = new Conversations({ find: async () => nodes });
  await nodes.accept({ id: '3', type: 'ORGANIZATION' });
  const make = async (parentId: string, type: 'SITE' | 'MACHINE') => (await talk.createNode({ parentId, type, newNodePeer: nodes })).id;
  const building = await make('3', 'SITE'), floor = await make(building, 'SITE'), pc = await make(floor, 'MACHINE'), printer = await make(building, 'MACHINE');
  const lockOf = async (id: string) => { const shutdown = (await nodes.describe(id))!.shutdown; return shutdown ? `${shutdown.nodeId}/${shutdown.via}` : 'free'; };

  await talk.suspend({ nodeId: floor, reason: 'Floor rewiring' });
  assert.deepEqual([await lockOf(floor), await lockOf(pc), await lockOf(printer)], [`${floor}/ORDER`, `${floor}/PARENT`, 'free']);
  const whole = await talk.suspend({ nodeId: building, reason: 'Building closed' });
  assert.deepEqual(whole.notice.told, [printer], 'the floor has its own suspension, so it and everything below it are left alone');
  assert.deepEqual([await lockOf(building), await lockOf(floor), await lockOf(pc), await lockOf(printer)], [`${building}/ORDER`, `${floor}/ORDER`, `${floor}/PARENT`, `${building}/PARENT`]);

  // Resuming the building: the printer is free; the floor is still suspended, so the PC stays locked.
  const reopened = await talk.resume({ nodeId: building });
  assert.deepEqual('notice' in reopened && reopened.notice?.told, [printer]);
  assert.deepEqual([await lockOf(building), await lockOf(floor), await lockOf(pc), await lockOf(printer)], ['free', `${floor}/ORDER`, `${floor}/PARENT`, 'free']);

  // The other order: suspend the building again, then resume the floor. The floor is now held by the building, and so is the PC.
  await talk.suspend({ nodeId: building, reason: 'Building closed again' });
  const floorBack = await talk.resume({ nodeId: floor });
  assert.equal(floorBack.stillLockedBy, building, 'resuming the floor does not free it while the building is suspended');
  assert.deepEqual([await lockOf(floor), await lockOf(pc)], [`${building}/PARENT`, `${building}/PARENT`]);
  await talk.resume({ nodeId: building });
  assert.deepEqual([await lockOf(building), await lockOf(floor), await lockOf(pc), await lockOf(printer)], ['free', 'free', 'free', 'free']);
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

  // Suspending the site: the notice reaches the laptop on its own Core when it answers, and lists it when it does not.
  const reached = await talk.suspend({ nodeId: '3', reason: 'Site audit' });
  assert.deepEqual(reached.notice, { told: ['3-3'], unreachable: [], failed: [] });
  assert.equal((await laptop.describe('3-3'))!.shutdown!.nodeId, '3');
  await talk.resume({ nodeId: '3' });
  assert.equal((await laptop.describe('3-3'))!.shutdown, undefined);
  laptopOnline = false;
  assert.deepEqual((await talk.suspend({ nodeId: '3', reason: 'Site audit' })).notice, { told: [], unreachable: ['3-3'], failed: [] }, 'a machine that does not answer is listed, and learns at its next check-in');
  await talk.resume({ nodeId: '3' });

  // A top node has no parent to mark it, so an offline top node cannot be suspended from outside.
  await assert.rejects(() => talk.suspend({ nodeId: '9', nodeAddress: 'http://laptop', reason: 'x' }), /could not be reached/);
}

// Retiring a machine that is away, for good: its parent keeps the record, and if it ever comes back it retires itself.
{
  const office = new LocalNodes(new InMemoryLocalNodeStore()), laptop = new LocalNodes(new InMemoryLocalNodeStore());
  let laptopOnline = true;
  const directory: PeerDirectory = { async find(_id, address) { return address === 'http://laptop' ? (laptopOnline ? laptop : undefined) : office; } };
  const talk = new Conversations(directory);
  await office.accept({ id: '3', type: 'SITE' });
  await office.issueChildId('3', { type: 'MACHINE', address: 'http://laptop' });
  await laptop.accept({ id: '3-3', type: 'MACHINE', parentId: '3', parentAddress: 'http://office' });
  const away = { nodeId: '3-3', nodeAddress: 'http://laptop', parentId: '3', reason: 'Stolen' };

  await assert.rejects(() => talk.retireAway(away), /can be reached\. Use remove/);
  laptopOnline = false;
  await assert.rejects(() => talk.retireAway({ ...away, reason: '' }), /needs a reason/);
  assert.equal((await talk.retireAway({ ...away, by: 'admin' })).childCount, 0);
  assert.equal((await office.describe('3'))!.childCount, 0, 'a retired entry is not counted as a child');
  assert.deepEqual([(await office.children('3'))[0].retired!.reason, (await office.children('3'))[0].retired!.by], ['Stolen', 'admin'], 'the entry stays as the record');
  const tree = await talk.walkDown({ nodeId: '3' });
  assert.deepEqual([tree.children[0].stopped, tree.children[0].retired?.reason], ['RETIRED', 'Stolen']);
  assert.deepEqual((await talk.suspend({ nodeId: '3', reason: 'x' })).notice, { told: [], unreachable: [], failed: [] }, 'the notice passes it by');
  await talk.resume({ nodeId: '3' });
  assert.deepEqual((await talk.checkChildren({ nodeId: '3' })).dropped, [], 'check-children keeps the record');

  // It comes back: its check-in is answered with the retirement, and it retires its own record.
  laptopOnline = true;
  const back = await talk.checkIn({ nodeId: '3-3', nodeAddress: 'http://laptop' });
  assert.deepEqual([back.state, 'retired' in back && back.retired?.reason], ['RETIRED_WHILE_AWAY', 'Stolen']);
  assert.equal((await laptop.describe('3-3'))!.status, 'RETIRED');
  await assert.rejects(() => laptop.issueBasis('3-3'), /retired/);
  assert.equal((await office.describe('3'))!.childCount, 0, 'coming back does not put it back on the list');

  // Only a user or a machine: anything else has its own list of children on its machine.
  await office.accept({ id: '5', type: 'ORGANIZATION' });
  await office.issueChildId('5', { type: 'GROUP', address: 'http://laptop' });
  laptopOnline = false;
  await assert.rejects(() => talk.retireAway({ nodeId: '5-3', nodeAddress: 'http://laptop', parentId: '5', reason: 'Gone' }), /Only a user or a machine/);
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
