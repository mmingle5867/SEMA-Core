import assert from 'node:assert/strict';
import { CapabilityRegistry, CapabilityWork, InMemoryCapabilityStore, InMemorySemaCoreHostStore, InMemoryWorkStore, SemaCore, SemaCoreHost, type CoreHostAuthorization, type MayAnswer, type MayRequest } from '../src/index.js';

// The organization's choices (3c, D-190 to D-195): Foundation Access gives them with its "may" answer; Core keeps only
// what every list allows and, where approval is on, what is approved; the default way and order apply when a command
// names none.
const grants: Record<string, Set<string>> = {
  admin: new Set(['core.capabilities.read', 'core.capabilities.register', 'core.services.install']),
  'svc.a': new Set(['core.services.run']), 'svc.a2': new Set(['core.services.run']), 'svc.b': new Set(['core.services.run']),
  shop: new Set(['capability.neo.test.echo']),
};
const allowed = async ({ actorId, resource }: { actorId: string | null; resource: string }) => !!actorId && !!grants[actorId]?.has(resource);
let choices: MayAnswer['choices'];
let organizationId: string | null | undefined;
const asked: MayRequest[] = [];
const authorization: CoreHostAuthorization = {
  canRead: allowed, canAdminister: allowed,
  mayRunCapability: async ({ actorId, ...request }) => { asked.push(request); return (await allowed({ actorId, resource: `capability.${request.capabilityKey}` })) ? { allowed: true, ...(choices ? { choices } : {}), ...(organizationId !== undefined ? { organizationId } : {}) } : { allowed: false }; },
};
const store = new InMemorySemaCoreHostStore();
const core = new SemaCore(store, { installationId: '3', maxReservationSize: 25 });
const records = new InMemoryCapabilityStore();
const issue = async (typeCode: string, metadata: object) => (await core.issueIdentifier(typeCode, metadata as never)).id;
const host = new SemaCoreHost(core, store, authorization, undefined, undefined, undefined, undefined, new CapabilityRegistry(records, issue, async () => '3'), new CapabilityWork(core, records, new InMemoryWorkStore(), issue));
await host.initialize({ actorId: null });
const as = (actorId: string) => ({ actorId });

const capability = await host.registerCapabilityVersion(as('admin'), { capabilityKey: 'neo.test.echo', version: '1.0.0', displayName: 'Echo', choosing: ['bound', 'dynamic', 'consensus'], operations: [{ key: 'echo', required: true, input: { type: 'object', required: ['text'], properties: { text: { type: 'string' } }, additionalProperties: false } }] });
const declarations = { runsWhere: 'device', offline: true, systems: ['windows'] };
const service = async (serviceKey: string, version: string, program: string) => {
  const made = await host.registerServiceVersion(as('admin'), { serviceKey, version, capabilityVersionId: capability.id, displayName: serviceKey, operations: ['echo'], declarations });
  await host.startServiceInstance(as(program), { installationId: (await host.installService(as('admin'), { serviceVersionId: made.id })).id });
  return made;
};
const a1 = await service('neo.test.echo-a', '1.0.0', 'svc.a');
const a2 = await service('neo.test.echo-a', '1.10.0', 'svc.a2');
const b = await service('neo.test.echo-b', '1.0.0', 'svc.b');
const name = new Map([[a1.id, 'a 1.0.0'], [a2.id, 'a 1.10.0'], [b.id, 'b']]);

/** Runs without waiting and says which services got work, and the order kept for passing on. */
const run = async (input: Record<string, unknown>) => {
  const result = await host.runCapability(as('shop'), { capabilityKey: 'neo.test.echo', version: '1.0.0', operation: 'echo', input: { text: 'hi' }, waitSeconds: 0, ...input } as never);
  const payload = (await core.getCommand(result.commandId))!.payload as { way: string; services: string[] };
  return { got: result.entries.map((entry) => name.get(entry.serviceVersionId)), order: payload.services.map((id) => name.get(id)), way: payload.way };
};
const notAllowed = /^CoreHostAuthorizationError: Not allowed$/;

