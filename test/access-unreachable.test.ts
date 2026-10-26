import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import net from 'node:net';
import { FoundationPolicyAuthorization, InMemoryLocalNodeStore, InMemorySemaCoreHostStore, LocalNodes, SemaCore, SemaCoreHost, startCoreHostHttpServer } from '../src/index.js';

// When Foundation Access cannot answer, Core refuses and says why in plain words.
const clients = [{ applicationKey: 'console', secret: 'console-secret' }];
let answer = 200;
let sent: Record<string, unknown> = {};
const choices = { lists: [['neo.ai.claude']], way: 'dynamic', approvalRequired: false, approved: [] };
const access = createServer(async (request, response) => {
  if (answer !== 200) { response.writeHead(answer, { 'content-type': 'application/json' }); return response.end('{}'); }
  if (request.method === 'GET') {
    // A note on a capability or a service: one exists for neo.ai.claude only.
    const found = request.url === '/v1/access/item-notes/service/neo.ai.claude' && request.headers['x-sema-access-policy-key'] === 'policy-key';
    response.writeHead(found ? 200 : 404, { 'content-type': 'application/json' });
    return response.end(JSON.stringify(found ? { kind: 'service', key: 'neo.ai.claude', summary: 'Claude' } : { error: 'No note' }));
  }
  let text = ''; for await (const chunk of request) text += chunk;
  sent = JSON.parse(text) as Record<string, unknown>;
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ allowed: true, ...(sent.capabilityKey ? { organizationId: '3-9rJ', choices } : {}) }));
});
await new Promise<void>((resolve) => access.listen(0, '127.0.0.1', resolve));
const accessUrl = `http://127.0.0.1:${(access.address() as net.AddressInfo).port}`;

const policy = new FoundationPolicyAuthorization(accessUrl, 'policy-key', clients);
assert.equal(await policy.canRead({ actorId: 'console', resource: 'core.topology.read' }), true);
assert.equal(await policy.canRead({ actorId: 'stranger', resource: 'core.topology.read' }), false, 'an unknown caller is refused without asking');
// A capability command: Core sends the capability, job and workspace, and gets the organization's choices back (D-193).
assert.deepEqual(await policy.mayRunCapability({ actorId: 'console', capabilityKey: 'sema.ai.generate', jobKey: 'listing-copy', workspaceId: '3-9rK' }), { allowed: true, choices, organizationId: '3-9rJ' });
assert.deepEqual(sent, { applicationKey: 'console', operation: 'capability.sema.ai.generate', capabilityKey: 'sema.ai.generate', jobKey: 'listing-copy', workspaceId: '3-9rK' });
assert.deepEqual(await policy.mayRunCapability({ actorId: 'stranger', capabilityKey: 'sema.ai.generate' }), { allowed: false });
// Notes for descriptions (D-199): read with the policy key; none is not an error.
assert.deepEqual(await policy.itemNote('service', 'neo.ai.claude'), { note: { kind: 'service', key: 'neo.ai.claude', summary: 'Claude' } });
assert.deepEqual(await policy.itemNote('capability', 'neo.ai.claude'), {});
answer = 401;
await assert.rejects(() => policy.canRead({ actorId: 'console', resource: 'core.topology.read' }), /refused Core's policy key.*SEMA_POLICY_KEY/);
answer = 500;
await assert.rejects(() => policy.canRead({ actorId: 'console', resource: 'core.topology.read' }), /answered with an error \(500\)/);
answer = 404;
assert.equal(await policy.canRead({ actorId: 'console', resource: 'core.topology.read' }), false, 'any other answer is a plain refusal');

// Over HTTP, through Core: Access stopped.
answer = 200;
const store = new InMemorySemaCoreHostStore();
const core = new SemaCore(store, { installationId: '3', maxReservationSize: 25 });
const host = new SemaCoreHost(core, store, policy, undefined, new LocalNodes(new InMemoryLocalNodeStore()));
await host.initialize({ actorId: 'console' });
const server = await startCoreHostHttpServer(host, { port: 0, applicationClients: clients });
const coreUrl = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
const get = async (path: string) => { const response = await fetch(coreUrl + path, { headers: { 'x-sema-application-key': 'console', 'x-sema-application-secret': 'console-secret' } }); return { status: response.status, payload: await response.json() as any }; };
assert.equal((await get('/v1/core/topology/local')).status, 200);
access.close();
await new Promise((resolve) => setTimeout(resolve, 50));
const down = await get('/v1/core/topology/local');
assert.deepEqual([down.status, down.payload.error.code], [503, 'UNAVAILABLE']);
assert.equal(down.payload.error.message, `Foundation Access is not reachable at ${accessUrl}, so Core cannot check permissions. Start Foundation Access`);
assert.deepEqual(await policy.itemNote('service', 'neo.ai.claude'), { unavailable: `Foundation Access is not reachable at ${accessUrl}` }, 'a description still comes without its note');
server.close();

console.log('Access unreachable test passed.');
