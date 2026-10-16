import assert from 'node:assert/strict';
import net from 'node:net';
import { HttpPeerDirectory, InMemoryLocalNodeStore, InMemorySemaCoreHostStore, LocalNodes, SemaCore, SemaCoreHost, startCoreHostHttpServer, type CoreHostAuthorization } from '../src/index.js';

// A company and a person first recorded in Foundation Access, with IDs this Core issued, become nodes keeping
// those IDs, so nothing that already points at them is renumbered.
const credentials = { applicationKey: 'peer', secret: 'peer-secret' };
const granted = new Set(['core.topology.read', 'core.topology.write']);
const authorization: CoreHostAuthorization = { canRead: async ({ resource }) => granted.has(resource), canAdminister: async ({ resource }) => granted.has(resource) };
const store = new InMemorySemaCoreHostStore();
const core = new SemaCore(store, { installationId: '3', maxReservationSize: 25 });
const nodes = new LocalNodes(new InMemoryLocalNodeStore());
const holder: { topology?: ConstructorParameters<typeof SemaCoreHost>[5] } = {};
const host = new SemaCoreHost(core, store, authorization, undefined, nodes, { get peers() { return holder.topology!.peers; }, get address() { return holder.topology!.address; } } as NonNullable<ConstructorParameters<typeof SemaCoreHost>[5]>);
await host.initialize({ actorId: 'peer' });
const server = await startCoreHostHttpServer(host, { port: 0, applicationClients: [credentials] });
const address = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
holder.topology = { address, peers: new HttpPeerDirectory({ credentials, local: { address, peer: nodes } }) };
const post = async (path: string, body: unknown) => {
  const response = await fetch(address + path, { method: 'POST', headers: { 'x-sema-application-key': 'peer', 'x-sema-application-secret': 'peer-secret', 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: response.status, payload: await response.json() as any };
};
const adopt = (body: unknown) => post('/v1/core/topology/adopt-issued', body);

// The machine node exists from the start. Access asked this Core for IDs before any of them were nodes.
const person = await core.issueIdentifier('USER', { purpose: 'initial-owner' });
const company = await core.issueIdentifier('ORGANIZATION', { purpose: 'initial-owner-organization' });
const workspace = await core.issueIdentifier('WORKSPACE', { organizationId: company.id });
const reserved = (await core.reserveIdentifiers(1, 'USER')).identifiers[0]!;

// Being allowed to change the tree is not enough: it has its own permission.
assert.equal((await adopt({ id: company.id, type: 'ORGANIZATION' })).status, 403);
assert.equal(await nodes.describe(company.id), undefined, 'a refused request records nothing');
granted.add('core.authority.adopt-issued');

// The company becomes a top node with no parent, then the person a user under it. The IDs do not change.
let r = await adopt({ id: company.id, type: 'ORGANIZATION' });
assert.equal(r.status, 201);
assert.deepEqual(r.payload, { id: company.id, type: 'ORGANIZATION', basis: company.id, childCount: 0, seats: { users: { used: 0 }, machines: { used: 0 } }, status: 'ACTIVE', address });
r = await adopt({ id: person.id, type: 'USER', parentId: company.id });
assert.equal(r.status, 201);
assert.equal(r.payload.parentId, company.id);
assert.deepEqual(await nodes.children(company.id), [{ childId: person.id, type: 'USER', address }], 'the parent lists the node it took');
assert.equal((await nodes.describe(company.id))!.seats!.users.used, 1, 'an adopted user takes a seat');

// The new nodes issue their own children from their own IDs.
assert.equal((await nodes.issueChildId(company.id, { type: 'SITE' })).value, `${company.id}-3`);
await nodes.accept({ id: `${company.id}-3`, type: 'SITE', parentId: company.id });

// Refusals, each before anything is recorded.
assert.equal((await adopt({ id: company.id, type: 'ORGANIZATION' })).status, 400, 'already a node');
assert.match((await adopt({ id: workspace.id, type: 'GROUP' })).payload.error.message, /issued as WORKSPACE, not GROUP/, 'a workspace is not a node');
assert.match((await adopt({ id: person.id, type: 'ORGANIZATION' })).payload.error.message, /issued as USER|already a node/);
assert.match((await adopt({ id: reserved.id, type: 'USER', parentId: company.id })).payload.error.message, /never taken into use/);
assert.match((await adopt({ id: '7-9', type: 'USER' })).payload.error.message, /not issued by this Core/);
assert.equal((await adopt({ id: company.id, type: 'PRINTER' })).status, 400);
const other = await core.issueIdentifier('USER');
assert.match((await adopt({ id: other.id, type: 'USER', parentId: `${company.id}-3` })).payload.error.message, /A USER cannot sit under a SITE/, 'the placement rule still holds');
assert.equal(await nodes.describe(other.id), undefined, 'and the refused node is not recorded');
assert.deepEqual((await nodes.children(`${company.id}-3`)), [], 'nor listed');

server.close();
console.log('Adopt issued ID test passed.');
