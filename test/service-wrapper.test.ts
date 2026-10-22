import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { CapabilityRegistry, CapabilityWork, InMemoryCapabilityStore, InMemoryClientKeyStore, InMemorySemaCoreHostStore, InMemoryWorkStore, MemoryKeyStore, NonceMemory, SemaCore, SemaCoreHost, ServiceWrapper, startCoreHostHttpServer, type CoreHostAuthorization, type HandlerResult } from '../src/index.js';

// The wrapper around a service, against a real Core host over HTTP: signed requests, its instance, taking work,
// accepting or declining, checking answers against the contract, reporting, failing, and stopping.
const grants: Record<string, string[]> = {
  admin: ['core.capabilities.read', 'core.capabilities.register', 'core.services.install'],
  'svc.a': ['core.capabilities.read', 'core.services.run'], 'svc.b': ['core.capabilities.read', 'core.services.run'],
  shop: ['capability.neo.test.echo'],
};
const allowed = async ({ actorId, resource }: { actorId: string | null; resource: string }) => !!actorId && !!grants[actorId]?.includes(resource);
const authorization: CoreHostAuthorization = { canRead: allowed, canAdminister: allowed };
const store = new InMemorySemaCoreHostStore();
const core = new SemaCore(store, { installationId: '3', maxReservationSize: 25 });
const records = new InMemoryCapabilityStore();
const issue = async (typeCode: string, metadata: object) => (await core.issueIdentifier(typeCode, metadata as never)).id;
const host = new SemaCoreHost(core, store, authorization, undefined, undefined, undefined, { machine: await new MemoryKeyStore().open(), clients: new InMemoryClientKeyStore(), nonces: new NonceMemory() }, new CapabilityRegistry(records, issue, async () => '3'), new CapabilityWork(core, records, new InMemoryWorkStore(), issue));
await host.initialize({ actorId: null });
const server = await startCoreHostHttpServer(host, { port: 0, applicationClients: [{ applicationKey: 'svc.a', secret: 'secret-a' }, { applicationKey: 'svc.b', secret: 'secret-b' }] });
const coreUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const as = (actorId: string) => ({ actorId });

const contract = { capabilityKey: 'neo.test.echo', version: '1.0.0', displayName: 'Echo', choosing: ['bound', 'dynamic', 'consensus'], operations: [
  { key: 'echo', required: true, input: { type: 'object', required: ['text'], properties: { text: { type: 'string' } } }, output: { type: 'object', required: ['text'], properties: { text: { type: 'string' } } } },
] };
const capability = await host.registerCapabilityVersion(as('admin'), contract);
const declarations = { runsWhere: 'device', offline: true, systems: ['windows'] };
for (const name of ['a', 'b']) {
  const service = await host.registerServiceVersion(as('admin'), { serviceKey: `neo.test.echo-${name}`, version: '1.0.0', capabilityVersionId: capability.id, displayName: `Echo ${name}`, operations: ['echo'], declarations });
  await host.installService(as('admin'), { serviceVersionId: service.id });
}
const run = (input: Record<string, unknown>) => host.runCapability(as('shop'), { capabilityKey: 'neo.test.echo', version: '1.0.0', operation: 'echo', waitSeconds: 10, ...input } as never);
const logA: string[] = [], logB: string[] = [];
let busy = false, inFlight = 0, most = 0;

