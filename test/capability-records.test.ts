import assert from 'node:assert/strict';
import { CapabilityRegistry, InMemoryCapabilityStore, InMemorySemaCoreHostStore, SemaCore, SemaCoreHost, type CoreHostAuthorization } from '../src/index.js';

// The four capability records (D-151): capability versions, service versions, installations and instances.
const granted = new Set(['core.capabilities.read', 'core.capabilities.register', 'core.services.install', 'core.services.run']);
const authorization: CoreHostAuthorization = { canRead: async ({ resource }) => granted.has(resource), canAdminister: async ({ resource }) => granted.has(resource) };
const store = new InMemorySemaCoreHostStore();
const core = new SemaCore(store, { installationId: '3', maxReservationSize: 25 });
const records = new InMemoryCapabilityStore();
const registry = new CapabilityRegistry(records, async (typeCode, metadata) => (await core.issueIdentifier(typeCode, metadata)).id, async () => '3');
const host = new SemaCoreHost(core, store, authorization, undefined, undefined, undefined, undefined, registry);
const app = { actorId: 'app' };

// Old single records are moved on start: each becomes a capability version keeping its ID, a service version and an installation.
await core.initialize();
const blur = await core.registerCapability({ capabilityKey: 'sema.graphics.raster.blur', displayName: 'Blur', description: 'Blurs an image', providerKey: 'vectorforge.provider.sharp', version: '1.0.0', metadata: {} });
const catalog = await core.registerCapability({ capabilityKey: 'sema.foundation.resource.catalog', displayName: 'Catalog', description: 'Lists resources', providerKey: 'sema.foundation.resource-facility', version: '1.0.0', metadata: { endpointUrl: 'http://127.0.0.1:4320/catalog' } });
await host.initialize(app);
let list = await host.capabilityRecordList(app);
assert.deepEqual(list.capabilities.map((item) => [item.id, item.capabilityKey, item.legacy, item.approved]), [[catalog.id, catalog.capabilityKey, true, true], [blur.id, blur.capabilityKey, true, true]], 'IDs are kept; moved sema. names are approved');
assert.deepEqual(list.services.map((item) => [item.serviceKey, item.capabilityVersionId]), [['sema.foundation.resource-facility', catalog.id], ['vectorforge.provider.sharp', blur.id]]);
assert.equal(list.installations.length, 2);
assert.equal(list.installations.find((item) => item.serviceVersionId === list.services[0].id)!.endpointUrl, 'http://127.0.0.1:4320/catalog', 'the endpoint moves to the installation');
assert.ok(list.installations.every((item) => item.machineNodeId === '3'));
const issuedBefore = (await store.getHostStatistics()).identifiers.issued;
await host.initialize(app);
assert.deepEqual(await host.capabilityRecordList(app), list, 'moving again changes nothing');
assert.equal((await store.getHostStatistics()).identifiers.issued, issuedBefore, 'and issues no IDs');

// The old route still works, and writes the new records too; a new sema. name that way is not approved.
await host.registerCapability(app, { capabilityKey: 'sema.graphics.raster.upscale', displayName: 'Upscale', description: 'Upscales', providerKey: 'vectorforge.provider.sharp', version: '1.0.0', metadata: {} });
list = await host.capabilityRecordList(app);
assert.equal(list.capabilities.find((item) => item.capabilityKey === 'sema.graphics.raster.upscale')!.approved, false);
assert.equal(list.services.length, 3);
// A new version through the old route is a new capability version with a new ID; the first keeps its own.
const blur2 = await host.registerCapability(app, { capabilityKey: 'sema.graphics.raster.blur', displayName: 'Blur', description: 'Blurs an image', providerKey: 'vectorforge.provider.sharp', version: '1.1.0', metadata: {} });
const blurs = (await host.capabilityRecordList(app)).capabilities.filter((item) => item.capabilityKey === 'sema.graphics.raster.blur');
assert.equal(blurs.length, 2);
assert.equal(blurs.find((item) => item.version === '1.0.0')!.id, blur.id);
assert.notEqual(blurs.find((item) => item.version === '1.1.0')!.id, blur2.id, 'the old record kept its ID, which the first version already holds');

