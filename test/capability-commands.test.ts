import assert from 'node:assert/strict';
import { CapabilityRegistry, CapabilityWork, InMemoryCapabilityStore, InMemorySemaCoreHostStore, InMemoryWorkStore, LIMITS, SemaCore, SemaCoreHost, schemaProblems, valueProblems, type CoreHostAuthorization } from '../src/index.js';

// Commands to a capability (phase 2): can, may, should, execute; services take work, answer and report; waiting.
const grants: Record<string, Set<string>> = {
  admin: new Set(['core.capabilities.read', 'core.capabilities.register', 'core.services.install']),
  'svc.a': new Set(['core.services.run']), 'svc.b': new Set(['core.services.run']), 'svc.c': new Set(['core.services.run']),
  shop: new Set(['capability.neo.test.echo', 'core.services.run']),
};
const allowed = async ({ actorId, resource }: { actorId: string | null; resource: string }) => !!actorId && !!grants[actorId]?.has(resource);
const authorization: CoreHostAuthorization = { canRead: allowed, canAdminister: allowed };
const store = new InMemorySemaCoreHostStore();
const core = new SemaCore(store, { installationId: '3', maxReservationSize: 25 });
const records = new InMemoryCapabilityStore();
const issue = async (typeCode: string, metadata: object) => (await core.issueIdentifier(typeCode, metadata as never)).id;
const work = new CapabilityWork(core, records, new InMemoryWorkStore(), issue);
const host = new SemaCoreHost(core, store, authorization, undefined, undefined, undefined, undefined, new CapabilityRegistry(records, issue, async () => '3'), work);
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
await assert.rejects(() => run({ way: 'policy' }), /Choosing by policy rules is not built yet/);
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

// ---- Phase 3a: defer, unavailable, still working, enough (D-178 to D-182) ----
const take = async (actor: string, instanceId: string) => (await host.takeServiceWork(as(actor), { instanceId, waitSeconds: 2 })).work!;
const finish = (actor: string, instanceId: string, executionId: string, text = 'hello') => host.reportServiceWork(as(actor), { instanceId, executionId, status: 'SUCCESS', answer: { text } });
const accept = (actor: string, instanceId: string, executionId: string) => host.answerServiceWork(as(actor), { instanceId, executionId, answer: 'accept' });

// Defer under one service only: not offered again before its time, then done.
result = await run({ way: 'bound', services: ['neo.test.echo-a'], waitSeconds: 0 });
let offer = await take('svc.a', a.id);
await assert.rejects(() => host.answerServiceWork(as('svc.a'), { instanceId: a.id, executionId: offer.executionId, answer: 'defer', until: new Date(Date.now() - 1000).toISOString(), reason: 'later' }), /until must be a time after now and at most 24 hours ahead/);
await assert.rejects(() => host.answerServiceWork(as('svc.a'), { instanceId: a.id, executionId: offer.executionId, answer: 'defer', until: new Date(Date.now() + 25 * 3600_000).toISOString(), reason: 'later' }), /at most 24 hours ahead/);
await host.answerServiceWork(as('svc.a'), { instanceId: a.id, executionId: offer.executionId, answer: 'defer', until: new Date(Date.now() + 1500).toISOString(), reason: 'warming up' });
assert.equal((await host.takeServiceWork(as('svc.a'), { instanceId: a.id, waitSeconds: 0 })).work, null, 'not offered again before its time');
let state = await host.waitOnCapabilityCommand(as('shop'), { commandId: result.commandId, waitSeconds: 0 });
assert.equal(state.entries[0].status, 'PENDING');
assert.ok(state.entries[0].deferredUntil, 'the entry says until when');
await new Promise((wait) => setTimeout(wait, 1600));
offer = await take('svc.a', a.id);
await accept('svc.a', a.id, offer.executionId); await finish('svc.a', a.id, offer.executionId);
assert.equal((await host.waitOnCapabilityCommand(as('shop'), { commandId: result.commandId, waitSeconds: 1 })).entries[0].status, 'SUCCESS');

