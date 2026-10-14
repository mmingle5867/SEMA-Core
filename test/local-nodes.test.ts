import assert from 'node:assert/strict';
import { InMemoryLocalNodeStore, LocalNodes } from '../src/topology/local-nodes.js';

// Each machine's Core holds only its own node. Cross-machine work is a conversation between them.
const machine = () => new LocalNodes(new InMemoryLocalNodeStore());
const m3 = machine(), m33 = machine(), m333 = machine(), m3333 = machine();
const owner: Record<string, LocalNodes> = { '3': m3, '3-3': m33, '3-3-3': m333, '3-3-3-3': m3333 };
const ids = async (nodes: LocalNodes, id: string) => (await nodes.children(id)).map((child) => child.childId);

// Central authority allocates the top node; each child is issued by its parent's Core and accepted by its own.
// Issuing a child's ID puts it on the parent's list in the same step.
await m3.accept({ id: '3', type: 'MACHINE' });
for (const [parent, child, machineOfChild] of [['3', '3-3', m33], ['3-3', '3-3-3', m333], ['3-3-3', '3-3-3-3', m3333]] as const) {
  const issued = await owner[parent].issueChildId(parent, { type: 'MACHINE', address: `http://${child}.example` });
  assert.equal(issued.value, child);
  assert.equal(issued.childCount, 1);
  await machineOfChild.accept({ id: issued.value, type: 'MACHINE', parentId: parent });
}
assert.deepEqual(await m3333.describe('3-3-3-3'), { id: '3-3-3-3', type: 'MACHINE', parentId: '3-3-3', basis: '3-3-3-3', childCount: 0, status: 'ACTIVE' });
assert.deepEqual(await m3.children('3'), [{ childId: '3-3', type: 'MACHINE', address: 'http://3-3.example' }], 'the parent knows its child and where it lives');
assert.equal((await m3.listWithNextId())[0].nextId, '3-4', 'the next ID is the basis plus the next number');
assert.equal((await m3.issueChildId('3', { type: 'USER' })).value, '3-4', 'the counter moves forward');
assert.equal((await m3.listWithNextId())[0].nextId, '3-5');
assert.equal((await m3.describe('3'))!.childCount, 2, 'the count is the length of the list');
assert.deepEqual(await ids(m3, '3'), ['3-3', '3-4']);

// Every node names its type when it is recorded, and nothing changes it afterwards: not a rehome, a roll-up or a retire.
await assert.rejects(() => machine().accept({ id: '3-9' } as never), /ORGANIZATION, GROUP, USER or MACHINE/);
await assert.rejects(() => machine().accept({ id: '3-9', type: 'PRINTER' } as never), /ORGANIZATION, GROUP, USER or MACHINE/);
await assert.rejects(() => m3.issueChildId('3', { type: 'PRINTER' } as never), /ORGANIZATION, GROUP, USER or MACHINE/);
const person = machine();
await person.accept({ id: '3-9', type: 'USER', parentId: '3' });
assert.equal((await person.setParent('3-9', '3-3')).type, 'USER');
await person.retire('3-9');
assert.equal((await person.describe('3-9'))!.type, 'USER');

// A node can only be asked about on the machine that holds it.
assert.equal(await m3.describe('3-3'), undefined);
await assert.rejects(() => m3.issueChildId('3-3', { type: 'USER' }), /does not exist on this Core/);
await assert.rejects(() => m3.children('3-3'), /does not exist on this Core/);
await assert.rejects(() => m3.accept({ id: '3', type: 'MACHINE' }), /already exists/);

// Walking up the tree is a chain of questions; nothing is cached.
const walkUp = async (id: string) => { const chain: string[] = []; for (let d = await owner[id].describe(id); d?.parentId; d = await owner[d.parentId].describe(d.parentId)) chain.push(d.parentId); return chain; };
assert.deepEqual(await walkUp('3-3-3-3'), ['3-3-3', '3-3', '3']);

// Roll-up: ancestor 3 issues a fresh value (not a child, so its list is unchanged); the node adopts it.
const fresh = await m3.issueBasis('3');
assert.equal(fresh.value, '3-5');
assert.deepEqual(await ids(m3, '3'), ['3-3', '3-4'], 'issuing a basis is not adding a child');
const rolled = await m3333.setBasis('3-3-3-3', fresh.value);
assert.deepEqual(rolled, { previousBasis: '3-3-3-3', basis: '3-5' });
const after = (await m3333.describe('3-3-3-3'))!;
assert.equal(after.id, '3-3-3-3');
assert.equal(after.parentId, '3-3-3');
assert.equal(after.type, 'MACHINE', 'a roll-up changes only the basis');
assert.equal((await m3333.issueChildId('3-3-3-3', { type: 'USER' })).value, '3-5-3', 'new children come from the new basis, counter restarted');
assert.equal((await m3333.issueChildId('3-3-3-3', { type: 'USER' })).value, '3-5-4');
await assert.rejects(() => m3333.setBasis('3-3-3-3', '3-6'), /shorter/);
await assert.rejects(() => m3333.setBasis('3-3-3-3', '3-5-3-3'), /shorter/);
assert.equal((await m3333.describe('3-3-3-3'))!.basis, '3-5');
assert.equal((await m3333.listWithNextId())[0].nextId, '3-5-5', 'after a roll-up the next ID comes from the new basis');

