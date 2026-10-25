import assert from 'node:assert/strict';
import { createPublicKey, generateKeyPairSync, sign as signData, type JsonWebKey } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { componentValue, openCoreClientSigning, FileKeyStore, InMemoryClientKeyStore, InMemorySemaCoreHostStore, keyIdOf, LocalNodes, InMemoryLocalNodeStore, MemoryKeyStore, NonceMemory, parseSignature, parseSignatureInput, publicKeyFromJwk, SemaCore, SemaCoreHost, signatureBase, signP256, signRequest, startCoreHostHttpServer, verifyP256, verifyRequest, type CoreHostAuthorization, type SignableRequest } from '../src/index.js';

// ---- RFC 9421's own examples ----
// Figure 1 (§2.5): the signature base of the test request, character for character.
const testRequest: SignableRequest = {
  method: 'POST', authority: 'example.com', path: '/foo', search: '?param=Value&Pet=dog',
  headers: { 'content-type': 'application/json', 'content-length': '18', 'content-digest': 'sha-512=:WZDPaVn/7XgHaAy8pmojAkGWoRx2UFChF41A2svX+TaPm+AbwAgBWnrIiYllu7BNNyealdVLvRwEmTHWXvJwew==:' },
};
const figure1Params = '("@method" "@authority" "@path" "content-digest" "content-length" "content-type");created=1618884473;keyid="test-key-rsa-pss"';
assert.equal(signatureBase(['@method', '@authority', '@path', 'content-digest', 'content-length', 'content-type'], (component) => componentValue(testRequest, component), figure1Params), [
  '"@method": POST',
  '"@authority": example.com',
  '"@path": /foo',
  '"content-digest": sha-512=:WZDPaVn/7XgHaAy8pmojAkGWoRx2UFChF41A2svX+TaPm+AbwAgBWnrIiYllu7BNNyealdVLvRwEmTHWXvJwew==:',
  '"content-length": 18',
  '"content-type": application/json',
  `"@signature-params": ${figure1Params}`,
].join('\n'));
assert.equal(componentValue(testRequest, '@query'), '?param=Value&Pet=dog');
assert.equal(componentValue({ ...testRequest, search: '' }, '@query'), '?', 'an empty query is "?"');

// B.2.4: the published ECDSA P-256 signature checks against the published test key, using our signature base.
const testKey = createPublicKey('-----BEGIN PUBLIC KEY-----\nMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEqIVYZVLCrPZHGHjP17CTW0/+D9Lf\nw0EkjqF7xB4FivAxzic30tMM4GF+hR6Dxh71Z50VGGdldkkDXZCnTNnoXQ==\n-----END PUBLIC KEY-----\n');
const b24Input = 'sig-b24=("@status" "content-type" "content-digest" "content-length");created=1618884473;keyid="test-key-ecc-p256"';
const b24Signature = 'sig-b24=:wNmSUAhwb5LxtOtOpNa6W5xj067m5hFrj0XQ4fvpaCLx0NKocgPquLgyahnzDnDAUy5eCdlYUEkLIj+32oiasw==:';
const parsed = parseSignatureInput(b24Input, 'sig-b24')!;
assert.deepEqual(parsed.components, ['@status', 'content-type', 'content-digest', 'content-length']);
assert.deepEqual([parsed.params.created, parsed.params.keyid], [1618884473, 'test-key-ecc-p256']);
const responseValues: Record<string, string> = { '@status': '200', 'content-type': 'application/json', 'content-digest': 'sha-512=:mEWXIS7MaLRuGgxOBdODa3xqM1XdEvxoYhvlCFJ41QJgJc4GTsPp29l5oGX69wWdXymyU0rjJuahq4l5aGgfLQ==:', 'content-length': '23' };
const b24Base = signatureBase(parsed.components, (component) => responseValues[component], parsed.serialized);
assert.equal(verifyP256(testKey, Buffer.from(b24Base), parseSignature(b24Signature, 'sig-b24')!), true, 'the RFC example signature verifies');
assert.equal(verifyP256(testKey, Buffer.from(b24Base.replace('200', '201')), parseSignature(b24Signature, 'sig-b24')!), false);
assert.equal(keyIdOf({ kty: 'EC', crv: 'P-256', x: 'qIVYZVLCrPZHGHjP17CTW0_-D9Lfw0EkjqF7xB4FivA', y: 'Mc4nN9LTDOBhfoUeg8Ye9WedFRhnZXZJA12Qp0zZ6F0' }).length, 43, 'a JWK thumbprint is 43 base64url characters');

