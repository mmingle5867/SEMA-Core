import assert from 'node:assert/strict';
import { Conversations, type NodePeer, type PeerDirectory } from '../src/topology/conversations.js';
import { InMemoryLocalNodeStore, LocalNodes } from '../src/topology/local-nodes.js';

// One simulated Core per node. `down` marks machines that cannot be reached right now.
const cores = new Map<string, LocalNodes>();
const down = new Set<string>();
// Addresses belong to machines, not to node IDs. Each simulated node sits on its own machine.
const machine = new Map<string, string>();
let machines = 0;
const addressOf = (id: string) => machine.get(id)!;
const wrong: string[] = [];
// The directory refuses to answer for an address that is not the machine holding the node, and the test checks none was used.
const directory: PeerDirectory = { async find(id, address) {
  if (address !== undefined && address !== machine.get(id)) { wrong.push(`${id} at ${address}`); return undefined; }
  return cores.has(id) && !down.has(id) ? cores.get(id) : undefined;
} };
const talk = new Conversations(directory);
const fresh = () => new LocalNodes(new InMemoryLocalNodeStore());
const place = (id: string, peer: LocalNodes, address = `core-m${++machines}.example`) => { cores.set(id, peer); machine.set(id, address); return peer; };
const count = async (id: string) => (await cores.get(id)!.describe(id))!.childCount;
const parentOf = async (id: string) => (await cores.get(id)!.describe(id))!.parentId;

// The central authority allocates the top node. Children are issued by their parent's Core and accepted by their own.
await place('3', fresh(), 'core-top.example').accept({ id: '3', type: 'SITE' });
const make = async (parentId: string) => {
  const peer = fresh();
  const address = `core-m${++machines}.example`;
  const created = await talk.createNode({ parentId, parentAddress: addressOf(parentId), type: 'SITE', newNodePeer: peer, newNodeAddress: address });
  place(created.id, peer, address);
  return created.id;
};
const a = await make('3'), b = await make(a), c = await make(b);
assert.deepEqual([a, b, c], ['3-3', '3-3-3', '3-3-3-3']);
assert.equal(await count('3'), 1);
assert.equal(await parentOf(c), b);

// Walking up asks each parent in turn, and stops at a machine that cannot be reached.
assert.deepEqual((await talk.walkUp(c, addressOf(c))).chain.map((n) => n.id), [b, a, '3']);
down.add(a);
const broken = await talk.walkUp(c, addressOf(c));
assert.deepEqual(broken.chain.map((n) => n.id), [b]);
assert.deepEqual(broken.stoppedAt, { nodeId: a, reason: 'UNREACHABLE' });
down.delete(a);

// A failed accept: the entry comes off the parent's list only when the new node's Core says plainly it does not hold the node.
const refusing = { accept: async () => { throw new Error('refused'); }, describe: async () => undefined } as unknown as NodePeer;
await assert.rejects(() => talk.createNode({ parentId: '3', parentAddress: addressOf('3'), type: 'MACHINE', newNodePeer: refusing }), /refused/);
assert.equal(await count('3'), 1, 'the new Core said it does not hold the node, so the parent took it off its list');
// When that cannot be known, the entry stays: one too many, never one too few.
const silent = { accept: async () => { throw new Error('timed out'); }, describe: async () => { throw new Error('unreachable'); } } as unknown as NodePeer;
machine.set('3-5', 'core-silent.example'); // a machine that never answers
await assert.rejects(() => talk.createNode({ parentId: '3', parentAddress: addressOf('3'), type: 'MACHINE', newNodePeer: silent, newNodeAddress: 'core-silent.example' }), /timed out/);
assert.equal(await count('3'), 2, 'the parent keeps the entry it cannot confirm');
assert.deepEqual(await talk.checkChildren({ nodeId: '3', nodeAddress: addressOf('3') }), { kept: [a], dropped: [], unreachable: ['3-5'], unknown: [] }, 'checking keeps an entry nobody can speak for');
await cores.get('3')!.removeChild('3', '3-5'); // tidied by hand for the rest of this test

// Roll-up with everything reachable: the highest reachable ancestor issues, giving the shortest basis allowed.
const rolled = await talk.rollUp({ nodeId: c, nodeAddress: addressOf(c) });
assert.deepEqual(rolled, { issuerId: '3', previousBasis: '3-3-3-3', basis: '3-6' }, 'ancestor 3 issued 3-3, then burned 3-4 and 3-5 on the two failed creates, so the next value is 3-6');
assert.equal(await count('3'), 1, 'a roll-up is not a child');
const grandchild = await make(c);
assert.equal(grandchild, '3-6-3', 'new children come from the new basis');
await assert.rejects(() => talk.rollUp({ nodeId: c, nodeAddress: addressOf(c) }), /shorter/);

