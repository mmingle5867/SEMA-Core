import assert from 'node:assert/strict';
import net from 'node:net';
import { InMemorySemaCoreHostStore, LocalCoreHostAuthorization, SemaCore, SemaCoreHost, startCoreHostHttpServer } from '../src/index.js';

const store = new InMemorySemaCoreHostStore();
const core = new SemaCore(store, { installationId: '3', maxReservationSize: 25 });
const host = new SemaCoreHost(core, store, new LocalCoreHostAuthorization(new Set(['vectorforge'])));
await host.initialize({ actorId: 'vectorforge' });
const server = await startCoreHostHttpServer(host, { port: 0, applicationClients: [{ applicationKey: 'vectorforge', secret: 's3cret' }] });
const base = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
const as = (key: string, secret?: string) => ({ 'x-sema-application-key': key, ...(secret === undefined ? {} : { 'x-sema-application-secret': secret }), 'content-type': 'application/json' });

// Every request must prove which registered application is calling.
assert.equal((await fetch(`${base}/v1/core/health`)).status, 401);
assert.equal((await fetch(`${base}/v1/core/health`, { headers: as('vectorforge') })).status, 401);
assert.equal((await fetch(`${base}/v1/core/health`, { headers: as('vectorforge', 'wrong') })).status, 401);
assert.equal((await fetch(`${base}/v1/core/health`, { headers: as('unknown', 's3cret') })).status, 401);
assert.equal((await fetch(`${base}/v1/core/health`, { headers: { 'x-sema-actor-id': 'vectorforge' } })).status, 401, 'actor id alone is not a credential');
assert.equal((await fetch(`${base}/v1/core/health`, { headers: as('vectorforge', 's3cret') })).status, 200);

// Command status update and command lookup are served over HTTP.
const created = await fetch(`${base}/v1/core/runtime/commands`, { method: 'POST', headers: as('vectorforge', 's3cret'), body: JSON.stringify({ commandType: 'cred.test' }) });
assert.equal(created.status, 201);
const command = await created.json() as { id: string };
const status = await fetch(`${base}/v1/core/runtime/commands/status`, { method: 'POST', headers: as('vectorforge', 's3cret'), body: JSON.stringify({ commandId: command.id, status: 'RUNNING' }) });
assert.equal(status.status, 200);
const fetched = await fetch(`${base}/v1/core/runtime/commands?id=${encodeURIComponent(command.id)}`, { headers: as('vectorforge', 's3cret') });
assert.equal(((await fetched.json()) as { id: string }).id, command.id);
const listed = await fetch(`${base}/v1/core/runtime/commands?commandTypePrefix=cred.`, { headers: as('vectorforge', 's3cret') });
assert.equal(((await listed.json()) as unknown[]).length, 1);

server.close();
console.log('SEMA Core application credential tests passed.');