// Defer under a list in order: the next service takes it meanwhile; once it answers, the deferred one is cancelled.
result = await run({ way: 'dynamic', services: ['neo.test.echo-a', 'neo.test.echo-b'], waitSeconds: 0 });
offer = await take('svc.a', a.id);
await host.answerServiceWork(as('svc.a'), { instanceId: a.id, executionId: offer.executionId, answer: 'defer', until: new Date(Date.now() + 60_000).toISOString(), reason: 'busy for a minute' });
let offerB = await take('svc.b', b.id);
await accept('svc.b', b.id, offerB.executionId); await finish('svc.b', b.id, offerB.executionId, 'from B');
state = await host.waitOnCapabilityCommand(as('shop'), { commandId: result.commandId, waitSeconds: 1 });
assert.deepEqual(state.entries.map((entry) => [entry.serviceKey, entry.status]), [['neo.test.echo-a', 'CANCELLED'], ['neo.test.echo-b', 'SUCCESS']]);
assert.equal((await core.getCommand(result.commandId))!.status, 'SUCCESS');

// Unavailable, with what is missing: the next service in the order takes it.
result = await run({ way: 'dynamic', services: ['neo.test.echo-a', 'neo.test.echo-b'], waitSeconds: 0 });
offer = await take('svc.a', a.id);
await assert.rejects(() => host.answerServiceWork(as('svc.a'), { instanceId: a.id, executionId: offer.executionId, answer: 'unavailable', reasons: [{ kind: 'mood', lasting: 'temporary' }] }), /kind must be one of memory, disk/);
await assert.rejects(() => host.answerServiceWork(as('svc.a'), { instanceId: a.id, executionId: offer.executionId, answer: 'unavailable', reasons: [{ kind: 'network' }] }), /network: say whether it is temporary or permanent/);
await assert.rejects(() => host.answerServiceWork(as('svc.a'), { instanceId: a.id, executionId: offer.executionId, answer: 'unavailable', reasons: [{ kind: 'memory', needed: 8192 }] }), /give needed and total/);
await assert.rejects(() => host.answerServiceWork(as('svc.a'), { instanceId: a.id, executionId: offer.executionId, answer: 'unavailable', reasons: [{ kind: 'memory', needed: 8192, free: 9000, total: 4096 }] }), /free cannot be more than total/);
// Enough memory in all but in use now: temporary, even if the service called it permanent (D-185).
await host.answerServiceWork(as('svc.a'), { instanceId: a.id, executionId: offer.executionId, answer: 'unavailable', reasons: [{ kind: 'memory', lasting: 'permanent', needed: 8192, free: 2048, total: 16384 }] });
offerB = await take('svc.b', b.id);
await accept('svc.b', b.id, offerB.executionId); await finish('svc.b', b.id, offerB.executionId);
state = await host.waitOnCapabilityCommand(as('shop'), { commandId: result.commandId, waitSeconds: 1 });
assert.deepEqual(state.entries[0].notNow, { answer: 'unavailable', reason: 'memory: needs 8192 MB, 2048 MB of 16384 MB free, the rest in use (temporary)', reasons: [{ kind: 'memory', lasting: 'temporary', needed: 8192, free: 2048, total: 16384 }] });
assert.equal(state.entries[1].status, 'SUCCESS');
// Needing more than the machine has in all: permanent, even if the service called it temporary; this machine can never run it.
result = await run({ way: 'bound', services: ['neo.test.echo-a'], waitSeconds: 0 });
offer = await take('svc.a', a.id);
await host.answerServiceWork(as('svc.a'), { instanceId: a.id, executionId: offer.executionId, answer: 'unavailable', reasons: [{ kind: 'memory', lasting: 'temporary', needed: 8192, free: 1024, total: 4096 }, { kind: 'network', lasting: 'temporary', note: 'no internet' }] });
state = await host.waitOnCapabilityCommand(as('shop'), { commandId: result.commandId, waitSeconds: 1 });
assert.deepEqual(state.entries[0].notNow!.reasons!.map((reason) => reason.lasting), ['permanent', 'temporary']);
assert.equal(state.entries[0].notNow!.reason, 'memory: needs 8192 MB, this machine has 4096 MB in all (permanent); network: no internet (temporary)');
assert.equal((await core.getCommand(result.commandId))!.status, 'FAILED', 'one service only: nothing else is tried');

