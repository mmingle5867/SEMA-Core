import assert from 'node:assert/strict';
import { InMemorySemaCoreHostStore, LocalCoreHostAuthorization, SemaCore, SemaCoreHost } from '../src/index.js';

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
assert.equal((await host.documentation({ actorId: 'admin' })).endpoints.length, 6);
console.log('SEMA Core Host tests passed.');
