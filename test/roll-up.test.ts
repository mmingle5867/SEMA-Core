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

// Key limits: optional, set only on an organization node, a preference that never affects uniqueness.
await assert.rejects(() => nodes.setKeyLimits(team, { maxSegments: 4 }), /must be set on an organization node, and 5-3-3-3 is a GROUP/);
await assert.rejects(() => nodes.setKeyLimits(division, { maxSegments: 1 }), /maxSegments must be a whole number from 2 to 64/);
await assert.rejects(() => nodes.setKeyLimits(division, { maxSegmentLength: 3, maxLastSegmentLength: 2 }), /may be longer, never shorter/);
await assert.rejects(() => nodes.setKeyLimits(division, { maxDigits: 3 } as never), /Unknown key limit: maxDigits/);
assert.deepEqual((await nodes.setKeyLimits(division, { maxSegments: 4, maxSegmentLength: 2, maxLastSegmentLength: 5 })).keyLimits, { maxSegments: 4, maxSegmentLength: 2, maxLastSegmentLength: 5 });
assert.deepEqual((await nodes.describe(division))!.keyLimits, { maxSegments: 4, maxSegmentLength: 2, maxLastSegmentLength: 5 }, 'other Cores see the limits when they ask');
assert.equal((await nodes.describe(company))!.keyLimits, undefined, 'an organization with no limits shows none');

// Under the division's limit of 4 segments, a node whose basis has 6 may go outside the division; one with 4 may not.
const over = await add(unit, 'GROUP');                   // 5-3-3-3-3-6, six segments
assert.deepEqual(await talk.rollUp({ nodeId: over }), { issuerId: '5', previousBasis: over, basis: '5-4' }, 'over the limit, the highest reachable node issues, outside the division');
const near = await add(team, 'GROUP');                   // 5-3-3-3-5, five segments, still over 4
assert.equal((await talk.rollUp({ nodeId: near, issuerId: company })).issuerId, company, 'a named issuer in the parent organization is allowed when over the limit');
await nodes.setKeyLimits(division, { maxSegments: 6 });
const under = await add(team, 'GROUP');                  // 5-3-3-3-6, five segments, now under 6
await assert.rejects(() => talk.rollUp({ nodeId: under, issuerId: company }), /unless its basis is over the organization's segment limit/);
assert.equal((await talk.rollUp({ nodeId: under })).issuerId, division, 'under the limit it stays inside the division');

// An organization node over its own limit may go to its parent organization.
const sub = await add(division, 'ORGANIZATION');         // 5-3-3-5, four segments
await assert.rejects(() => talk.rollUp({ nodeId: sub }), /organization node has no ancestor inside its own organization/);
await nodes.setKeyLimits(sub, { maxSegments: 3 });
assert.deepEqual(await talk.rollUp({ nodeId: sub }), { issuerId: '5', previousBasis: sub, basis: '5-5' });

// Clearing: null, or nothing, removes the limits.
assert.equal((await nodes.setKeyLimits(division, null)).keyLimits, undefined);
assert.equal((await nodes.setKeyLimits(sub, {})).keyLimits, undefined);

console.log('Roll-up test passed.');
