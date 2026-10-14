import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  CoreHostValidationError, InMemorySemaCoreHostStore, LocalCoreHostAuthorization, SEMA_CORE_VERSION, SemaCore, SemaCoreHost,
  getCoreDocumentation,
} from '../src/index.js';

const store = new InMemorySemaCoreHostStore();
const core = new SemaCore(store, { installationId: '3', maxReservationSize: 25 });
const host = new SemaCoreHost(core, store, new LocalCoreHostAuthorization(new Set(['admin'])));
await host.initialize({ actorId: 'admin' });
assert.equal((await host.getSettings({ actorId: 'admin' })).values.maxReservationSize, 25);
const changed = await host.updateSettings({ actorId: 'admin' }, { maxReservationSize: 50 });
assert.equal(changed.revision, 2);
assert.equal(core.getMaxReservationSize(), 50);
await core.issueIdentifier('TEST');
assert.equal((await host.statistics({ actorId: 'admin' })).identifiers.issued, 2); // object + audit entry
const command = await host.createCommand({ actorId: 'admin' }, { commandType: 'host.test', actorId: 'admin' });
assert.equal((await host.getCommand({ actorId: 'admin' }, command.id))?.id, command.id);
assert.equal((await host.listCommands({ actorId: 'admin' }, { actorId: 'admin', commandTypePrefix: 'host.' })).length, 1);
const execution = await host.startExecution({ actorId: 'admin' }, { commandId: command.id });
const completed = await host.completeExecution({ actorId: 'admin' }, { execution, status: 'SUCCESS', resultType: 'host.test.result', result: { ok: true } });
assert.equal(completed.execution.status, 'SUCCESS');
await host.registerCapability({ actorId: 'admin' }, { capabilityKey: 'host.test', displayName: 'Host test', description: 'Host test capability', providerKey: 'test', version: '1.0.0', metadata: {} });
assert.equal((await host.resolveCapability({ actorId: 'admin' }, { capabilityKey: 'host.test' })).providerKey, 'test');
assert.equal((await host.documentation({ actorId: 'admin' })).endpoints.length, 47);

// One version everywhere: package.json, the Core manifest and the host documentation.
const packageVersion = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;
assert.equal(SEMA_CORE_VERSION, packageVersion);
assert.equal(getCoreDocumentation().version, packageVersion);
assert.equal((await host.documentation({ actorId: 'admin' })).version, packageVersion);

// Settings updates reject unknown keys and wrong types, and a rejected update changes nothing.
const revisionBefore = (await host.getSettings({ actorId: 'admin' })).revision;
await assert.rejects(() => host.updateSettings({ actorId: 'admin' }, { foo: 1 } as never), CoreHostValidationError);
await assert.rejects(() => host.updateSettings({ actorId: 'admin' }, { documentationEnabled: 'yes' } as never), /documentationEnabled must be a boolean/);
await assert.rejects(() => host.updateSettings({ actorId: 'admin' }, 'abc' as never), /must be a JSON object/);
assert.equal((await host.getSettings({ actorId: 'admin' })).revision, revisionBefore);

console.log('SEMA Core Host tests passed.');