// Service A echoes, slowly enough that two jobs overlap; it declines while "busy"; "boom" makes it throw; "wrong" makes
// it answer outside the contract.
const a = await ServiceWrapper.start({
  coreUrl, applicationKey: 'svc.a', secret: 'secret-a', key: await new MemoryKeyStore().open(), service: { serviceKey: 'neo.test.echo-a', version: '1.0.0' }, contract,
  capacity: 2, workWaitSeconds: 1, retryMs: 100, log: (line) => logA.push(line),
  accept: () => busy ? 'busy right now' : true,
  operations: {
    echo: async (input): Promise<HandlerResult> => {
      inFlight += 1; most = Math.max(most, inFlight);
      await new Promise((wait) => setTimeout(wait, 150));
      inFlight -= 1;
      const text = (input as { text: string }).text;
      if (text === 'boom') throw new Error('the echo broke');
      if (text === 'wrong') return { answer: { words: text } };
      if (text === 'big') return { reference: 'resource:3-xyz/3-xz2' };
      return { answer: { text: `A: ${text}` }, outcome: 'achieved' };
    },
  },
});
const b = await ServiceWrapper.start({
  coreUrl, applicationKey: 'svc.b', secret: 'secret-b', key: await new MemoryKeyStore().open(), service: { serviceKey: 'neo.test.echo-b', version: '1.0.0' }, contract,
  workWaitSeconds: 1, retryMs: 100, log: (line) => logB.push(line),
  operations: { echo: async (input) => ({ answer: { text: `B: ${(input as { text: string }).text}` } }) },
});
try {
  // Each records its instance under its own program key, having registered its signing key.
  for (let tries = 0; (!a.instance || !b.instance) && tries < 50; tries++) await new Promise((wait) => setTimeout(wait, 50));
  assert.ok(a.instance && b.instance, `both recorded: ${[...logA, ...logB].join(' | ')}`);
  assert.equal((await records.getInstance(a.instance!))!.applicationKey, 'svc.a');
  assert.equal((await records.getInstance(a.instance!))!.capacity, 2);

  // Bound, dynamic and consensus, through the wrapper.
  let result = await run({ way: 'bound', services: ['neo.test.echo-a'], input: { text: 'hi' } });
  assert.deepEqual(result.entries.map((entry) => [entry.status, entry.answer, entry.outcome]), [['SUCCESS', { text: 'A: hi' }, 'achieved']]);
  busy = true;
  result = await run({ way: 'dynamic', services: ['neo.test.echo-a', 'neo.test.echo-b'], input: { text: 'hi' } });
  assert.deepEqual(result.entries.map((entry) => [entry.serviceKey, entry.status, entry.notNow?.reason ?? entry.answer]), [['neo.test.echo-a', 'FAILED', 'busy right now'], ['neo.test.echo-b', 'SUCCESS', { text: 'B: hi' }]]);
  busy = false;
  result = await run({ way: 'consensus', input: { text: 'hi' } });
  assert.deepEqual(result.entries.map((entry) => (entry.answer as { text: string }).text).sort(), ['A: hi', 'B: hi']);

  // A handler that throws is reported as a failure with its message; an answer outside the contract is caught by the
  // wrapper before reporting; a stored answer goes by reference.
  result = await run({ way: 'bound', services: ['neo.test.echo-a'], input: { text: 'boom' } });
  assert.deepEqual([result.entries[0].status, result.entries[0].error], ['FAILED', 'the echo broke']);
  result = await run({ way: 'bound', services: ['neo.test.echo-a'], input: { text: 'wrong' } });
  assert.match(result.entries[0].error!, /does not match neo.test.echo 1.0.0: answer.text is required/);
  result = await run({ way: 'bound', services: ['neo.test.echo-a'], input: { text: 'big' } });
  assert.deepEqual([result.entries[0].status, result.entries[0].reference], ['SUCCESS', 'resource:3-xyz/3-xz2']);

  // Capacity 2: two commands at once are worked on at the same time.
  const both = await Promise.all([run({ way: 'bound', services: ['neo.test.echo-a'], input: { text: 'one' } }), run({ way: 'bound', services: ['neo.test.echo-a'], input: { text: 'two' } })]);
  assert.deepEqual(both.map((item) => item.entries[0].status), ['SUCCESS', 'SUCCESS']);
  assert.equal(most, 2, 'two jobs ran at once');

  // Stopping: the instance is recorded as stopped, and a bound command to it now fails with the reason.
  await b.stop();
  assert.equal((await records.getInstance(b.instance!))!.state, 'STOPPED');
  await assert.rejects(() => run({ way: 'bound', services: ['neo.test.echo-b'], input: { text: 'hi' } }), /neo.test.echo-b 1.0.0: not running/);

  // If Core stops the instance from its side, the wrapper records a new one and carries on.
  const before = a.instance!;
  await host.stopServiceInstance(as('svc.a'), { instanceId: before });
  for (let tries = 0; a.instance === before && tries < 100; tries++) await new Promise((wait) => setTimeout(wait, 50));
  for (let tries = 0; !a.instance && tries < 100; tries++) await new Promise((wait) => setTimeout(wait, 50));
  assert.ok(a.instance && a.instance !== before, 'a new instance was recorded');
  result = await run({ way: 'bound', services: ['neo.test.echo-a'], input: { text: 'again' } });
  assert.deepEqual(result.entries[0].answer, { text: 'A: again' });
  console.log('Service wrapper test passed.');
} finally {
  await a.stop(); await b.stop();
  await new Promise<void>((done) => { server.close(() => done()); server.closeAllConnections(); });
}
