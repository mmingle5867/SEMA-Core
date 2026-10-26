import assert from 'node:assert/strict';
import net from 'node:net';
import { CapabilityRegistry, CapabilityWork, InMemoryCapabilityStore, InMemorySemaCoreHostStore, InMemoryWorkStore, SemaCore, SemaCoreHost, parametersOf, startCoreHostHttpServer, type CoreHostAuthorization, type NoteLookup } from '../src/index.js';

// SEMA describes itself (D-199 to D-202): a capability or a service, from Core's records and its note, as JSON or Markdown.
const grants: Record<string, Set<string>> = {
  admin: new Set(['core.capabilities.read', 'core.capabilities.register', 'core.services.install']),
  reader: new Set(['core.capabilities.read']), 'svc.a': new Set(['core.services.run']), stranger: new Set(),
};
const allowed = async ({ actorId, resource }: { actorId: string | null; resource: string }) => !!actorId && !!grants[actorId]?.has(resource);
const notes = new Map<string, NoteLookup>();
const asked: string[] = [];
const authorization: CoreHostAuthorization = { canRead: allowed, canAdminister: allowed, itemNote: async (kind, key) => { asked.push(`${kind} ${key}`); return notes.get(`${kind} ${key}`) ?? {}; } };
const store = new InMemorySemaCoreHostStore();
const core = new SemaCore(store, { installationId: '3', maxReservationSize: 25 });
const records = new InMemoryCapabilityStore();
const issue = async (typeCode: string, metadata: object) => (await core.issueIdentifier(typeCode, metadata as never)).id;
const host = new SemaCoreHost(core, store, authorization, undefined, undefined, undefined, undefined, new CapabilityRegistry(records, issue, async () => '3'), new CapabilityWork(core, records, new InMemoryWorkStore(), issue));
await host.initialize({ actorId: null });
const as = (actorId: string) => ({ actorId });

// Parameters are read from the input schema: nested fields as dotted names, a list's items as name[].
const input = { type: 'object', required: ['job', 'text'], additionalProperties: false, properties: {
  job: { type: 'object', description: 'The job', required: ['key'], properties: { key: { type: 'string', maxLength: 100 }, version: { type: 'string' } } },
  text: { type: 'string', description: 'What to say', minLength: 1, maxLength: 200 },
  tone: { type: 'string', enum: ['plain', 'warm'] },
  photos: { type: 'array', maxItems: 3, items: { type: 'object', required: ['ref'], properties: { ref: { type: 'string' } } } },
} };
assert.deepEqual(parametersOf(input as never), [
  { name: 'job', type: 'object', required: true, description: 'The job' },
  { name: 'job.key', type: 'string', required: true, limits: 'at most 100 characters' },
  { name: 'job.version', type: 'string', required: false },
  { name: 'text', type: 'string', required: true, description: 'What to say', limits: 'at least 1 character, at most 200 characters' },
  { name: 'tone', type: 'string', required: false, allowed: ['plain', 'warm'] },
  { name: 'photos', type: 'array of object', required: false, limits: 'at most 3 items' },
  { name: 'photos[].ref', type: 'string', required: false, requiredWithin: 'photos[]' },
], 'a field required inside an optional field is needed whenever that field is given');

const v1 = await host.registerCapabilityVersion(as('admin'), { capabilityKey: 'neo.test.say', version: '1.0.0', displayName: 'Say', description: 'Says something.', choosing: ['bound', 'consensus'], operations: [{ key: 'say', required: true, description: 'Says the text.', job: 'job', input, output: { type: 'object', required: ['said'], properties: { said: { type: 'string' } } } }] });
await host.registerCapabilityVersion(as('admin'), { capabilityKey: 'neo.test.say', version: '1.10.0', displayName: 'Say', description: 'Says something, better.', choosing: ['bound'], operations: [{ key: 'say', required: true, input }] });
const service = await host.registerServiceVersion(as('admin'), { serviceKey: 'neo.test.sayer', version: '0.2.0', capabilityVersionId: v1.id, displayName: 'Sayer', operations: ['say'], declarations: { runsWhere: 'remote', offline: false, systems: ['windows', 'linux'], dataSentTo: 'Example Co.', needs: { memoryMb: 512 } } });
await host.startServiceInstance(as('svc.a'), { installationId: (await host.installService(as('admin'), { serviceVersionId: service.id })).id });

