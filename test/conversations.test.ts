import assert from 'node:assert/strict';
import { Conversations, type NodePeer, type PeerDirectory } from '../src/topology/conversations.js';
import { InMemoryLocalNodeStore, LocalNodes } from '../src/topology/local-nodes.js';

// One simulated Core per node. `down` marks machines that cannot be reached right now.
const cores = new Map<string, LocalNodes>();
const down = new Set<string>();
const directory: PeerDirectory = { async find(id) { return cores.has(id) && !down.has(id) ? cores.get(id) : undefined; } };
const talk = new Conversations(directory);
const fresh = () => new LocalNodes(new InMemoryLocalNodeStore());
const place = (id: string, peer: LocalNodes) => { cores.set(id, peer); return peer; };
const count = async (id: string) => (await cores.get(id)!.describe(id))!.childCount;
const parentOf = async (id: string) => (await cores.get(id)!.describe(id))!.parentId;

// The central authority allocates the top node. Children are issued by their parent's Core and accepted by their own.
await place('3', fresh()).accept({ id: '3' });
const make = async (parentId: string) => {
  const peer = fresh();
  const created = await talk.createNode({ parentId, newNodePeer: peer });
  place(created.id, peer);
  return created.id;
};
const a = await make('3'), b = await make(a), c = await make(b);
assert.deepEqual([a, b, c], ['3-3', '3-3-3', '3-3-3-3']);
assert.equal(await count('3'), 1);
assert.equal(await parentOf(c), b);

// Walking up asks each parent in turn, and stops at a machine that cannot be reached.
assert.deepEqual((await talk.walkUp(c)).chain.map((n) => n.id), [b, a, '3']);
down.add(a);
const broken = await talk.walkUp(c);
assert.deepEqual(broken.chain.map((n) => n.id), [b]);
assert.deepEqual(broken.stoppedAt, { nodeId: a, reason: 'UNREACHABLE' });
down.delete(a);

// A failed accept hands the count back.
const refusing = { ...fresh(), accept: async () => { throw new Error('refused'); } } as unknown as NodePeer;
await assert.rejects(() => talk.createNode({ parentId: '3', newNodePeer: refusing }), /refused/);
assert.equal(await count('3'), 1, 'the issuing parent took the child back off its count');

// Roll-up with everything reachable: the highest reachable ancestor issues, giving the shortest basis allowed.
const rolled = await talk.rollUp({ nodeId: c });
assert.deepEqual(rolled, { issuerId: '3', previousBasis: '3-3-3-3', basis: '3-5' }, 'ancestor 3 issued 3-3, then burned 3-4 on the refused create, so the next value is 3-5');
assert.equal(await count('3'), 1, 'a roll-up is not a child');
const grandchild = await make(c);
assert.equal(grandchild, '3-5-3', 'new children come from the new basis');
await assert.rejects(() => talk.rollUp({ nodeId: c }), /shorter/);

// Roll-up while the top is unreachable never takes a number from it.
const d = await make(b);                         // 3-3-3-4, basis 3-3-3-4
down.add('3');
const sub = await talk.rollUp({ nodeId: d });
assert.equal(sub.issuerId, a, 'the highest node that can still be reached issues');
assert.match(sub.basis, /^3-3-\d|^3-3-[0-9A-Za-z]+$/);
assert.equal(sub.basis.split('-').length, 3);
down.delete('3');

// Insert a new node N between a and b: a keeps its count, N counts one, b points to N.
const aBefore = await count(a);
const nPeer = fresh();
const inserted = await talk.insertAbove({ childId: b, newNodePeer: nPeer });
place(inserted.id, nPeer);
assert.equal(await parentOf(b), inserted.id);
assert.equal(await parentOf(inserted.id), a);
assert.equal(await count(inserted.id), 1);
assert.equal(await count(a), aBefore, 'a gained N and lost b');

// Rehome b under the top node. Counts follow; a cycle is refused; so is an unreachable old parent.
await assert.rejects(() => talk.rehome({ nodeId: '3', newParentId: c }), /descendant/);
await assert.rejects(() => talk.rehome({ nodeId: b, newParentId: b }), /descendant/);
down.add(inserted.id);
await assert.rejects(() => talk.rehome({ nodeId: b, newParentId: '3' }), /old parent is not reachable/);
const forced = await talk.rehome({ nodeId: b, newParentId: '3', administratorOverride: true });
assert.deepEqual(forced, { changed: true, oldParentCountStale: true });
assert.equal(await count(inserted.id), 1, 'the unreachable old parent keeps a count that is too high');
down.delete(inserted.id);
assert.equal(await parentOf(b), '3');

// Remove b: it is retired, its count goes to its parent, and its children are NOT rewritten.
const topBefore = await count('3');
const bChildren = await count(b);
const removed = await talk.remove({ nodeId: b });
assert.deepEqual(removed, { parentId: '3', childCount: bChildren });
assert.equal(await count('3'), topBefore + bChildren - 1);
assert.equal((await cores.get(b)!.describe(b))!.status, 'RETIRED');
assert.equal(await parentOf(d), b, 'the child still points at the retired node');

// The child follows the chain later and fixes its own pointer.
assert.deepEqual(await talk.repairParent(d), { changed: true, parentId: '3' });
assert.equal(await parentOf(d), '3');
assert.deepEqual(await talk.repairParent(d), { changed: false }, 'nothing to repair once the parent is live');
assert.deepEqual((await talk.nearestLiveAncestor(b)).ancestor?.id, '3');

// Removing the top node: its children need a named destination, and its pointer is set so they can follow the chain.
await assert.rejects(() => talk.remove({ nodeId: '3' }), /no parent/);
const heir = await make('3');
const topCount = await count('3');
const topRemoved = await talk.remove({ nodeId: '3', childrenParentId: heir });
assert.equal(topRemoved.parentId, heir);
assert.equal(await parentOf('3'), heir);
assert.equal((await cores.get(heir)!.describe(heir))!.childCount >= topCount - 1, true);
await assert.rejects(() => talk.remove({ nodeId: '3' }), /retired/);

console.log('Core conversations test passed.');
