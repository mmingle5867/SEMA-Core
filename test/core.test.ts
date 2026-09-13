import assert from 'node:assert/strict';

import {
  InMemorySemaCoreStore, SemaCore, decodeBase56, encodeBase56, formatKeyId, parseKeyId,
} from '../src/index.js';

const store = new InMemorySemaCoreStore();
const core = new SemaCore(store, { installationId: '3', maxReservationSize: 10 });

await core.initialize();

assert.equal(encodeBase56(BigInt(1)), '3');
assert.equal(decodeBase56('3'), BigInt(1));
assert.equal(formatKeyId({ installationId: '3-A', localValue: BigInt(3) }), '3-A-5');
assert.deepEqual(parseKeyId('3-A-5'), { installationId: '3-A', localId: '5', localValue: BigInt(3) });

const reservation = await core.reserveIdentifiers(3, 'ART', { purpose: 'test' });
assert.deepEqual(reservation.identifiers.map((identifier) => identifier.id), ['3-3', '3-4', '3-5']);
assert.equal(reservation.identifiers[0]!.status, 'RESERVED');
const used = await core.consumeReservedIdentifier(reservation.identifiers[0]!.id, reservation.reservation.id, { object: 'artwork' });
assert.equal(used.status, 'ISSUED');
await assert.rejects(() => core.consumeReservedIdentifier(used.id, reservation.reservation.id), /already been consumed/);
await assert.rejects(() => core.reserveIdentifiers(11, 'ART'), /between 1 and 10/);

const childInstallation = await core.issueChildInstallation({ purpose: 'child-core' });
assert.equal(childInstallation.id, '3-6');
const childCore = new SemaCore(new InMemorySemaCoreStore(), { installationId: childInstallation.id, maxReservationSize: 5 });
await childCore.initialize();
assert.equal((await childCore.issueIdentifier('ITEM')).id, '3-6-3');

const command = await core.createCommand({ commandType: 'test.command', actorId: '3-3', subjectIds: ['3-3'] });
const execution = await core.startExecution({ commandId: command.id, providerId: 'local.test' });
const completed = await core.completeExecution({ execution, status: 'SUCCESS', resultType: 'test.result', result: { ok: true } });
assert.equal(completed.execution.status, 'SUCCESS');
assert.equal(completed.result?.resultType, 'test.result');
assert.equal(store.events.at(-1)?.eventType, 'execution.success');

await core.registerCapability({ capabilityKey: 'graphics.vector-trace', displayName: 'Vector Trace', description: 'Test capability', providerKey: 'local.vtracer', version: '1.0.0', metadata: {} });
assert.equal((await core.resolveCapability({ capabilityKey: 'graphics.vector-trace' })).providerKey, 'local.vtracer');
assert.equal((await core.authorizeInvocation({ capabilityKey: 'missing.capability' })).allowed, false);

console.log('SEMA Core tests passed.');
