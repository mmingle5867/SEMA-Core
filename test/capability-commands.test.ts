import assert from 'node:assert/strict';
import { CapabilityRegistry, CapabilityWork, InMemoryCapabilityStore, InMemorySemaCoreHostStore, InMemoryWorkStore, LIMITS, SemaCore, SemaCoreHost, schemaProblems, valueProblems, type CoreHostAuthorization } from '../src/index.js';

// Commands to a capability (phase 2): can, may, should, execute; services take work, answer and report; waiting.
const grants: Record<string, Set<string>> = {
  admin: new Set(['core.capabilities.read', 'core.capabilities.register', 'core.services.install']),
  'svc.a': new Set(['core.services.run']), 'svc.b': new Set(['core.services.run']),
  shop: new Set(['capability.neo.test.echo', 'core.services.run']),
};
const allowed = async ({ actorId, resource }: { actorId: string | null; resource: string }) => !!actorId && !!grants[actorId]?.has(resource);
const authorization: CoreHostAuthorization = { canRead: allowed, canAdminister: allowed };
const store = new InMemorySemaCoreHostStore();
const core = new SemaCore(store, { installationId: '3', maxReservationSize: 25 });
const records = new InMemoryCapabilityStore();
const issue = async (typeCode: string, metadata: object) => (await core.issueIdentifier(typeCode, metadata as never)).id;
const host = new SemaCoreHost(core, store, authorization, undefined, undefined, undefined, undefined, new CapabilityRegistry(records, issue, async () => '3'), new CapabilityWork(core, records, new InMemoryWorkStore(), issue));
await host.initialize({ actorId: null });
const as = (actorId: string) => ({ actorId });

