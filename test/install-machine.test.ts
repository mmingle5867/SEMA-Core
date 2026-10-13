import assert from 'node:assert/strict';
import net from 'node:net';
import { FIRST_NODE_ID, RESERVED_TOP_LEVEL_LIMIT, TOP_LEVEL_BLOCK_COUNT, encodeBase56, formatInstallCode, parseInstallCode, topLevelBlockRange, HttpPeerDirectory, InMemoryLocalNodeStore, InMemorySemaCoreHostStore, LocalCoreHostAuthorization, LocalNodes, SemaCore, SemaCoreHost, joiningPeer, resolveStart, startCoreHostHttpServer, startJoinServer, type JoinRequest, type NodeDescription } from '../src/index.js';

// Install codes. The first IDs 3 to zzzzz are reserved and assigned one at a time; a code carries one, with check characters.
assert.equal(FIRST_NODE_ID, '3');
assert.equal(RESERVED_TOP_LEVEL_LIMIT, BigInt(550731776));
const codeFor4 = formatInstallCode('4');
assert.match(codeFor4, /^S1\.4\.[0-9A-Za-z]+$/);
assert.equal(parseInstallCode(codeFor4), '4');
assert.equal(parseInstallCode('  ' + codeFor4 + '  '), '4', 'spaces around a pasted code are ignored');
assert.equal(parseInstallCode(formatInstallCode('zzzzz')), 'zzzzz', 'the last reserved ID');
assert.throws(() => parseInstallCode(codeFor4.slice(0, -1) + (codeFor4.endsWith('2') ? '3' : '2')), /typing mistake/);
assert.throws(() => parseInstallCode(codeFor4.replace('.4.', '.5.')), /typing mistake/, 'the check characters belong to one ID');
for (const bad of ['', '4', 'S1.4', 'S2.4.abc', 'S1.3-3.abc', 'S1.24.abc', 'S1.1.abc', 'S1.2.abc', formatInstallCode('322222')]) assert.throws(() => parseInstallCode(bad), /not a SEMA install code/, `refused: ${bad}`);

// How a Core starts. Its database decides which node it is; an ID typed into its settings never does.
assert.deepEqual(resolveStart({ storedId: '3' }), { mode: 'run', installationId: '3' });
assert.deepEqual(resolveStart({ storedId: '3', configuredId: '3' }), { mode: 'run', installationId: '3' }, 'the setting may stay as a cross-check');
assert.deepEqual(resolveStart({ storedId: '3-7', installCode: codeFor4 }), { mode: 'run', installationId: '3-7' }, 'a Core with an identity keeps it, whatever code it is given');
assert.throws(() => resolveStart({ storedId: '3-7', configuredId: '3' }), /cannot be changed by its settings/);
assert.deepEqual(resolveStart({}), { mode: 'join' }, 'a Core with no identity waits to be joined');
assert.deepEqual(resolveStart({ configuredId: '3' }), { mode: 'join' }, 'a typed ID alone does not create an identity');
assert.deepEqual(resolveStart({ configuredId: '9-9' }), { mode: 'join' });
assert.deepEqual(resolveStart({ installCode: codeFor4 }), { mode: 'run', installationId: '4' }, 'an install code makes it the first machine of the system it was assigned');
assert.deepEqual(resolveStart({ installCode: codeFor4, configuredId: '4' }), { mode: 'run', installationId: '4' });
assert.throws(() => resolveStart({ installCode: codeFor4, configuredId: '3' }), /install code assigns 4/);
assert.throws(() => resolveStart({ installCode: 'S1.4.wrong' }), /typing mistake/, 'a bad code stops the start; it does not fall back to waiting');

