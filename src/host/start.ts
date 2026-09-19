import { LocalCoreHostAuthorization } from './authorization.js';
import { startCoreHostHttpServer } from './http-server.js';
import { PrismaSemaCoreHostStore } from './prisma-host-store.js';
import { SemaCoreHost } from './sema-core-host.js';
import { SemaCore } from '../core/sema-core.js';

const installationId = process.env.SEMA_CORE_INSTALLATION_ID;
if (!installationId) throw new Error('SEMA_CORE_INSTALLATION_ID is required');
const port = Number(process.env.SEMA_CORE_PORT ?? '4310');
if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('SEMA_CORE_PORT must be a valid port');
const adminIds = new Set((process.env.SEMA_CORE_ADMIN_IDS ?? '').split(',').map((value) => value.trim()).filter(Boolean));
const store = new PrismaSemaCoreHostStore();
const core = new SemaCore(store, { installationId, maxReservationSize: 100 });
const host = new SemaCoreHost(core, store, new LocalCoreHostAuthorization(adminIds), '0.2.2');

await host.initialize();
const server = await startCoreHostHttpServer(host, { hostname: process.env.SEMA_CORE_HOSTNAME ?? '127.0.0.1', port });
console.log(`SEMA Core v0.2.2 listening on http://${process.env.SEMA_CORE_HOSTNAME ?? '127.0.0.1'}:${port}`);
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => server.close(() => { void store.disconnect().finally(() => process.exit(0)); }));