// ---- The schema checker: a stated subset of JSON Schema ----
assert.deepEqual(schemaProblems({ type: 'object', required: ['a'], properties: { a: { type: 'string', maxLength: 3 } }, additionalProperties: false }), []);
assert.match(schemaProblems({ type: 'string', pattern: '^a+$' }).join(), /uses "pattern", which SEMA's schema checker does not support/);
assert.match(schemaProblems({ type: 'object', additionalProperties: { type: 'string' } }).join(), /additionalProperties may only be false/);
assert.match(schemaProblems({ type: 'thing' }).join(), /type must be one of/);
const shape = { type: 'object', required: ['n', 'tags'], properties: { n: { type: 'integer', minimum: 1, maximum: 5 }, tags: { type: 'array', maxItems: 2, items: { type: 'string', enum: ['a', 'b'] } }, s: { type: 'string', minLength: 2 } }, additionalProperties: false } as const;
assert.deepEqual(valueProblems(shape as never, { n: 3, tags: ['a'] }), []);
assert.deepEqual(valueProblems(shape as never, { n: 2.5, tags: ['a', 'c', 'b'], s: 'x', extra: 1 }), ['input.n must be integer', 'input.tags must have at most 2 items', 'input.tags[1] must be one of "a", "b"', 'input.s must be at least 2 characters', 'input.extra is not allowed']);
assert.deepEqual(valueProblems(shape as never, {}), ['input.n is required', 'input.tags is required']);
assert.deepEqual(valueProblems({ type: 'string', maxLength: 2 }, '😀😀'), [], 'a length counts characters, not UTF-16 units');

// ---- A test capability and two services ----
const echo = { capabilityKey: 'neo.test.echo', version: '1.0.0', displayName: 'Echo', choosing: ['bound', 'dynamic', 'consensus', 'policy'], operations: [{ key: 'echo', required: true, input: { type: 'object', required: ['text'], properties: { text: { type: 'string', maxLength: 100 } }, additionalProperties: false }, output: { type: 'object', required: ['text'], properties: { text: { type: 'string' }, by: { type: 'string' } } } }] };
await assert.rejects(() => host.registerCapabilityVersion(as('admin'), { ...echo, choosing: [] }), /choosing must list the ways/);
await assert.rejects(() => host.registerCapabilityVersion(as('admin'), { ...echo, choosing: ['sometimes'] }), /choosing must list the ways/);
// A contract may list no ways at all: it is published, but cannot be run by command (programs reach its services directly).
const direct = await host.registerCapabilityVersion(as('admin'), { ...echo, capabilityKey: 'neo.test.direct', choosing: undefined });
assert.deepEqual(direct.choosing, []);
await assert.rejects(() => host.registerCapabilityVersion(as('admin'), { ...echo, operations: [{ key: 'echo', required: true, input: { type: 'string', pattern: 'x' } }] }), /does not support/);
const capability = await host.registerCapabilityVersion(as('admin'), echo);
const declarations = { runsWhere: 'device', offline: true, systems: ['windows'] };
const serviceA = await host.registerServiceVersion(as('admin'), { serviceKey: 'neo.test.echo-a', version: '1.0.0', capabilityVersionId: capability.id, displayName: 'Echo A', operations: ['echo'], declarations });
const serviceB = await host.registerServiceVersion(as('admin'), { serviceKey: 'neo.test.echo-b', version: '1.0.0', capabilityVersionId: capability.id, displayName: 'Echo B', operations: ['echo'], declarations });
const installA = await host.installService(as('admin'), { serviceVersionId: serviceA.id });
const installB = await host.installService(as('admin'), { serviceVersionId: serviceB.id });
const a = await host.startServiceInstance(as('svc.a'), { installationId: installA.id });
assert.equal(a.applicationKey, 'svc.a', 'Core records which program runs the instance');

// A service never issues a command (D-160).
await assert.rejects(() => host.runCapability(as('svc.a'), { capabilityKey: 'neo.test.echo', version: '1.0.0', operation: 'echo', way: 'bound', services: ['neo.test.echo-a'], input: { text: 'hi' } }), /A service never issues a command/);
// May: a program without capability.neo.test.echo is told only "not allowed", even for a capability that does not exist.
await assert.rejects(() => host.runCapability(as('admin'), { capabilityKey: 'neo.test.echo', version: '1.0.0', operation: 'echo', way: 'bound', services: ['neo.test.echo-a'], input: { text: 'hi' } }), /^CoreHostAuthorizationError: Not allowed$/);
await assert.rejects(() => host.runCapability(as('admin'), { capabilityKey: 'neo.secret.thing', version: '9.9.9', operation: 'x', way: 'bound' }), /^CoreHostAuthorizationError: Not allowed$/);

// A small service: takes work, then accepts and echoes, or declines.
type Behaviour = 'echo' | 'decline' | 'wrong' | 'big' | 'reference' | 'fail';
const serve = async (actor: string, instanceId: string, behaviour: Behaviour, by: string) => {
  const { work } = await host.takeServiceWork(as(actor), { instanceId, waitSeconds: 3 });
  if (!work) return undefined;
  if (behaviour === 'decline') { await host.answerServiceWork(as(actor), { instanceId, executionId: work.executionId, answer: 'decline', reason: 'busy' }); return work; }
  await host.answerServiceWork(as(actor), { instanceId, executionId: work.executionId, answer: 'accept' });
  const text = (work.input as { text: string }).text;
  if (behaviour === 'wrong') { await assert.rejects(() => host.reportServiceWork(as(actor), { instanceId, executionId: work.executionId, status: 'SUCCESS', answer: { words: text } }), /answer.text is required/); await host.reportServiceWork(as(actor), { instanceId, executionId: work.executionId, status: 'FAILED', error: 'could not make a proper answer' }); return work; }
  if (behaviour === 'big') { await assert.rejects(() => host.reportServiceWork(as(actor), { instanceId, executionId: work.executionId, status: 'SUCCESS', answer: { text: 'x'.repeat(70_000) } }), /goes by reference/); behaviour = 'reference'; }
  if (behaviour === 'reference') { await host.reportServiceWork(as(actor), { instanceId, executionId: work.executionId, status: 'SUCCESS', reference: 'resource:3-abc/3-abd', outcome: 'achieved' }); return work; }
  if (behaviour === 'fail') { await host.reportServiceWork(as(actor), { instanceId, executionId: work.executionId, status: 'FAILED', error: 'broke' }); return work; }
  await host.reportServiceWork(as(actor), { instanceId, executionId: work.executionId, status: 'SUCCESS', answer: { text, by }, outcome: 'achieved' });
  return work;
};
const run = (input: Record<string, unknown>) => host.runCapability(as('shop'), { capabilityKey: 'neo.test.echo', version: '1.0.0', operation: 'echo', input: { text: 'hello' }, waitSeconds: 5, ...input } as never);

// Bound: exactly the one named; the application waits and gets the answer in its one result.
let [result] = await Promise.all([run({ way: 'bound', services: ['neo.test.echo-a'] }), serve('svc.a', a.id, 'echo', 'A')]);
assert.deepEqual(result.entries.map((entry) => [entry.serviceKey, entry.status, entry.answer, entry.outcome]), [['neo.test.echo-a', 'SUCCESS', { text: 'hello', by: 'A' }, 'achieved']]);
assert.equal((await core.getCommand(result.commandId))!.status, 'SUCCESS');
// Bound never passes to another service: B is not running, and asking for it fails with the reason.
await assert.rejects(() => run({ way: 'bound', services: ['neo.test.echo-b'] }), /No service can run now\. neo\.test\.echo-b 1\.0\.0: not running/);
await assert.rejects(() => run({ way: 'bound', services: ['neo.test.echo-a', 'neo.test.echo-b'] }), /Bound runs exactly one service/);
await assert.rejects(() => run({ way: 'policy' }), /not available until organization rules are built/);
await assert.rejects(() => run({ way: 'whatever', services: ['neo.test.echo-a'] }), /permits choosing its services by bound, dynamic, consensus, policy, not whatever/);
await assert.rejects(() => run({ way: 'bound', services: ['neo.test.echo-a'], input: { text: 5, more: true } }), /The input does not match neo.test.echo 1.0.0: input.text must be string; input.more is not allowed/);

// Waiting zero: the result is recorded at once with the execution still pending, and never changes. Waiting again on
// the command shows what has finished since.
result = await run({ way: 'bound', services: [serviceA.id], waitSeconds: 0 });
assert.deepEqual(result.entries.map((entry) => entry.status), ['PENDING']);
await serve('svc.a', a.id, 'echo', 'A');
const later = await host.waitOnCapabilityCommand(as('shop'), { commandId: result.commandId, waitSeconds: 1 });
assert.deepEqual(later.entries.map((entry) => [entry.status, entry.answer]), [['SUCCESS', { text: 'hello', by: 'A' }]]);
assert.deepEqual(later.result!.entries.map((entry) => entry.status), ['PENDING'], 'the command\'s one result never changes');
await assert.rejects(() => host.waitOnCapabilityCommand(as('admin'), { commandId: result.commandId }), /not one of this program's capability commands/);

// Another program cannot use this instance; a program that issued commands cannot run a service.
await assert.rejects(() => host.takeServiceWork(as('svc.b'), { instanceId: a.id, waitSeconds: 0 }), /belongs to another program/);
await assert.rejects(() => host.startServiceInstance(as('shop'), { installationId: installB.id }), /has issued capability commands, so it cannot run a service/);
const b = await host.startServiceInstance(as('svc.b'), { installationId: installB.id });

// Dynamic: A declines ("not now"), so B, next in the order asked for, does the work.
[result] = await Promise.all([run({ way: 'dynamic', services: ['neo.test.echo-a', 'neo.test.echo-b'] }), serve('svc.a', a.id, 'decline', 'A'), serve('svc.b', b.id, 'echo', 'B')]);
assert.deepEqual(result.entries.map((entry) => [entry.serviceKey, entry.status, entry.notNow?.reason ?? entry.answer]), [['neo.test.echo-a', 'FAILED', 'busy'], ['neo.test.echo-b', 'SUCCESS', { text: 'hello', by: 'B' }]]);

// Consensus: every service that can run, each in its own entry of the one result.
[result] = await Promise.all([run({ way: 'consensus' }), serve('svc.a', a.id, 'echo', 'A'), serve('svc.b', b.id, 'echo', 'B')]);
assert.deepEqual(result.entries.map((entry) => entry.answer).sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y))), [{ text: 'hello', by: 'A' }, { text: 'hello', by: 'B' }]);