// Roll-up while the top is unreachable never takes a number from it.
const d = await make(b);                         // 3-3-3-4, basis 3-3-3-4
down.add('3');
const sub = await talk.rollUp({ nodeId: d, nodeAddress: addressOf(d) });
assert.equal(sub.issuerId, a, 'the highest node that can still be reached issues');
assert.match(sub.basis, /^3-3-\d|^3-3-[0-9A-Za-z]+$/);
assert.equal(sub.basis.split('-').length, 3);
down.delete('3');

// Insert a new node N between a and b: a keeps its count, N counts one, b points to N.
const aBefore = await count(a);
const nPeer = fresh();
const nAddress = 'core-inserted.example';
const inserted = await talk.insertAbove({ childId: b, childAddress: addressOf(b), type: 'SITE', newNodePeer: nPeer, newNodeAddress: nAddress });
place(inserted.id, nPeer, nAddress);
assert.equal(await parentOf(b), inserted.id);
assert.equal(await parentOf(inserted.id), a);
assert.equal(await count(inserted.id), 1);
assert.equal((await nPeer.describe(inserted.id))!.type, 'SITE', 'the inserted node has the type it was given');
assert.equal(await count(a), aBefore, 'a gained N and lost b');

// Rehome b under the top node. Counts follow; a cycle is refused; so is an unreachable old parent.
await assert.rejects(() => talk.rehome({ nodeId: b, nodeAddress: addressOf(b), newParentId: b, newParentAddress: addressOf(b) }), /own parent/);
// Moving a node under its own descendant is not pre-checked: it would need every ancestor online. If it ever happens, walking up reports it.
await talk.rehome({ nodeId: a, nodeAddress: addressOf(a), newParentId: c, newParentAddress: addressOf(c), administratorOverride: true });
await assert.rejects(() => talk.walkUp(c, addressOf(c)), /Cycle in parent pointers/);
await talk.rehome({ nodeId: a, nodeAddress: addressOf(a), newParentId: '3', newParentAddress: addressOf('3'), administratorOverride: true });
assert.deepEqual((await talk.walkUp(c, addressOf(c))).chain.map((n) => n.id), [b, inserted.id, a, '3']);
down.add(inserted.id);
await assert.rejects(() => talk.rehome({ nodeId: b, nodeAddress: addressOf(b), newParentId: '3', newParentAddress: addressOf('3') }), /old parent is not reachable/);
const forced = await talk.rehome({ nodeId: b, nodeAddress: addressOf(b), newParentId: '3', newParentAddress: addressOf('3'), administratorOverride: true });
assert.deepEqual(forced, { changed: true, oldParentListStale: true });
assert.equal(await count(inserted.id), 1, 'the unreachable old parent keeps a count that is too high');
down.delete(inserted.id);
assert.equal(await parentOf(b), '3');

// Remove b: it is retired, its count goes to its parent, and its children are NOT rewritten.
const topBefore = await count('3');
const bChildren = await count(b);
const removed = await talk.remove({ nodeId: b, nodeAddress: addressOf(b) });
assert.deepEqual(removed, { parentId: '3', childCount: bChildren });
assert.equal(await count('3'), topBefore + bChildren - 1);
assert.equal((await cores.get(b)!.describe(b))!.status, 'RETIRED');
assert.equal(await parentOf(d), b, 'the child still points at the retired node');

// The child follows the chain later and fixes its own pointer.
assert.deepEqual(await talk.repairParent(d, addressOf(d)), { changed: true, parentId: '3' });
assert.equal(await parentOf(d), '3');
assert.deepEqual(await talk.repairParent(d, addressOf(d)), { changed: false }, 'nothing to repair once the parent is live');
assert.deepEqual((await talk.nearestLiveAncestor(b, addressOf(b))).ancestor?.id, '3');

// Removing the top node: its children need a named destination, and its pointer is set so they can follow the chain.
await assert.rejects(() => talk.remove({ nodeId: '3', nodeAddress: addressOf('3') }), /no parent/);
const heir = await make('3');
const topCount = await count('3');
const topRemoved = await talk.remove({ nodeId: '3', nodeAddress: addressOf('3'), childrenParentId: heir, childrenParentAddress: addressOf(heir) });
assert.equal(topRemoved.parentId, heir);
assert.equal(await parentOf('3'), heir);
assert.deepEqual((await cores.get(heir)!.children(heir)).map((child) => child.childId).sort(), (await cores.get('3')!.children('3')).map((child) => child.childId).filter((id) => id !== heir).sort(), 'the heir takes every other child of the top node, and never lists itself');
assert.equal(topCount > 1, true);
await assert.rejects(() => talk.remove({ nodeId: '3', nodeAddress: addressOf('3') }), /retired/);

assert.deepEqual(wrong, [], 'every address used was the right machine for its node');
console.log('Core conversations test passed.');
