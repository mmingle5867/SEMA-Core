import assert from 'node:assert/strict';
import { CapabilityRegistry, CapabilityWork, InMemoryCapabilityStore, InMemorySemaCoreHostStore, InMemoryWorkStore, SemaCore, SemaCoreHost, offersOf, type CoreHostAuthorization, type MayAnswer } from '../src/index.js';

// A service's settings (D-203 to D-205): a running copy reports what it offers when it starts (models and their prices),
// the organization's choice travels with the work to that service only, and recent answers give the usage for costs.
const grants: Record<string, Set<string>> = {
  admin: new Set(['core.capabilities.read', 'core.capabilities.register', 'core.services.install']),
  'svc.a': new Set(['core.services.run']), 'svc.b': new Set(['core.services.run']), shop: new Set(['capability.neo.test.ask']),
};
const allowed = async ({ actorId, resource }: { actorId: string | null; resource: string }) => !!actorId && !!grants[actorId]?.has(resource);
let choices: MayAnswer['choices'];
const authorization: CoreHostAuthorization = { canRead: allowed, canAdminister: allowed, mayRunCapability: async ({ actorId, capabilityKey }) => (await allowed({ actorId, resource: `capability.${capabilityKey}` })) ? { allowed: true, ...(choices ? { choices } : {}) } : { allowed: false } };
const store = new InMemorySemaCoreHostStore();
const core = new SemaCore(store, { installationId: '3', maxReservationSize: 25 });
const records = new InMemoryCapabilityStore();
const issue = async (typeCode: string, metadata: object) => (await core.issueIdentifier(typeCode, metadata as never)).id;
const host = new SemaCoreHost(core, store, authorization, undefined, undefined, undefined, undefined, new CapabilityRegistry(records, issue, async () => '3'), new CapabilityWork(core, records, new InMemoryWorkStore(), issue));
await host.initialize({ actorId: null });
const as = (actorId: string) => ({ actorId });

// What a service may offer: checked when it starts.
const models = { model: { label: 'Model', default: 'big', choices: [{ value: 'big', label: 'Big', inputPerMillion: 4, outputPerMillion: 20, currency: 'USD' }, { value: 'small', label: 'Small', inputPerMillion: 0.1, outputPerMillion: 0.5, currency: 'USD', note: 'Fast' }] } };
assert.deepEqual(offersOf(models), models);
for (const [bad, why] of [[[], /offers must be an object/], [{ Model: models.model }, /not a setting name/], [{ model: { label: 'Model', choices: [] } }, /needs a label and 1 to 50 choices/], [{ model: { ...models.model, default: 'huge' } }, /default must be one of its choices/], [{ model: { label: 'Model', choices: [{ value: 'a', label: 'A' }, { value: 'a', label: 'A again' }] } }, /repeats a choice/], [{ model: { label: 'Model', choices: [{ value: 'a', label: 'A', inputPerMillion: -1 }] } }, /must be a price/]] as const)
  assert.throws(() => offersOf(bad), why);

const capability = await host.registerCapabilityVersion(as('admin'), { capabilityKey: 'neo.test.ask', version: '1.0.0', displayName: 'Ask', choosing: ['bound', 'consensus'], operations: [{ key: 'ask', required: true, input: { type: 'object', properties: { text: { type: 'string' } } }, output: { type: 'object', required: ['text'], properties: { text: { type: 'string' }, usage: { type: 'object' } } } }] });
const declarations = { runsWhere: 'remote', offline: false, systems: ['windows'] };
const a = await host.registerServiceVersion(as('admin'), { serviceKey: 'neo.test.ask-a', version: '1.0.0', capabilityVersionId: capability.id, displayName: 'A', operations: ['ask'], declarations });
const b = await host.registerServiceVersion(as('admin'), { serviceKey: 'neo.test.ask-b', version: '1.0.0', capabilityVersionId: capability.id, displayName: 'B', operations: ['ask'], declarations });
await assert.rejects(() => host.startServiceInstance(as('svc.a'), { installationId: 'x', offers: models } as never), /not on this machine/);
const copyA = await host.startServiceInstance(as('svc.a'), { installationId: (await host.installService(as('admin'), { serviceVersionId: a.id })).id, offers: models });
assert.deepEqual(copyA.offers, models, 'Core keeps what it offers');
const installB = await host.installService(as('admin'), { serviceVersionId: b.id });
await assert.rejects(() => host.startServiceInstance(as('svc.b'), { installationId: installB.id, offers: { model: { label: 'Model', choices: [] } } }), /needs a label and 1 to 50 choices/);
const copyB = await host.startServiceInstance(as('svc.b'), { installationId: installB.id });
assert.equal(copyB.offers, undefined, 'a service may offer nothing');
assert.deepEqual((await host.capabilityRecordList(as('admin'))).instances.find((item) => item.id === copyA.id)!.offers, models, 'the Console reads it from the records');

// The organization's choice goes with the work, to that service only.
choices = { lists: [], approvalRequired: false, approved: [], settings: { 'neo.test.ask-a': { model: 'small' }, 'neo.test.unrelated': { model: 'x' } } };
const run = host.runCapability(as('shop'), { capabilityKey: 'neo.test.ask', version: '1.0.0', operation: 'ask', way: 'consensus', input: { text: 'hi' }, waitSeconds: 5 });
const [{ work: workA }, { work: workB }] = await Promise.all([host.takeServiceWork(as('svc.a'), { instanceId: copyA.id, waitSeconds: 3 }), host.takeServiceWork(as('svc.b'), { instanceId: copyB.id, waitSeconds: 3 })]);
assert.deepEqual(workA!.settings, { model: 'small' });
assert.equal(workB!.settings, undefined, 'B gets no settings: the organization chose none for it');
const commandPayload = (await core.getCommand(workA!.commandId))!.payload as { settings?: unknown };
assert.deepEqual(commandPayload.settings, { 'neo.test.ask-a': { model: 'small' } }, 'recorded with the command, only for its services');
for (const [actor, work, usage] of [['svc.a', workA!, { model: 'small', inputTokens: 1000, outputTokens: 2000 }], ['svc.b', workB!, undefined]] as const) {
  const instanceId = actor === 'svc.a' ? copyA.id : copyB.id;
  await host.answerServiceWork(as(actor), { instanceId, executionId: work.executionId, answer: 'accept' });
  await host.reportServiceWork(as(actor), { instanceId, executionId: work.executionId, status: 'SUCCESS', answer: { text: 'hello', ...(usage ? { usage } : {}) } });
}
await run;

// Usage: the latest answers that carry usage figures.
const usage = await host.serviceUsage(as('admin'), { serviceKey: 'neo.test.ask-a' });
assert.equal(usage.serviceKey, 'neo.test.ask-a');
assert.deepEqual(usage.runs.map(({ version, model, inputTokens, outputTokens }) => ({ version, model, inputTokens, outputTokens })), [{ version: '1.0.0', model: 'small', inputTokens: 1000, outputTokens: 2000 }]);
assert.deepEqual((await host.serviceUsage(as('admin'), { serviceKey: 'neo.test.ask-b' })).runs, [], 'an answer without usage is not counted');
await assert.rejects(() => host.serviceUsage(as('admin'), { serviceKey: 'neo.test.ask-a', limit: 0 }), /limit must be a whole number from 1 to 200/);
await assert.rejects(() => host.serviceUsage(as('shop'), { serviceKey: 'neo.test.ask-a' }), /CoreHostAuthorizationError/);

console.log('Service settings test passed.');