// No choices: as before; a command must name its way.
await assert.rejects(() => run({}), /Name a way of choosing \(bound, dynamic, consensus\): the organization sets no default for neo.test.echo/);
assert.deepEqual((await run({ way: 'consensus' })).got.sort(), ['a 1.0.0', 'a 1.10.0', 'b']);
await assert.rejects(() => run({ way: 'dynamic' }), /Dynamic needs the services in order of preference/, 'with no list, dynamic still needs the order');

// The default way and order: the list's order, each service's versions newest first (1.10.0 before 1.0.0).
choices = { lists: [['neo.test.echo-b', 'neo.test.echo-a']], way: 'dynamic', approvalRequired: false, approved: [] };
assert.deepEqual(await run({}), { got: ['b'], order: ['b', 'a 1.10.0', 'a 1.0.0'], way: 'dynamic' });
assert.deepEqual((await run({ way: 'bound' })).got, ['b'], 'bound with no service named: the first in the order');
assert.deepEqual((await run({ way: 'consensus' })).got.sort(), ['a 1.0.0', 'a 1.10.0', 'b'], 'every listed service');
// One exact version.
choices = { lists: [['neo.test.echo-a@1.0.0']], approvalRequired: false, approved: [] };
assert.deepEqual((await run({ way: 'consensus' })).got, ['a 1.0.0']);
// Narrow only: a service must be on every list (a workspace's and its organization's).
choices = { lists: [['neo.test.echo-a'], ['neo.test.echo-b', 'neo.test.echo-a']], approvalRequired: false, approved: [] };
assert.deepEqual((await run({ way: 'consensus' })).got.sort(), ['a 1.0.0', 'a 1.10.0']);
// A service the command names that is not allowed is passed over; none left is "not allowed", saying nothing more.
assert.deepEqual(await run({ way: 'dynamic', services: ['neo.test.echo-b', a1.id] }), { got: ['a 1.0.0'], order: ['a 1.0.0'], way: 'dynamic' });
await assert.rejects(() => run({ way: 'bound', services: ['neo.test.echo-b'] }), notAllowed);

// Approval before first use: only approved versions; approving one version never covers another.
choices = { lists: [], approvalRequired: true, approved: [] };
await assert.rejects(() => run({ way: 'consensus' }), notAllowed);
choices = { lists: [], approvalRequired: true, approved: [a1.id] };
assert.deepEqual((await run({ way: 'consensus' })).got, ['a 1.0.0']);
await assert.rejects(() => run({ way: 'bound', services: [a2.id] }), notAllowed, 'the newer version is not approved');
// Approvals do not widen a list.
choices = { lists: [['neo.test.echo-b']], approvalRequired: true, approved: [a1.id, b.id] };
assert.deepEqual((await run({ way: 'consensus' })).got, ['b']);

// No organization found (no workspace, and the grant names none): the result says the choices were not applied (D-209).
choices = { lists: [], approvalRequired: false, approved: [] };
organizationId = null;
const unplaced = await host.runCapability(as('shop'), { capabilityKey: 'neo.test.echo', version: '1.0.0', operation: 'echo', way: 'consensus', input: { text: 'hi' }, waitSeconds: 0 } as never);
assert.match(unplaced.notes![0], /^No organization was found for this command/);
organizationId = '3-9rJ';
assert.equal((await host.runCapability(as('shop'), { capabilityKey: 'neo.test.echo', version: '1.0.0', operation: 'echo', way: 'consensus', input: { text: 'hi' }, waitSeconds: 0 } as never)).notes, undefined, 'with an organization, no note');
organizationId = undefined;

// Access is asked once, with the command's workspace.
asked.length = 0;
await run({ way: 'consensus', workspaceId: '3-ws' });
assert.deepEqual(asked, [{ capabilityKey: 'neo.test.echo', workspaceId: '3-ws' }]);
// A program that may not use the capability learns nothing, whatever the choices.
await assert.rejects(() => host.runCapability(as('admin'), { capabilityKey: 'neo.test.echo', version: '1.0.0', operation: 'echo', input: { text: 'hi' } } as never), notAllowed);

console.log('Organization choices test passed.');