// ---- Signing and checking SEMA requests ----
const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const jwk = publicKey.export({ format: 'jwk' }) as JsonWebKey;
const signer = { keyId: keyIdOf(jwk), sign: signP256(privateKey) };
const lookup = async (keyId: string) => (keyId === signer.keyId ? publicKey : undefined);
const body = Buffer.from(JSON.stringify({ parentId: '3', type: 'USER' }));
const base = { method: 'POST', authority: '127.0.0.1:4310', path: '/v1/core/topology/create', search: '', body };
const now = Date.now();
const signed = async (overrides: Partial<SignableRequest> = {}, at = now) => {
  const headers = await signRequest(base, signer, at);
  return { ...base, headers: headers as SignableRequest['headers'], ...overrides };
};
let nonces = new NonceMemory();
assert.deepEqual((await verifyRequest(await signed(), { publicKey: lookup, nonces, now })).keyId, signer.keyId);
const copy = await signed();
await verifyRequest(copy, { publicKey: lookup, nonces, now });
await assert.rejects(() => verifyRequest(copy, { publicKey: lookup, nonces, now: now + 1000 }), /already received: a copied request is refused/);
await assert.rejects(async () => verifyRequest(await signed({ path: '/v1/core/topology/remove' }), { publicKey: lookup, nonces, now }), /does not match the request/, 'another path');
await assert.rejects(async () => verifyRequest(await signed({ method: 'DELETE' }), { publicKey: lookup, nonces, now }), /does not match/, 'another method');
await assert.rejects(async () => verifyRequest(await signed({ authority: '127.0.0.1:4311' }), { publicKey: lookup, nonces, now }), /does not match/, 'another Core');
await assert.rejects(async () => verifyRequest(await signed({ search: '?x=1' }), { publicKey: lookup, nonces, now }), /does not match/, 'another query');
await assert.rejects(async () => verifyRequest(await signed({ body: Buffer.from('{"parentId":"3","type":"ORGANIZATION"}') }), { publicKey: lookup, nonces, now }), /body does not match its Content-Digest/);
await assert.rejects(async () => verifyRequest(await signed({}, now - 61_000), { publicKey: lookup, nonces, now }), /older than 60 seconds/);
await assert.rejects(async () => verifyRequest(await signed({}, now + 60_000), { publicKey: lookup, nonces, now }), /created in the future/);
await assert.rejects(async () => verifyRequest(await signed(), { publicKey: async () => undefined, nonces, now }), /not registered on this Core, or was revoked/);
await assert.rejects(() => verifyRequest({ ...base, headers: {} }, { publicKey: lookup, nonces, now }), /not signed/);
const narrow = await signed();
narrow.headers['signature-input'] = String(narrow.headers['signature-input']).replace('"@query" ', '');
await assert.rejects(() => verifyRequest(narrow, { publicKey: lookup, nonces, now }), /must cover @query/);
// A GET has no body and no digest.
const get = { method: 'GET', authority: '127.0.0.1:4310', path: '/v1/core/topology/local', search: '' };
const getHeaders = await signRequest(get, signer, now);
assert.equal(getHeaders['content-digest'], undefined);
await verifyRequest({ ...get, headers: getHeaders }, { publicKey: lookup, nonces: new NonceMemory(), now });