// Publishing a capability version.
const copy = { capabilityKey: 'neo.listing.write-copy', version: '1.0.0', displayName: 'Write listing copy', description: 'Writes a title and description', operations: [
  { key: 'write', required: true, input: { type: 'object' }, output: { type: 'object' } },
  { key: 'rewrite', required: false },
] };
const written = await host.registerCapabilityVersion(app, copy);
assert.deepEqual([written.legacy, written.approved, written.operations.length], [false, false, 2]);
await assert.rejects(() => host.registerCapabilityVersion(app, copy), /already published; a changed contract is a new version/);
await assert.rejects(() => host.registerCapabilityVersion(app, { ...copy, capabilityKey: 'sema.listing.write-copy' }), /reserved sema. namespace/);
await assert.rejects(() => host.registerCapabilityVersion(app, { ...copy, capabilityKey: 'Listing Copy' }), /lowercase words separated by dots/);
await assert.rejects(() => host.registerCapabilityVersion(app, { ...copy, version: 'one' }), /look like 1.0.0/);
await assert.rejects(() => host.registerCapabilityVersion(app, { ...copy, version: '2.0.0', operations: [{ key: 'write', required: false }] }), /at least one operation must be required/);
await assert.rejects(() => host.registerCapabilityVersion(app, { ...copy, version: '2.0.0', operations: [{ key: 'write', required: true }, { key: 'write', required: true }] }), /must not repeat/);
await assert.rejects(() => host.registerCapabilityVersion(app, { ...copy, version: '2.0.0', operations: [{ key: 'write', required: true, input: 'text' }] }), /JSON Schema object/);
granted.add('core.capabilities.approve');
assert.equal((await host.registerCapabilityVersion(app, { ...copy, capabilityKey: 'sema.listing.write-copy' })).approved, true, 'with the approval permission a sema. name is allowed');
granted.delete('core.capabilities.approve');

// Publishing a service version: it offers every required operation, and says where it runs.
const declarations = { runsWhere: 'remote', offline: false, systems: ['windows', 'linux'] };
const service = { serviceKey: 'neo.ai.claude-copy', version: '1.0.0', capabilityVersionId: written.id, displayName: 'Copy by Claude', operations: ['write', 'rewrite', 'translate'], declarations };
const published = await host.registerServiceVersion(app, service);
assert.deepEqual(published.extensions, ['translate'], 'an operation the capability does not name is an extension');
await assert.rejects(() => host.registerServiceVersion(app, service), /already published/);
await assert.rejects(() => host.registerServiceVersion(app, { ...service, version: '1.0.1', operations: ['rewrite'] }), /missing: write/);
await assert.rejects(() => host.registerServiceVersion(app, { ...service, version: '1.0.1', declarations: { runsWhere: 'remote', systems: ['windows'] } }), /offline must be true or false/);
await assert.rejects(() => host.registerServiceVersion(app, { ...service, version: '1.0.1', declarations: { ...declarations, runsWhere: 'cloud' } }), /device, remote or either/);
await assert.rejects(() => host.registerServiceVersion(app, { ...service, version: '1.0.1', capabilityVersionId: 'nope' }), /not registered/);
await assert.rejects(() => host.registerServiceVersion(app, { ...service, capabilityVersionId: blur.id }), /has no contract/, 'a moved capability needs its contract written first');
await assert.rejects(() => host.registerServiceVersion(app, { ...service, serviceKey: 'sema.ai.copy' }), /reserved sema. namespace/);

// Installed once on this machine, then running copies.
granted.delete('core.services.install');
await assert.rejects(() => host.installService(app, { serviceVersionId: published.id }), /core.services.install administration is not authorized/);
granted.add('core.services.install');
const installed = await host.installService(app, { serviceVersionId: published.id, settingsRef: 'service-settings/claude-copy' });
assert.deepEqual([installed.machineNodeId, installed.settingsRef], ['3', 'service-settings/claude-copy']);
await assert.rejects(() => host.installService(app, { serviceVersionId: published.id }), /already installed/);
const first = await host.startServiceInstance(app, { installationId: installed.id, capacity: 2, resources: { memoryMb: 900 } });
const second = await host.startServiceInstance(app, { installationId: installed.id });
assert.deepEqual([first.capacity, second.capacity, first.state], [2, 1, 'RUNNING']);
assert.notEqual(first.id, second.id, 'several copies may run at once');
await assert.rejects(() => host.startServiceInstance(app, { installationId: installed.id, capacity: 0 }), /capacity must be/);
const checked = await host.checkInServiceInstance(app, { instanceId: first.id, resources: { memoryMb: 400 } });
assert.deepEqual(checked.resources, { memoryMb: 400 });
assert.ok(checked.lastCheckInAt >= first.lastCheckInAt);
assert.equal((await host.stopServiceInstance(app, { instanceId: first.id })).state, 'STOPPED');
await assert.rejects(() => host.checkInServiceInstance(app, { instanceId: first.id }), /has stopped; start a new one/);
await assert.rejects(() => host.checkInServiceInstance(app, { instanceId: 'nope' }), /not on this machine/);

list = await host.capabilityRecordList(app);
assert.deepEqual([list.capabilities.length, list.services.length, list.installations.length, list.instances.length], [6, 5, 5, 2]);
granted.delete('core.capabilities.read');
await assert.rejects(() => host.capabilityRecordList(app), /not authorized/);

console.log('Capability records tests passed.');