// Insert N between P=3-3 and c=3-3-3: P issues N, N lists c, c points to N, and only then does P let c go.
const nIssue = await m33.issueChildId('3-3', { type: 'GROUP', address: 'http://n.example' });
assert.equal(nIssue.value, '3-3-4');
const mN = machine(); owner[nIssue.value] = mN;
await mN.accept({ id: nIssue.value, type: 'GROUP', parentId: '3-3' });
await mN.addChildren(nIssue.value, [{ childId: '3-3-3', type: 'MACHINE', address: 'http://3-3-3.example' }]);
await m333.setParent('3-3-3', nIssue.value);
assert.deepEqual(await ids(m33, '3-3'), ['3-3-3', '3-3-4'], 'part-way, the parent still lists c: one entry too many, never too few');
assert.deepEqual(await m33.removeChild('3-3', '3-3-3'), { removed: true, childCount: 1 });
assert.deepEqual(await ids(m33, '3-3'), ['3-3-4']);
assert.deepEqual(await ids(mN, '3-3-4'), ['3-3-3']);
assert.deepEqual(await walkUp('3-3-3-3'), ['3-3-3', '3-3-4', '3-3', '3']);

// Adding the same child again updates its entry and does not list it twice. Removing one that is not there says so.
assert.deepEqual(await mN.addChildren('3-3-4', [{ childId: '3-3-3', type: 'MACHINE', address: 'http://moved.example' }]), { childCount: 1 });
assert.equal((await mN.children('3-3-4'))[0].address, 'http://moved.example');
assert.deepEqual(await m33.removeChild('3-3', '3-3-3'), { removed: false, childCount: 1 });
await assert.rejects(() => mN.addChildren('3-3-4', [{ childId: '3-3-4', type: 'USER' }]), /its own child/);
await assert.rejects(() => mN.addChildren('3-3-4', [{ childId: '3--3', type: 'USER' }]), /hyphen-separated/);
await assert.rejects(() => mN.addChildren('3-3-4', [{ childId: '3-7', type: 'PRINTER' as never }]), /ORGANIZATION, GROUP, USER or MACHINE/);

// Rehome 3-3-3 from N to the top node: the new parent lists it first, then its pointer moves, then N lets it go.
await m3.addChildren('3', [{ childId: '3-3-3', type: 'MACHINE', address: 'http://3-3-3.example' }]);
await m333.setParent('3-3-3', '3');
await mN.removeChild('3-3-4', '3-3-3');
assert.equal((await mN.describe('3-3-4'))!.childCount, 0);
assert.deepEqual(await walkUp('3-3-3-3'), ['3-3-3', '3']);

// A list that may be incomplete says so, and is never treated as childless until it is marked complete.
assert.deepEqual(await mN.setChildListComplete('3-3-4', false), { childListComplete: false });
assert.deepEqual(await mN.describe('3-3-4'), { id: '3-3-4', type: 'GROUP', parentId: '3-3', basis: '3-3-4', childCount: 0, childListIncomplete: true, status: 'ACTIVE' });
await mN.setChildListComplete('3-3-4', true);
assert.equal((await mN.describe('3-3-4'))!.childListIncomplete, undefined);

// Retire 3-3-3: its record, its own pointer and its list stay as they were, and the list is handed back.
const retired = await m333.retire('3-3-3');
assert.deepEqual(retired, { parentId: '3', children: [{ childId: '3-3-3-3', type: 'MACHINE', address: 'http://3-3-3-3.example' }], childListComplete: true });
const gone = (await m333.describe('3-3-3'))!;
assert.equal(gone.status, 'RETIRED');
assert.equal(gone.parentId, '3', 'a retired node keeps its own pointer');
await assert.rejects(() => m333.issueChildId('3-3-3', { type: 'USER' }), /retired/);
await assert.rejects(() => m333.setParent('3-3-3', '3'), /retired/);
await assert.rejects(() => m333.addChildren('3-3-3', [{ childId: '3-3-3-9', type: 'USER' }]), /retired/, 'a retired node gains no children');
assert.equal((await m333.listWithNextId())[0].nextId, undefined, 'a retired node issues nothing');
// The child follows the chain lazily: its pointer names a retired node, whose pointer names the live ancestor.
const stale = (await m3333.describe('3-3-3-3'))!;
assert.equal(stale.parentId, '3-3-3');
const parentOfStale = (await m333.describe(stale.parentId!))!;
assert.equal(parentOfStale.status, 'RETIRED');
await m3.addChildren('3', [{ childId: '3-3-3-3', type: 'MACHINE' }]);
await m3333.setParent('3-3-3-3', parentOfStale.parentId!);
assert.deepEqual(await walkUp('3-3-3-3'), ['3']);

console.log('Local nodes test passed.');
