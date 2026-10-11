import assert from 'node:assert/strict';
import { InMemoryTopologyStore, SemaTopology } from '../src/topology/topology.js';

const store = new InMemoryTopologyStore();
const topology = new SemaTopology(store);
const all = () => true;
const get = async (id: string) => (await store.getNode(id))!;

// Build a chain: 3 > 3-3 > 3-3-3 > 3-3-3-3 (each node issues its first child from its own ID as basis).
const top = await topology.registerTopNode('3');
const a = await topology.createNode({ parentId: top.id });
const b = await topology.createNode({ parentId: a.id });
const c = await topology.createNode({ parentId: b.id });
assert.deepEqual([a.id, b.id, c.id], ['3-3', '3-3-3', '3-3-3-3']);
assert.equal(c.basis, c.id, 'a new node starts with its own ID as basis');
assert.equal((await topology.createNode({ parentId: top.id })).id, '3-4', 'the counter moves forward');

// Roll-up: c (basis length 4) takes a fresh basis from reachable ancestor 3; only the basis changes.
const before = await get(c.id);
const rolled = await topology.rollUp({ nodeId: c.id, issuerId: top.id, isReachable: all });
assert.equal(rolled.previousBasis, '3-3-3-3');
assert.equal(rolled.basis, '3-5', 'ancestor 3 had issued 3-3 and 3-4, so the next value is 3-5');
const after = await get(c.id);
assert.equal(after.id, before.id);
assert.equal(after.parentId, before.parentId);
const child = await topology.createNode({ parentId: c.id });
assert.equal(child.id, '3-5-3', 'new children come from the new basis, counter restarted');
assert.equal((await topology.createNode({ parentId: c.id })).id, '3-5-4');
assert.equal(child.basis, '3-5-3', 'the child starts with its own ID as basis');
assert.equal((await topology.createNode({ parentId: child.id })).id, '3-5-3-3');

// Roll-up refusals change nothing.
await assert.rejects(() => topology.rollUp({ nodeId: c.id, issuerId: top.id, isReachable: () => false }), /not reachable/);
await assert.rejects(() => topology.rollUp({ nodeId: a.id, issuerId: c.id, isReachable: all }), /ancestor/);
await assert.rejects(() => topology.rollUp({ nodeId: c.id, issuerId: top.id, isReachable: all }), /shorter/);
assert.equal((await get(c.id)).basis, '3-5');
assert.equal((await topology.createNode({ parentId: top.id })).id, '3-6', 'a refused roll-up used no number');

// Insertion changes two pointers and no IDs.
const inserted = await topology.insertAbove({ childId: b.id });
assert.equal(inserted.parentId, a.id);
assert.equal((await get(b.id)).parentId, inserted.id);
assert.equal((await get(b.id)).id, '3-3-3');

// Rehoming moves the subtree, and refuses a cycle.
await topology.rehome({ nodeId: b.id, parentId: top.id });
assert.equal((await get(c.id)).parentId, b.id, 'the subtree follows');
await assert.rejects(() => topology.rehome({ nodeId: top.id, parentId: c.id }), /descendant/);
await assert.rejects(() => topology.rehome({ nodeId: b.id, parentId: c.id }), /descendant/);

// Removal gives the children to the parent; the retired node keeps its own pointer.
const removal = await topology.remove({ nodeId: b.id });
assert.deepEqual(removal.repointed, [c.id]);
assert.equal((await get(c.id)).parentId, top.id);
assert.equal((await get(b.id)).status, 'RETIRED');
assert.equal((await get(b.id)).parentId, top.id);
await assert.rejects(() => topology.createNode({ parentId: b.id }), /retired/);
assert.equal((await topology.nearestLiveAncestor(b.id))?.id, top.id);

// The top node has no parent, so its children need a named destination.
await assert.rejects(() => topology.remove({ nodeId: top.id }), /no parent/);

// A value has exactly one holder, and a failed operation rolls back completely.
await assert.rejects(() => store.recordHolder('3-5', 'someone-else'), /already has a holder/);
const nodesBefore = store.nodes.size;
await assert.rejects(() => topology.remove({ nodeId: top.id, childrenParentId: top.id }), /Children cannot be given/);
assert.equal(store.nodes.size, nodesBefore);
assert.equal((await get(top.id)).status, 'ACTIVE');

console.log('Topology test passed.');
