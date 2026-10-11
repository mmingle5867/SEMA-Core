import assert from 'node:assert/strict';
import net from 'node:net';
import { InMemorySemaCoreHostStore, LocalCoreHostAuthorization, SemaCore, SemaCoreHost, startCoreHostHttpServer } from '../src/index.js';

const store = new InMemorySemaCoreHostStore();
const core = new SemaCore(store, { installationId: '3', maxReservationSize: 25 });
const host = new SemaCoreHost(core, store, new LocalCoreHostAuthorization(new Set(['admin'])));
await host.initialize({ actorId: 'admin' });

const server = await startCoreHostHttpServer(host, { port: 0 });
const { port } = server.address() as net.AddressInfo;
const base = `http://127.0.0.1:${port}`;
const admin = { 'x-sema-actor-id': 'admin' };

/** Sends a hand-written request line, which fetch() would refuse to produce, and returns the HTTP status. */
function rawStatus(requestLine: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => socket.write(`${requestLine}\r\nHost: localhost\r\nConnection: close\r\n\r\n`));
    let received = '';
    socket.on('data', (chunk) => { received += chunk.toString('utf8'); });
    socket.on('error', reject);
    socket.on('close', () => resolve(Number(/^HTTP\/1\.1 (\d{3})/.exec(received)?.[1] ?? 0)));
  });
}

async function put(body: string, headers: Record<string, string> = admin) {
  const response = await fetch(`${base}/v1/core/settings`, { method: 'PUT', headers, body });
  return { status: response.status, body: await response.json() as { error?: { code: string }; revision?: number; values?: Record<string, unknown> } };
}

// A malformed request path must be rejected, never crash the process or be reinterpreted.
assert.equal(await rawStatus('GET // HTTP/1.1'), 400);
assert.equal(await rawStatus('GET //v1/core/health HTTP/1.1'), 400);
assert.equal(await rawStatus('GET http://example.test/v1/core/health HTTP/1.1'), 400);
assert.equal((await fetch(`${base}/v1/core/health`)).status, 403); // anonymous callers are no longer administrators
const health = await fetch(`${base}/v1/core/health`, { headers: admin });
assert.equal(health.status, 200);
assert.equal(((await health.json()) as { status: string }).status, 'ACTIVE');

assert.equal((await fetch(`${base}/v1/core/unknown`)).status, 404);

// Request bodies: invalid JSON, non-objects and oversize bodies are client errors.
assert.deepEqual((await put('{not json')).body.error?.code, 'INVALID_REQUEST');
assert.equal((await put('[1,2]')).status, 400);
assert.equal((await put('null')).status, 400);
assert.equal((await put('"abc"')).status, 400);
assert.equal((await put(JSON.stringify({ maxReservationSize: 10, padding: 'x'.repeat(300 * 1024) }))).status, 413);

// Settings: only known keys with the right types are accepted, and a rejected update changes nothing.
for (const bad of [
  { foo: 1 },
  { documentationEnabled: 'yes' },
  { capabilityAutoFallback: 42 },
  { maxReservationSize: '5' },
  { maxReservationSize: 0 },
  { maxReservationSize: 1.5 },
  { maxReservationSize: 100_001 },
  { auditRetentionDays: -1 },
]) {
  const result = await put(JSON.stringify(bad));
  assert.equal(result.status, 400, `expected 400 for ${JSON.stringify(bad)}`);
}
assert.equal((await host.getSettings({ actorId: 'admin' })).revision, 1);
assert.equal(core.getMaxReservationSize(), 25);

// An unknown actor is refused; a configured administrator succeeds and the runtime limit follows.
assert.equal((await put(JSON.stringify({ maxReservationSize: 50 }), { 'x-sema-actor-id': 'nobody' })).status, 403);
const updated = await put(JSON.stringify({ maxReservationSize: 50 }));
assert.equal(updated.status, 200);
assert.equal(updated.body.revision, 2);
assert.equal(updated.body.values?.maxReservationSize, 50);
assert.equal(core.getMaxReservationSize(), 50);

// Reserved future-use settings can still be stored with the right types.
const reserved = await put(JSON.stringify({ documentationEnabled: false, capabilityAutoFallback: false, auditRetentionDays: 30, eventRetentionDays: 30 }));
assert.equal(reserved.status, 200);
assert.equal(reserved.body.values?.documentationEnabled, false);

server.close();
server.closeAllConnections();
console.log('SEMA Core Host HTTP tests passed.');