// Still working: the service says how far along it is; one that goes silent is marked failed, and its late answer refused.
result = await run({ way: 'bound', services: ['neo.test.echo-a'], waitSeconds: 0 });
offer = await take('svc.a', a.id);
await accept('svc.a', a.id, offer.executionId);
await host.progressServiceWork(as('svc.a'), { instanceId: a.id, executionId: offer.executionId, percent: 40, note: 'drafting' });
await assert.rejects(() => host.progressServiceWork(as('svc.a'), { instanceId: a.id, executionId: offer.executionId, percent: 140 }), /percent must be a number from 0 to 100/);
state = await host.waitOnCapabilityCommand(as('shop'), { commandId: result.commandId, waitSeconds: 0 });
assert.deepEqual([state.entries[0].status, state.entries[0].progress?.percent, state.entries[0].progress?.note], ['RUNNING', 40, 'drafting']);
assert.deepEqual(await work.markSilent(60_000), [], 'a job reported on recently is left alone');
await new Promise((wait) => setTimeout(wait, 30));
assert.deepEqual(await work.markSilent(10), [offer.executionId]);
state = await host.waitOnCapabilityCommand(as('shop'), { commandId: result.commandId, waitSeconds: 0 });
assert.deepEqual([state.entries[0].status, state.entries[0].error], ['FAILED', 'stopped reporting: no word from the service for 0 s']);
assert.equal((await core.getCommand(result.commandId))!.status, 'FAILED');
await assert.rejects(() => finish('svc.a', a.id, offer.executionId), /is not running on this instance/, 'a late answer is refused');

// Enough: under all of them, the command is finished once that many have succeeded; the rest record theirs late.
await assert.rejects(() => run({ way: 'bound', services: ['neo.test.echo-a'], enough: 1 }), /enough applies only when all of them are asked/);
await assert.rejects(() => run({ way: 'consensus', enough: 9 }), /enough is 9, but only 2 services can run now/);
const pendingEnough = run({ way: 'consensus', enough: 1, waitSeconds: 5 });
offer = await take('svc.a', a.id);
await accept('svc.a', a.id, offer.executionId); await finish('svc.a', a.id, offer.executionId, 'first');
result = await pendingEnough;
assert.deepEqual(result.entries.map((entry) => entry.status).sort(), ['PENDING', 'SUCCESS'], 'answered as soon as one had succeeded');
assert.equal((await core.getCommand(result.commandId))!.status, 'SUCCESS');
offerB = await take('svc.b', b.id);
await accept('svc.b', b.id, offerB.executionId); await finish('svc.b', b.id, offerB.executionId, 'late');
state = await host.waitOnCapabilityCommand(as('shop'), { commandId: result.commandId, waitSeconds: 1 });
assert.deepEqual(state.entries.map((entry) => entry.status), ['SUCCESS', 'SUCCESS'], 'the late one recorded its answer');
assert.deepEqual(state.result!.entries.map((entry) => entry.status).sort(), ['PENDING', 'SUCCESS'], "the command's one result never changes");