// A Core that has not joined answers its health and the join request, and nothing else.
const recorded: JoinRequest[] = [];
const record = async (request: JoinRequest): Promise<NodeDescription> => { recorded.push(request); return { id: request.id, type: 'MACHINE', parentId: request.parentId, ...(request.parentAddress ? { parentAddress: request.parentAddress } : {}), basis: request.id, childCount: 0, status: 'ACTIVE' }; };
const addressOf = (server: { address(): unknown }) => `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
const send = async (base: string, path: string, body?: unknown) => {
  const response = await fetch(base + path, { method: body ? 'POST' : 'GET', headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  return { status: response.status, payload: await response.json() as any };
};
{
  const closed = await startJoinServer({ port: 0, version: 'test', record });
  const base = addressOf(closed.server);
  assert.deepEqual((await send(base, '/v1/core/health')).payload, { status: 'NOT_JOINED', version: 'test' });
  assert.equal((await send(base, '/v1/core/topology/local')).status, 503);
  assert.equal((await send(base, '/v1/core/topology/create', { parentId: '3', type: 'USER' })).status, 503);
  const refused = await send(base, '/v1/core/join', { id: '3-3', parentId: '3', joinCode: '' });
  assert.equal(refused.status, 503, 'a Core with no join code cannot be joined');
  assert.equal(refused.payload.error.code, 'NO_JOIN_CODE');
  closed.server.close();
}
const waiting = await startJoinServer({ port: 0, version: 'test', joinCode: 'the-join-code', record });
const newCore = addressOf(waiting.server);
assert.equal((await send(newCore, '/v1/core/join', { id: '3-3', parentId: '3', joinCode: 'wrong' })).status, 403);
assert.equal((await send(newCore, '/v1/core/join', { id: '3-3', parentId: '3' })).status, 403);
assert.equal((await send(newCore, '/v1/core/join', { id: '3--3', parentId: '3', joinCode: 'the-join-code' })).status, 400);
assert.equal((await send(newCore, '/v1/core/join', { id: '3', parentId: '3', joinCode: 'the-join-code' })).status, 400);
assert.equal((await send(newCore, '/v1/core/join', { id: '3-3', joinCode: 'the-join-code' })).status, 400, 'a joining Core must be told its parent');
assert.equal(recorded.length, 0, 'a refused request records nothing');

// An existing Core installs it: the parent issues the ID and counts the child, and the new Core records it.
const credentials = { applicationKey: 'peer', secret: 'peer-secret' };
async function startCore(withAddress: boolean) {
  const store = new InMemorySemaCoreHostStore();
  const core = new SemaCore(store, { installationId: '3', maxReservationSize: 25 });
  const nodes = new LocalNodes(new InMemoryLocalNodeStore());
  const holder: { topology?: ConstructorParameters<typeof SemaCoreHost>[5] } = {};
  const host = new SemaCoreHost(core, store, new LocalCoreHostAuthorization(new Set(['peer'])), undefined, nodes, { get peers() { return holder.topology!.peers; }, get address() { return holder.topology!.address; }, joining: joiningPeer } as NonNullable<ConstructorParameters<typeof SemaCoreHost>[5]>);
  await host.initialize({ actorId: 'peer' });
  const server = await startCoreHostHttpServer(host, { port: 0, applicationClients: [credentials] });
  const address = addressOf(server);
  holder.topology = { address: withAddress ? address : undefined, peers: new HttpPeerDirectory({ credentials, local: { address, peer: nodes } }) };
  const post = async (path: string, body: unknown) => {
    const response = await fetch(address + path, { method: 'POST', headers: { 'x-sema-application-key': 'peer', 'x-sema-application-secret': 'peer-secret', 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, payload: await response.json() as any };
  };
  await nodes.accept({ id: '3', type: 'MACHINE' });
  return { server, address, nodes, post, store };
}
const A = await startCore(true);

// A wrong join code: the new Core refuses, the parent takes the child back off its count, and the number is spent.
let r = await A.post('/v1/core/topology/install-machine', { parentId: '3', newCoreAddress: newCore, joinCode: 'wrong' });
assert.ok(r.status >= 400);
assert.match(r.payload.error.message, /join code is not correct/);
assert.equal((await A.nodes.describe('3'))!.childCount, 0);
assert.equal(recorded.length, 0);

r = await A.post('/v1/core/topology/install-machine', { parentId: '3', newCoreAddress: newCore, joinCode: 'the-join-code' });
assert.equal(r.status, 201);
assert.deepEqual(r.payload, { id: '3-4', type: 'MACHINE', parentId: '3', parentAddress: A.address, basis: '3-4', childCount: 0, status: 'ACTIVE', address: newCore });
assert.deepEqual(recorded, [{ id: '3-4', parentId: '3', parentAddress: A.address }], 'the new Core was told its ID and where its parent lives');
assert.deepEqual(await waiting.joinedAs, { id: '3-4', parentId: '3', parentAddress: A.address });
assert.equal((await A.nodes.describe('3'))!.childCount, 1);
assert.equal(await A.nodes.describe('3-4'), undefined, 'the new node lives on the new machine, not here');
const audits = JSON.stringify(A.store.audits);
assert.ok(audits.includes('core.topology.machine-installed') && audits.includes('3-4'), 'the install is audited');
assert.ok(!audits.includes('the-join-code'), 'the join code is never recorded');

// A Core joins once. A second install aimed at it is refused, and the parent's count is handed back.
r = await A.post('/v1/core/topology/install-machine', { parentId: '3', newCoreAddress: newCore, joinCode: 'the-join-code' });
assert.ok(r.status >= 400);
assert.match(r.payload.error.message, /already joined/);
assert.equal((await A.nodes.describe('3'))!.childCount, 1);
assert.equal(recorded.length, 1);

// What the request must say, and what this Core needs before it can install anything.
assert.equal((await A.post('/v1/core/topology/install-machine', { parentId: '3', newCoreAddress: newCore })).status, 400);
assert.equal((await A.post('/v1/core/topology/install-machine', { parentId: '3', joinCode: 'x' })).status, 400);
assert.equal((await A.post('/v1/core/topology/install-machine', { parentId: '3', newCoreAddress: A.address, joinCode: 'x' })).status, 400, 'the new machine cannot be this Core');
const B = await startCore(false);
r = await B.post('/v1/core/topology/install-machine', { parentId: '3', newCoreAddress: newCore, joinCode: 'the-join-code' });
assert.equal(r.status, 400);
assert.match(r.payload.error.message, /must be able to reach its parent/);
assert.equal((await B.nodes.listWithNextId())[0].nextId, '3-3', 'nothing was issued');

// First IDs are assigned from blocks of a million, so losing one Core never loses the ability to assign them.
assert.equal(TOP_LEVEL_BLOCK_COUNT, 551);
assert.deepEqual(topLevelBlockRange(0), { start: BigInt(2), end: BigInt(1_000_000) }, 'block 0 skips the unused value and the original system');
assert.deepEqual(topLevelBlockRange(1), { start: BigInt(1_000_000), end: BigInt(2_000_000) });
assert.deepEqual(topLevelBlockRange(550), { start: BigInt(550_000_000), end: RESERVED_TOP_LEVEL_LIMIT }, 'the last block stops at the end of the reserve');
for (const bad of [-1, 551, 1.5]) assert.throws(() => topLevelBlockRange(bad), /whole number from 0 to 550/);
{
  const granted = new Set(['core.topology.write']);
  const make = async (installationId: string) => { const store = new InMemorySemaCoreHostStore(); const host = new SemaCoreHost(new SemaCore(store, { installationId, maxReservationSize: 25 }), store, { canRead: async ({ resource }) => granted.has(resource), canAdminister: async ({ resource }) => granted.has(resource) }); await host.initialize({ actorId: 'admin' }); return { host, store }; };
  const admin = { actorId: 'admin' };

  // The original system holds block 0 without being given it, and assigns one ID per code.
  const original = await make('3');
  await assert.rejects(() => original.host.issueInstallCode(admin), /not authorized/, 'being allowed to change the tree is not enough');
  await assert.rejects(() => original.host.firstIdBlockStatus(admin), /not authorized/);
  for (const permission of ['core.authority.issue-install-code', 'core.authority.read']) granted.add(permission);
  assert.deepEqual(await original.host.firstIdBlockStatus(admin), { block: 0, firstId: '4', lastId: encodeBase56(BigInt(999_999)), nextId: '4', remaining: 999_998 });
  const first = await original.host.issueInstallCode(admin, { note: 'Example Company' });
  assert.deepEqual(first, { id: '4', installCode: formatInstallCode('4'), block: 0, remaining: 999_997 });
  assert.equal(parseInstallCode(first.installCode), '4');
  assert.equal((await original.host.issueInstallCode(admin)).id, '5', 'each code assigns the next ID, never the same one twice');
  assert.equal((await original.host.issueInstallCode(admin)).id, '6');
  const audits = JSON.stringify(original.store.audits);
  assert.ok(audits.includes('core.authority.install-code-issued') && audits.includes('Example Company'), 'each assignment is audited with its note');

  // Another Core cannot assign first IDs until it is given a block of its own.
  const standby = await make('3-7');
  assert.equal(await standby.host.firstIdBlockStatus(admin), null);
  await assert.rejects(() => standby.host.issueInstallCode(admin), /holds no block/);
  await assert.rejects(() => standby.host.grantFirstIdBlock(admin, { block: 1 }), /not authorized/, 'granting a block has its own permission');
  granted.add('core.authority.grant-block');
  await assert.rejects(() => standby.host.grantFirstIdBlock(admin, { block: 0 }), /belongs to the original system/);
  for (const bad of [-1, 551, 1.5, '1']) await assert.rejects(() => standby.host.grantFirstIdBlock(admin, { block: bad as number }), /whole number from 0 to 550/);
  const million = encodeBase56(BigInt(1_000_000));
  assert.deepEqual(await standby.host.grantFirstIdBlock(admin, { block: 1, note: 'Standby at the second site' }), { block: 1, firstId: million, lastId: encodeBase56(BigInt(1_999_999)), nextId: million, remaining: 1_000_000 });
  assert.ok(JSON.stringify(standby.store.audits).includes('core.authority.block-granted'));

  // The failsafe: with the original gone, the standby carries on from its own block. Nothing overlaps.
  const fromStandby = await standby.host.issueInstallCode(admin);
  assert.deepEqual(fromStandby, { id: million, installCode: formatInstallCode(million), block: 1, remaining: 999_999 });
  assert.equal(parseInstallCode(fromStandby.installCode), million);
  assert.equal(million.length, 4, 'an ID from block 1 is still short');
  assert.equal((await original.host.issueInstallCode(admin)).id, '7', 'and the original, if it is still there, is unaffected');

  // A block is never dropped while it has values left, and is never handed out past its end.
  await assert.rejects(() => standby.host.grantFirstIdBlock(admin, { block: 2 }), /already holds block 1/);
  await assert.rejects(() => original.host.grantFirstIdBlock(admin, { block: 3 }), /already holds block 0/);
  const small = await make('3-8');
  await small.store.grantTopLevelBlock({ block: 9, start: BigInt(9_000_000), end: BigInt(9_000_002) }); // a two-value block, to reach its end
  assert.equal((await small.host.issueInstallCode(admin)).remaining, 1);
  assert.deepEqual(await small.host.firstIdBlockStatus(admin), { block: 9, firstId: encodeBase56(BigInt(9_000_000)), lastId: encodeBase56(BigInt(9_000_001)), nextId: encodeBase56(BigInt(9_000_001)), remaining: 1 });
  assert.equal((await small.host.issueInstallCode(admin)).remaining, 0);
  await assert.rejects(() => small.host.issueInstallCode(admin), /Block 9 is used up/);
  assert.equal((await small.host.firstIdBlockStatus(admin))!.nextId, null);
  await assert.rejects(() => small.host.grantFirstIdBlock(admin, { block: 9 }), /Grant a different block/);
  assert.equal((await small.host.grantFirstIdBlock(admin, { block: 10 })).block, 10, 'a used-up block can be replaced');
  assert.equal((await small.host.issueInstallCode(admin)).id, encodeBase56(BigInt(10_000_000)));
}

for (const server of [A.server, B.server, waiting.server]) server.close();
console.log('Install machine test passed.');