// Without a note: built from the records, never blank. The newest version (1.10.0 after 1.0.0) comes first.
const bare = await host.describe(as('reader'), 'capability', 'neo.test.say') as Record<string, any>;
assert.equal(bare.kind, 'capability');
assert.equal(bare.summary, 'Says something, better.', 'the newest active version speaks for it');
assert.deepEqual(bare.versions.map((item: { version: string }) => item.version), ['1.10.0', '1.0.0']);
assert.deepEqual(bare.notes, { source: 'none' });
assert.equal(bare.howToCall.route, 'POST /v1/core/capability-commands');
assert.deepEqual(bare.related, [{ kind: 'service', key: 'neo.test.sayer', versions: ['0.2.0'], note: 'Sayer; 1 running copy on this Core' }]);
const bareService = await host.describe(as('reader'), 'service', 'neo.test.sayer') as Record<string, any>;
assert.equal(bareService.summary, 'A service of Say (neo.test.say 1.0.0); runs elsewhere (it sends the work over the network); sends data to Example Co..');
assert.deepEqual(bareService.dependencies.map((item: { kind: string; name: string }) => `${item.kind}: ${item.name}`), ['network: Network', 'software: Operating system', 'software: Machine: memoryMb']);
assert.deepEqual(bareService.operations.map((item: { key: string; parameters: unknown[] }) => [item.key, item.parameters.length]), [['say', 7]]);
assert.equal(bareService.versions[0].runningHere, 1);
assert.deepEqual(bareService.related, [{ kind: 'capability', key: 'neo.test.say', versions: ['1.0.0'], note: 'Say' }]);

// With a note: its words, dependencies and examples, with the records' dependencies after them.
notes.set('service neo.test.sayer', { note: { kind: 'service', key: 'neo.test.sayer', summary: 'Says things through Example Co.', details: 'Longer words.', dependencies: [{ kind: 'account', name: 'Example Co.', note: 'An account.' }], examples: [{ title: 'Hello', operation: 'say', request: { text: 'hi' }, result: { said: 'hi' } }], updatedAt: '2026-10-25T00:00:00.000Z' } });
const noted = await host.describe(as('reader'), 'service', 'neo.test.sayer') as Record<string, any>;
assert.equal(noted.summary, 'Says things through Example Co.');
assert.deepEqual(noted.dependencies.map((item: { from: string; name: string }) => `${item.from}: ${item.name}`), ['note: Example Co.', 'records: Network', 'records: Operating system', 'records: Machine: memoryMb']);
assert.deepEqual(noted.notes, { source: 'Foundation Access', updatedAt: '2026-10-25T00:00:00.000Z' });
// Access could not be asked: the description still comes, and says why the note is missing.
notes.set('capability neo.test.say', { unavailable: 'Foundation Access is not reachable at http://x' });
assert.deepEqual((await host.describe(as('reader'), 'capability', 'neo.test.say') as Record<string, any>).notes, { source: 'none', unavailable: 'Foundation Access is not reachable at http://x' });

// Markdown: the same, for people.
const markdown = await host.describe(as('reader'), 'service', 'neo.test.sayer', 'markdown') as string;
for (const part of ['# Sayer', 'Service `neo.test.sayer`', 'Says things through Example Co.', '## How to call it', '`POST /v1/core/capability-commands`', '## Operation `say`', 'Names its job in `input.job`', '| `text` | string | yes | What to say | at least 1 character, at most 200 characters |', '| `tone` | string | no |  One of: `plain`, `warm`. |  |', '## Dependencies', '| account | Example Co. | An account. |', '## Example: Hello', '"said": "hi"', '## Capability', '## Versions'])
  assert.ok(markdown.includes(part), `Markdown has ${part}`);

// Refusals: no permission, an unknown kind, an item Core does not hold.
await assert.rejects(() => host.describe(as('stranger'), 'capability', 'neo.test.say'), /CoreHostAuthorizationError/);
await assert.rejects(() => host.describe(as('reader'), 'node', '3'), /describes a capability or a service/);
await assert.rejects(() => host.describe(as('reader'), 'capability', 'neo.test.nothing'), /^CoreHostNotFoundError: Core holds no capability neo.test.nothing$/);

// Over HTTP: JSON by default, Markdown with ?format=markdown, 404 for something Core does not hold.
const clients = [{ applicationKey: 'reader', secret: 'reader-secret' }];
const server = await startCoreHostHttpServer(host, { port: 0, applicationClients: clients });
const url = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
const get = (path: string) => fetch(url + path, { headers: { 'x-sema-application-key': 'reader', 'x-sema-application-secret': 'reader-secret' } });
const json = await get('/v1/core/describe/service/neo.test.sayer');
assert.equal(json.status, 200);
assert.equal(((await json.json()) as { key: string }).key, 'neo.test.sayer');
const page = await get('/v1/core/describe/service/neo.test.sayer?format=markdown');
assert.match(page.headers.get('content-type') ?? '', /^text\/markdown/);
assert.match(await page.text(), /^# Sayer/);
assert.equal((await get('/v1/core/describe/capability/neo.test.nothing')).status, 404);
server.close();

console.log('Describe test passed.');