// ---- Where the machine key is kept ----
const folder = mkdtempSync(join(tmpdir(), 'sema-key-'));
try {
  const file = join(folder, 'machine-key');
  const first = await new FileKeyStore(file).open();
  const again = await new FileKeyStore(file).open();
  assert.equal(again.keyId, first.keyId, 'the same key is read back on the next start');
  assert.equal(first.publicJwk.d, undefined, 'only the public half is given out');
  const stored = readFileSync(file, 'utf8');
  if (process.platform === 'win32') assert.equal(stored.includes('PRIVATE KEY'), false, 'on Windows the file is encrypted, not a readable key');
  const data = Buffer.from('hello');
  assert.equal(verifyP256(publicKeyFromJwk(first.publicJwk), data, await again.sign(data)), true);
} finally { rmSync(folder, { recursive: true, force: true }); }

// ---- Through Core, over HTTP: a program registers its key the old way, then signs instead of sending its secret ----
{
  const granted = new Set(['core.topology.read', 'core.topology.write']);
  const authorization: CoreHostAuthorization = { canRead: async ({ resource }) => granted.has(resource), canAdminister: async ({ resource }) => granted.has(resource) };
  const store = new InMemorySemaCoreHostStore();
  const core = new SemaCore(store, { installationId: '3', maxReservationSize: 25 });
  const nodes = new LocalNodes(new InMemoryLocalNodeStore());
  const machine = await new MemoryKeyStore().open();
  const host = new SemaCoreHost(core, store, authorization, undefined, nodes, { peers: { find: async () => nodes, at: async () => nodes }, address: undefined }, { machine, clients: new InMemoryClientKeyStore(), nonces: new NonceMemory() });
  await host.initialize({ actorId: 'console' });
  const server = await startCoreHostHttpServer(host, { port: 0, applicationClients: [{ applicationKey: 'console', secret: 'console-secret' }] });
  const port = (server.address() as net.AddressInfo).port, address = `http://127.0.0.1:${port}`;
  const old = async (method: string, path: string, payload?: unknown) => { const response = await fetch(address + path, { method, headers: { 'x-sema-application-key': 'console', 'x-sema-application-secret': 'console-secret', ...(payload ? { 'content-type': 'application/json' } : {}) }, body: payload ? JSON.stringify(payload) : undefined }); return { status: response.status, payload: await response.json() as any }; };
  const viaSignature = async (method: string, path: string, payload?: unknown, keySigner = signer) => {
    const bytes = payload ? Buffer.from(JSON.stringify(payload)) : undefined;
    const url = new URL(address + path);
    const headers = await signRequest({ method, authority: url.host, path: url.pathname, search: url.search, body: bytes }, keySigner);
    const response = await fetch(address + path, { method, headers: { ...headers, ...(bytes ? { 'content-type': 'application/json' } : {}) }, body: bytes });
    return { status: response.status, payload: await response.json() as any };
  };
  await nodes.accept({ id: '3', type: 'MACHINE' });

  const machineKey = (await old('GET', '/v1/core/keys')).payload;
  assert.deepEqual([machineKey.keyId, machineKey.alg, machineKey.publicKey.d], [machine.keyId, 'ecdsa-p256-sha256', undefined]);

  assert.equal((await viaSignature('GET', '/v1/core/topology/local')).status, 401, 'an unregistered key is refused');
  const proofFor = (applicationKey: string, keyId: string, key = privateKey) => signData('sha256', Buffer.from(`sema-key-registration\n${applicationKey}\n${keyId}`), { key, dsaEncoding: 'ieee-p1363' }).toString('base64');
  const other = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  assert.equal((await old('POST', '/v1/core/keys/clients', { publicKey: jwk, proof: proofFor('console', signer.keyId, other.privateKey) })).status, 400, 'the proof must come from the new private key');
  assert.equal((await old('POST', '/v1/core/keys/clients', { publicKey: { ...jwk, d: 'x' }, proof: proofFor('console', signer.keyId) })).status, 400, 'a private key is never accepted');
  const registered = await old('POST', '/v1/core/keys/clients', { publicKey: jwk, proof: proofFor('console', signer.keyId) });
  assert.deepEqual([registered.status, registered.payload.keyId, registered.payload.applicationKey], [201, signer.keyId, 'console']);
  assert.equal((await old('POST', '/v1/core/keys/clients', { publicKey: jwk, proof: proofFor('console', signer.keyId) })).status, 400, 'a key is registered once');

  const local = await viaSignature('GET', '/v1/core/topology/local');
  assert.equal(local.status, 200, 'a signed request needs no secret');
  const created = await viaSignature('POST', '/v1/core/topology/create', { parentId: '3', type: 'USER' });
  assert.equal(created.status, 400, 'the program is recognised and its request handled (a machine node holds no users)');
  assert.match(created.payload.error.message, /cannot sit under a MACHINE/);
  assert.deepEqual((await viaSignature('GET', '/v1/core/keys/clients')).payload.map((key: any) => key.keyId), [signer.keyId]);

  // A tampered body is caught before anything is done.
  const bytes = Buffer.from(JSON.stringify({ parentId: '3', type: 'USER' }));
  const headers = await signRequest({ method: 'POST', authority: `127.0.0.1:${port}`, path: '/v1/core/topology/create', search: '', body: bytes }, signer);
  const tampered = await fetch(address + '/v1/core/topology/create', { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ parentId: '3', type: 'ORGANIZATION' }) });
  assert.equal(tampered.status, 401);
  assert.match(((await tampered.json()) as any).error.message, /Content-Digest/);

  assert.deepEqual((await viaSignature('POST', '/v1/core/keys/clients/revoke', { keyId: signer.keyId })).payload, { keyId: signer.keyId, revoked: true });
  assert.equal((await viaSignature('GET', '/v1/core/topology/local')).status, 401, 'a revoked key is refused');
  assert.equal((await old('GET', '/v1/core/topology/local')).status, 200, 'the old key and secret still work until every program signs');

  // The shared client code a program uses: its first signed request is refused as unregistered, so it registers and retries once.
  const program = await openCoreClientSigning({ keyFile: 'unused', coreUrl: address, applicationKey: 'console', secret: 'console-secret', key: await new MemoryKeyStore().open() });
  const firstCall = await program.fetch('GET', new URL(address + '/v1/core/topology/local'));
  assert.equal(firstCall.status, 200, 'registered on the way, then accepted');
  const write = await program.fetch('POST', new URL(address + '/v1/core/topology/create'), Buffer.from(JSON.stringify({ parentId: '3', type: 'USER' })), { 'content-type': 'application/json' });
  assert.match(((await write.json()) as any).error.message, /cannot sit under a MACHINE/, 'a signed write with a body reaches Core');
  const badSecret = await openCoreClientSigning({ keyFile: 'unused', coreUrl: address, applicationKey: 'console', secret: 'wrong', key: await new MemoryKeyStore().open() });
  await assert.rejects(() => badSecret.fetch('GET', new URL(address + '/v1/core/topology/local')), /could not be registered with Core/, 'registering still needs the real secret');
  server.close();
}

// When Core is not running, a program is told so in plain words, with what to do, not "fetch failed".
{
  const closed = await new Promise<number>((resolve) => { const probe = net.createServer().listen(0, '127.0.0.1', () => { const port = (probe.address() as net.AddressInfo).port; probe.close(() => resolve(port)); }); });
  const offline = await openCoreClientSigning({ keyFile: '', key: await new MemoryKeyStore().open(), coreUrl: `http://127.0.0.1:${closed}`, applicationKey: 'app', secret: 's' });
  await assert.rejects(() => offline.fetch('GET', new URL(`http://127.0.0.1:${closed}/v1/core/health`)), new RegExp(`^Error: SEMA Core is not running \\(nothing answers at http://127\\.0\\.0\\.1:${closed}\\)\\. Start the SEMA services in order from the System Console's Service Status page\\.$`));
  await assert.rejects(() => offline.register(), /SEMA Core is not running/);
}

console.log('Signed requests test passed.');
