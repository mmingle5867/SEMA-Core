import assert from 'node:assert/strict';
import { Conversations } from '../src/topology/conversations.js';
import { InMemoryLocalNodeStore, LocalNodes, type NodeType } from '../src/topology/local-nodes.js';

// A roll-up stays inside the node's own organization: the issuer is its nearest organization ancestor or a node
// between. One simulated Core holds every node here; addresses do not matter for this rule.
const nodes = new LocalNodes(new InMemoryLocalNodeStore());
const talk = new Conversations({ find: async () => nodes });
const add = async (parentId: string, type: NodeType) => (await talk.createNode({ parentId, type, newNodePeer: nodes })).id;

// A reseller, a company under it, a division of the company, and people several groups deep in the division.
await nodes.accept({ id: '5', type: 'ORGANIZATION' });
const company = await add('5', 'ORGANIZATION');          // 5-3
const division = await add(company, 'ORGANIZATION');     // 5-3-3
const team = await add(division, 'GROUP');               // 5-3-3-3
const unit = await add(team, 'GROUP');                   // 5-3-3-3-3
const deep = await add(unit, 'GROUP');                   // 5-3-3-3-3-3
assert.deepEqual([company, division, team, unit, deep], ['5-3', '5-3-3', '5-3-3-3', '5-3-3-3-3', '5-3-3-3-3-3']);

// By default the division issues: the highest node inside the node's own organization, not the company or the reseller.
const rolled = await talk.rollUp({ nodeId: deep });
assert.deepEqual(rolled, { issuerId: division, previousBasis: deep, basis: '5-3-3-4' });

// A named issuer inside the organization is used as given; one outside it is refused, and nothing is issued.
const other = await add(unit, 'GROUP');                  // 5-3-3-3-3-4
assert.equal((await talk.rollUp({ nodeId: other, issuerId: team })).basis, '5-3-3-3-4');
const third = await add(unit, 'GROUP');                  // 5-3-3-3-3-5
await assert.rejects(() => talk.rollUp({ nodeId: third, issuerId: company }), /inside the node's own organization/);
await assert.rejects(() => talk.rollUp({ nodeId: third, issuerId: '5' }), /inside the node's own organization/);
assert.equal((await nodes.listWithNextId()).find((node) => node.id === company)!.nextId, '5-3-4', 'the refused issuer issued nothing');

// An organization node has nothing above it inside itself, so it cannot roll up yet: going to a parent
// organization needs a segment limit it is over, and none exists.
await assert.rejects(() => talk.rollUp({ nodeId: division }), /organization node has no ancestor inside its own organization/);

// A node with no organization above it may use any reachable ancestor, as before.
const plain = new LocalNodes(new InMemoryLocalNodeStore());
const plainTalk = new Conversations({ find: async () => plain });
await plain.accept({ id: '7', type: 'SITE' });
let parent = '7';
for (let i = 0; i < 3; i += 1) parent = (await plainTalk.createNode({ parentId: parent, type: 'SITE', newNodePeer: plain })).id;
assert.deepEqual(await plainTalk.rollUp({ nodeId: parent }), { issuerId: '7', previousBasis: '7-3-3-3', basis: '7-4' });

// If the walk stops at an unreachable node before reaching the organization, only nodes inside are ever used.
const split = new Map<string, LocalNodes>();
const splitTalk = new Conversations({ find: async (id) => split.get(id) });
const top = new LocalNodes(new InMemoryLocalNodeStore()), middle = new LocalNodes(new InMemoryLocalNodeStore()), low = new LocalNodes(new InMemoryLocalNodeStore());
await top.accept({ id: '9', type: 'ORGANIZATION' }); split.set('9', top);
const g1 = await splitTalk.createNode({ parentId: '9', type: 'GROUP', newNodePeer: middle }); split.set(g1.id, middle);
const g2 = await splitTalk.createNode({ parentId: g1.id, type: 'GROUP', newNodePeer: middle }); split.set(g2.id, middle);
const g3 = await splitTalk.createNode({ parentId: g2.id, type: 'GROUP', newNodePeer: low }); split.set(g3.id, low);
split.delete('9'); // the organization's machine cannot be reached
assert.equal((await splitTalk.rollUp({ nodeId: g3.id })).issuerId, g1.id, 'the highest node that can still be reached inside the organization issues');

console.log('Roll-up test passed.');
