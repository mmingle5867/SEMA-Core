import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import net from 'node:net';
import { FoundationPolicyAuthorization, InMemoryLocalNodeStore, InMemorySemaCoreHostStore, LocalNodes, SemaCore, SemaCoreHost, startCoreHostHttpServer } from '../src/index.js';

// When Foundation Access cannot answer, Core refuses and says why in plain words.
const clients = [{ applicationKey: 'console', secret: 'console-secret' }];
let answer = 200;
const access = createServer((request, response) => {
  if (answer !== 200) { response.writeHead(answer, { 'content-type': 'application/json' }); return response.end('{}'); }
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ allowed: true }));
});
await new Promise<void>((resolve) => access.listen(0, '127.0.0.1', resolve));
const accessUrl = `http://127.0.0.1:${(access.address() as net.AddressInfo).port}`;

const policy = new FoundationPolicyAuthorization(accessUrl, 'policy-key', clients);
assert.equal(await policy.canRead({ actorId: 'console', resource: 'core.topology.read' }), true);
assert.equal(await policy.canRead({ actorId: 'stranger', resource: 'core.topology.read' }), false, 'an unknown caller is refused without asking');
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
server.close();

console.log('Access unreachable test passed.');