// Answers: one that does not match the contract is refused; over 64 KB goes by reference; failures say why.
[result] = await Promise.all([run({ way: 'consensus' }), serve('svc.a', a.id, 'wrong', 'A'), serve('svc.b', b.id, 'big', 'B')]);
assert.deepEqual(result.entries.map((entry) => [entry.serviceKey, entry.status, entry.error ?? entry.reference]).sort(), [['neo.test.echo-a', 'FAILED', 'could not make a proper answer'], ['neo.test.echo-b', 'SUCCESS', 'resource:3-abc/3-abd']]);
assert.equal((await core.getCommand(result.commandId))!.status, 'SUCCESS', 'the command succeeded: one of its executions did');

// Work offered and never answered is offered again after a while, here to another copy of the same service.
const a2 = await host.startServiceInstance(as('svc.a'), { installationId: installA.id });
result = await run({ way: 'bound', services: ['neo.test.echo-a'], waitSeconds: 0 });
const first = (await host.takeServiceWork(as('svc.a'), { instanceId: a.id, waitSeconds: 0 })).work!;
assert.equal((await host.takeServiceWork(as('svc.a'), { instanceId: a2.id, waitSeconds: 0 })).work, null, 'not while the offer is fresh');
const offerSeconds = LIMITS.offerSeconds; LIMITS.offerSeconds = 0;
await new Promise((wait) => setTimeout(wait, 5));
const again = (await host.takeServiceWork(as('svc.a'), { instanceId: a2.id, waitSeconds: 0 })).work!;
LIMITS.offerSeconds = offerSeconds;
assert.equal(again.executionId, first.executionId);
await assert.rejects(() => host.answerServiceWork(as('svc.a'), { instanceId: a.id, executionId: first.executionId, answer: 'accept' }), /not waiting for this instance's answer/);
await host.answerServiceWork(as('svc.a'), { instanceId: a2.id, executionId: again.executionId, answer: 'accept' });
await host.reportServiceWork(as('svc.a'), { instanceId: a2.id, executionId: again.executionId, status: 'SUCCESS', answer: { text: 'hello' } });
assert.equal((await host.waitOnCapabilityCommand(as('shop'), { commandId: result.commandId, waitSeconds: 0 })).entries[0].status, 'SUCCESS');

// A copy asking for work is held until work arrives. Asking counts as checking in.
const askedAt = new Date().toISOString();
const asking = host.takeServiceWork(as('svc.b'), { instanceId: b.id, waitSeconds: 5 });
await new Promise((wait) => setTimeout(wait, 100));
result = await run({ way: 'bound', services: ['neo.test.echo-b'], waitSeconds: 0 });
const handed = (await asking).work!;
assert.equal(handed.commandId, result.commandId, 'the waiting copy got the new work');
assert.ok((await records.getInstance(b.id))!.lastCheckInAt >= askedAt, 'asking for work counts as checking in');

// ---- A general capability: callers say what shape they want back, and name the job (D-172 to D-174) ----
const general = { capabilityKey: 'neo.test.generate', version: '1.0.0', displayName: 'Generate', choosing: ['bound', 'consensus'], operations: [{
  key: 'generate', required: true, job: 'job', answerShape: { input: 'answerShape', output: 'answer' },
  input: { type: 'object', required: ['job', 'answerShape', 'prompt'], properties: { job: { type: 'object', required: ['key', 'version'], properties: { key: { type: 'string' }, version: { type: 'string' } } }, answerShape: { type: 'object' }, prompt: { type: 'string' } } },
  output: { type: 'object', required: ['answer'], properties: { answer: {} } },
}] };
await assert.rejects(() => host.registerCapabilityVersion(as('admin'), { ...general, operations: [{ ...general.operations[0], answerShape: { input: 'shape', output: 'answer' } }] }), /answerShape.input must be a property of its input/);
await assert.rejects(() => host.registerCapabilityVersion(as('admin'), { ...general, operations: [{ ...general.operations[0], job: 'task' }] }), /job must name a property of its input/);
const generalCapability = await host.registerCapabilityVersion(as('admin'), general);
assert.deepEqual([generalCapability.operations[0].job, generalCapability.operations[0].answerShape], ['job', { input: 'answerShape', output: 'answer' }]);
const writer = await host.registerServiceVersion(as('admin'), { serviceKey: 'neo.test.writer', version: '1.0.0', capabilityVersionId: generalCapability.id, displayName: 'Writer', operations: ['generate'], declarations });
const writerCopy = await host.startServiceInstance(as('svc.a'), { installationId: (await host.installService(as('admin'), { serviceVersionId: writer.id })).id });
const titleShape = { type: 'object', required: ['title'], properties: { title: { type: 'string', maxLength: 10 } }, additionalProperties: false };
const ask = (job: string, answerShape: object) => host.runCapability(as('shop'), { capabilityKey: 'neo.test.generate', version: '1.0.0', operation: 'generate', way: 'bound', services: ['neo.test.writer'], input: { job: { key: job, version: '1.0' }, answerShape, prompt: 'Write a title' }, waitSeconds: 5 });
grants.shop.add('capability.neo.test.generate');
// The job needs its own permission: without capability.neo.test.generate.job.listing-copy, only "not allowed".
await assert.rejects(() => ask('listing-copy', titleShape), /^CoreHostAuthorizationError: Not allowed$/);
grants.shop.add('capability.neo.test.generate.job.listing-copy');
await assert.rejects(() => ask('pricing', titleShape), /^CoreHostAuthorizationError: Not allowed$/, 'a job not granted stays refused');
// A requested shape Core cannot check is refused on the way in.
await assert.rejects(() => ask('listing-copy', { type: 'string', pattern: 'x' }), /requested answer shape cannot be checked: input.answerShape uses "pattern"/);
// The answer must match the requested shape, not only the contract.
const answerWith = async (answer: object) => {
  const { work } = await host.takeServiceWork(as('svc.a'), { instanceId: writerCopy.id, waitSeconds: 3 });
  await host.answerServiceWork(as('svc.a'), { instanceId: writerCopy.id, executionId: work!.executionId, answer: 'accept' });
  return { work: work!, report: () => host.reportServiceWork(as('svc.a'), { instanceId: writerCopy.id, executionId: work!.executionId, status: 'SUCCESS', answer }) };
};
const pending = ask('listing-copy', titleShape);
const offered = await answerWith({ answer: { title: 'Far too long a title', extra: 1 } });
await assert.rejects(() => offered.report(), /The answer does not match neo.test.generate 1.0.0: answer.answer.title must be at most 10 characters; answer.answer.extra is not allowed/);
await host.reportServiceWork(as('svc.a'), { instanceId: writerCopy.id, executionId: offered.work.executionId, status: 'SUCCESS', answer: { answer: { title: 'Blue mug' } } });
assert.deepEqual((await pending).entries[0].answer, { answer: { title: 'Blue mug' } });

console.log('Capability commands test passed.');
