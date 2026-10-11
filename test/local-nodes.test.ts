import assert from 'node:assert/strict';
import { InMemoryLocalNodeStore, LocalNodes } from '../src/topology/local-nodes.js';

// Each machine's Core holds only its own node. Cross-machine work is a conversation between them.
const machine = () => new LocalNodes(new InMemoryLocalNodeStore());
const m3 = machine(), m33 = machine(), m333 = machine(), m3333 = machine();
const owner: Record<string, LocalNodes> = { '3': m3, '3-3': m33, '3-3-3': m333, '3-3-3-3': m3333 };

// Central authority allocates the top node; each child is issued by its parent's Core and accepted by its own.
await m3.accept({ id: '3' });
for (const [parent, child, machineOfChild] of [['3', '3-3', m33], ['3-3', '3-3-3', m333], ['3-3-3', '3-3-3-3', m3333]] as const) {
  const issued = await owner[parent].issueChildId(parent);
  assert.equal(issued.value, child);
  await machineOfChild.accept({ id: issued.value, parentId: parent });
}
assert.deepEqual(await m3333.describe('3-3-3-3'), { id: '3-3-3-3', parentId: '3-3-3', basis: '3-3-3-3', childCount: 0, status: 'ACTIVE' });
assert.equal((await m3.describe('3'))!.childCount, 1);
assert.equal((await m3.issueChildId('3')).value, '3-4', 'the counter moves forward');
assert.equal((await m3.describe('3'))!.childCount, 2);

// A node can only be asked about on the machine that holds it.
assert.equal(await m3.describe('3-3'), undefined);
await assert.rejects(() => m3.issueChildId('3-3'), /does not exist on this Core/);
await assert.rejects(() => m3.accept({ id: '3' }), /already exists/);

// Walking up the tree is a chain of questions; nothing is cached.
const walkUp = async (id: string) => { const chain: string[] = []; for (let d = await owner[id].describe(id); d?.parentId; d = await owner[d.parentId].describe(d.parentId)) chain.push(d.parentId); return chain; };
assert.deepEqual(await walkUp('3-3-3-3'), ['3-3-3', '3-3', '3']);

// Roll-up: ancestor 3 issues a fresh value (not a child, so its count is unchanged); the node adopts it.
const countBefore = (await m3.describe('3'))!.childCount;
const fresh = await m3.issueBasis('3');
assert.equal(fresh.value, '3-5');
assert.equal((await m3.describe('3'))!.childCount, countBefore);
const rolled = await m3333.setBasis('3-3-3-3', fresh.value);
assert.deepEqual(rolled, { previousBasis: '3-3-3-3', basis: '3-5' });
const after = (await m3333.describe('3-3-3-3'))!;
assert.equal(after.id, '3-3-3-3');
assert.equal(after.parentId, '3-3-3');
const grandchild = await m3333.issueChildId('3-3-3-3');
assert.equal(grandchild.value, '3-5-3', 'new children come from the new basis, counter restarted');
assert.equal((await m3333.issueChildId('3-3-3-3')).value, '3-5-4');
await assert.rejects(() => m3333.setBasis('3-3-3-3', '3-6'), /shorter/);
await assert.rejects(() => m3333.setBasis('3-3-3-3', '3-5-3-3'), /shorter/);
assert.equal((await m3333.describe('3-3-3-3'))!.basis, '3-5');

// Insert N between P=3-3 and c=3-3-3: P issues N and keeps its count (gains N, loses c); c points to N.
const nIssue = await m33.issueChildId('3-3');
assert.equal(nIssue.value, '3-3-4');
const mN = machine(); owner[nIssue.value] = mN;
await mN.accept({ id: nIssue.value, parentId: '3-3' });
await m33.adjustChildCount('3-3', -1);
await mN.adjustChildCount(nIssue.value, 1);
await m333.setParent('3-3-3', nIssue.value);
assert.equal((await m33.describe('3-3'))!.childCount, 1);
assert.equal((await mN.describe(nIssue.value))!.childCount, 1);
assert.deepEqual(await walkUp('3-3-3-3'), ['3-3-3', '3-3-4', '3-3', '3']);

// Rehome 3-3-3 from N to the top node: only its pointer moves, and the two counts follow.
await m333.setParent('3-3-3', '3');
await mN.adjustChildCount('3-3-4', -1);
await m3.adjustChildCount('3', 1);
assert.equal((await mN.describe('3-3-4'))!.childCount, 0);
assert.deepEqual(await walkUp('3-3-3-3'), ['3-3-3', '3']);

// Counts never go below zero.
await assert.rejects(() => mN.adjustChildCount('3-3-4', -1), /below zero/);

// Remove 3-3-3 (child count 1): it is retired, and its count goes to its parent less itself. Its child keeps a stale pointer.
const retired = await m333.retire('3-3-3');
assert.deepEqual(retired, { parentId: '3', childCount: 1 });
await m3.adjustChildCount('3', retired.childCount - 1);
const gone = (await m333.describe('3-3-3'))!;
assert.equal(gone.status, 'RETIRED');
assert.equal(gone.childCount, 0);
assert.equal(gone.parentId, '3', 'a retired node keeps its own pointer');
await assert.rejects(() => m333.issueChildId('3-3-3'), /retired/);
await assert.rejects(() => m333.setParent('3-3-3', '3'), /retired/);
// The child follows the chain lazily: its pointer names a retired node, whose pointer names the live ancestor.
const stale = (await m3333.describe('3-3-3-3'))!;
assert.equal(stale.parentId, '3-3-3');
const parentOfStale = (await m333.describe(stale.parentId!))!;
assert.equal(parentOfStale.status, 'RETIRED');
await m3333.setParent('3-3-3-3', parentOfStale.parentId!);
assert.deepEqual(await walkUp('3-3-3-3'), ['3']);

console.log('Local nodes test passed.');