// ---- Phase 3b: "can" compares what a service needs with what its copies' machines have (D-181, D-185) ----
await assert.rejects(() => host.registerServiceVersion(as('admin'), { serviceKey: 'neo.test.echo-c', version: '1.0.0', capabilityVersionId: capability.id, displayName: 'Echo C', operations: ['echo'], declarations: { ...declarations, needs: { speed: 9 } } }), /declarations.needs.speed is not known/);
await assert.rejects(() => host.registerServiceVersion(as('admin'), { serviceKey: 'neo.test.echo-c', version: '1.0.0', capabilityVersionId: capability.id, displayName: 'Echo C', operations: ['echo'], declarations: { ...declarations, needs: { memoryMb: 0 } } }), /must be a number above 0/);
const needy = await host.registerServiceVersion(as('admin'), { serviceKey: 'neo.test.echo-c', version: '1.0.0', capabilityVersionId: capability.id, displayName: 'Echo C', operations: ['echo'], declarations: { runsWhere: 'remote', offline: false, systems: ['windows'], needs: { memoryMb: 8192, cores: 2 } } });
const c = await host.startServiceInstance(as('svc.c'), { installationId: (await host.installService(as('admin'), { serviceVersionId: needy.id })).id });
const machine = (report: object) => host.checkInServiceInstance(as('svc.c'), { instanceId: c.id, resources: report });
// This machine has less memory than the service needs in all: it can never run here.
await machine({ network: true, memory: { freeMb: 3000, totalMb: 4096 }, processor: { cores: 8 } });
await assert.rejects(() => run({ way: 'bound', services: ['neo.test.echo-c'] }), /neo.test.echo-c 1.0.0: memory: needs 8192 MB, this machine has 4096 MB in all \(permanent\)/);
// Enough in all, but in use now: not now, try later.
await machine({ network: true, memory: { freeMb: 1024, totalMb: 16384 }, processor: { cores: 8 } });
await assert.rejects(() => run({ way: 'bound', services: ['neo.test.echo-c'] }), /memory: needs 8192 MB, 1024 MB of 16384 MB free, the rest in use \(temporary\)/);
// It needs the network (it does not work offline), and the machine has none.
await machine({ network: false, memory: { freeMb: 12000, totalMb: 16384 }, processor: { cores: 8 } });
await assert.rejects(() => run({ way: 'bound', services: ['neo.test.echo-c'] }), /network: no network \(temporary\)/);
await machine({ network: true, memory: { freeMb: 12000, totalMb: 16384 }, processor: { cores: 1 } });
await assert.rejects(() => run({ way: 'bound', services: ['neo.test.echo-c'] }), /processor: needs 2 cores, this machine has 1 core in all \(permanent\)/);
// Under a list in order the next service that can run is chosen; the one that cannot is not even offered the work.
await machine({ network: false, memory: { freeMb: 12000, totalMb: 16384 }, processor: { cores: 8 } });
const routed = run({ way: 'dynamic', services: ['neo.test.echo-c', 'neo.test.echo-a'], waitSeconds: 5 });
offer = await take('svc.a', a.id);
await accept('svc.a', a.id, offer.executionId); await finish('svc.a', a.id, offer.executionId, 'from A');
assert.deepEqual((await routed).entries.map((entry) => [entry.serviceKey, entry.status]), [['neo.test.echo-a', 'SUCCESS']]);
// Once the machine has what it needs, it runs.
await machine({ network: true, memory: { freeMb: 12000, totalMb: 16384 }, processor: { cores: 8 } });
const ran = run({ way: 'bound', services: ['neo.test.echo-c'], waitSeconds: 5 });
offer = await take('svc.c', c.id);
await accept('svc.c', c.id, offer.executionId); await finish('svc.c', c.id, offer.executionId, 'from C');
assert.equal((await ran).entries[0].status, 'SUCCESS');
// A part a copy does not report is not held against it: Core cannot tell, and the service can still say unavailable.
await machine({});
const unknown = run({ way: 'bound', services: ['neo.test.echo-c'], waitSeconds: 5 });
offer = await take('svc.c', c.id);
await accept('svc.c', c.id, offer.executionId); await finish('svc.c', c.id, offer.executionId);
assert.equal((await unknown).entries[0].status, 'SUCCESS');
await host.stopServiceInstance(as('svc.c'), { instanceId: c.id });

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
