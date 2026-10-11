import assert from 'node:assert/strict';
import { InMemoryTopologyStore, SemaTopology } from '../src/topology/topology.js';

const store = new InMemoryTopologyStore();
const topology = new SemaTopology(store, () => '2026-10-11T00:00:00.000Z');
const all = () => true;

// Build the example chain: 3 > 3-3 > 3-3-3 > 3-3-3-3 (each node issues its first child from its own ID as basis).
const top = topology.registerTopNode('3');
const a = topology.createNode({ parentId: top.id });
const b = topology.createNode({ parentId: a.id });
const c = topology.createNode({ parentId: b.id });
assert.deepEqual([a.id, b.id, c.id], ['3-3', '3-3-3', '3-3-3-3']);
assert.equal(c.basis, c.id, 'a new node starts with its own ID as basis');
assert.equal(topology.createNode({ parentId: top.id }).id, '3-4', 'the counter moves forward');

// Roll-up: c (basis length 4) takes a fresh basis from reachable ancestor 3; only the basis changes.
const before = store.getNode(c.id)!;
const rolled = topology.rollUp({ nodeId: c.id, issuerId: top.id, isReachable: all });
assert.equal(rolled.previousBasis, '3-3-3-3');
assert.equal(rolled.basis, '3-5', 'ancestor 3 had issued 3-3 and 3-4, so the next value is 3-5');
const after = store.getNode(c.id)!;
assert.equal(after.id, before.id);
assert.equal(after.parentId, before.parentId);
const child = topology.createNode({ parentId: c.id });
assert.equal(child.id, '3-5-3', 'new children come from the new basis, counter restarted');
assert.equal(topology.createNode({ parentId: c.id }).id, '3-5-4');
assert.equal(child.basis, '3-5-3', 'the child starts with its own ID as basis');
assert.equal(topology.createNode({ parentId: child.id }).id, '3-5-3-3');

// Roll-up refusals.
assert.throws(() => topology.rollUp({ nodeId: c.id, issuerId: top.id, isReachable: () => false }), /not reachable/);
assert.throws(() => topology.rollUp({ nodeId: a.id, issuerId: c.id, isReachable: all }), /ancestor/);
assert.throws(() => topology.rollUp({ nodeId: c.id, issuerId: top.id, isReachable: all }), /shorter/);
assert.equal(store.getNode(c.id)!.basis, '3-5', 'a refused roll-up changes nothing');

// Insertion changes two pointers and no IDs.
const inserted = topology.insertAbove({ childId: b.id });
assert.equal(inserted.parentId, a.id);
assert.equal(store.getNode(b.id)!.parentId, inserted.id);
assert.equal(store.getNode(b.id)!.id, '3-3-3');

// Rehoming moves the subtree, and refuses a cycle.
topology.rehome({ nodeId: b.id, parentId: top.id });
assert.equal(store.getNode(c.id)!.parentId, b.id, 'the subtree follows');
assert.throws(() => topology.rehome({ nodeId: top.id, parentId: c.id }), /descendant/);
assert.throws(() => topology.rehome({ nodeId: b.id, parentId: c.id }), /descendant/);

// Removal gives the children to the parent; the retired node keeps its own pointer.
const removal = topology.remove({ nodeId: b.id });
assert.deepEqual(removal.repointed, [c.id]);
assert.equal(store.getNode(c.id)!.parentId, top.id);
assert.equal(store.getNode(b.id)!.status, 'RETIRED');
assert.equal(store.getNode(b.id)!.parentId, top.id);
assert.throws(() => topology.createNode({ parentId: b.id }), /retired/);
assert.equal(topology.nearestLiveAncestor(b.id)?.id, top.id);

// The top node has no parent, so its children need a named destination.
assert.throws(() => topology.remove({ nodeId: top.id }), /no parent/);

// A value has exactly one holder.
assert.throws(() => store.recordHolder('3-5', 'someone-else'), /already has a holder/);

console.log('Topology test passed.');
