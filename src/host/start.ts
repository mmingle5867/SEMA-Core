import { FoundationPolicyAuthorization, LocalCoreHostAuthorization } from './authorization.js';
import { startCoreHostHttpServer } from './http-server.js';
import { PrismaClient } from '@prisma/client';
import { PrismaSemaCoreHostStore } from './prisma-host-store.js';
import { SemaTopology } from '../topology/topology.js';
import { PrismaTopologyStore } from '../topology/prisma-topology-store.js';
import { SemaCoreHost } from './sema-core-host.js';
import { SEMA_CORE_VERSION } from '../version.js';
import { SemaCore } from '../core/sema-core.js';

const installationId = process.env.SEMA_CORE_INSTALLATION_ID;
if (!installationId) throw new Error('SEMA_CORE_INSTALLATION_ID is required');
const port = Number(process.env.SEMA_CORE_PORT ?? '4310');
if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('SEMA_CORE_PORT must be a valid port');
const adminIds = new Set((process.env.SEMA_CORE_ADMIN_IDS ?? '').split(',').map((value) => value.trim()).filter(Boolean));
const prisma = new PrismaClient();
const store = new PrismaSemaCoreHostStore(prisma);
const topology = new SemaTopology(new PrismaTopologyStore(prisma));
const core = new SemaCore(store, { installationId, maxReservationSize: 100 });
const policyUrl = process.env.SEMA_FOUNDATION_ACCESS_URL?.replace(/\/$/, '');
const policyKey = process.env.SEMA_POLICY_KEY ?? process.env.SEMA_CORE_POLICY_KEY;
const clients = JSON.parse(process.env.SEMA_APPLICATION_CLIENTS_JSON ?? process.env.SEMA_CORE_APPLICATION_CLIENTS_JSON ?? '[]') as Array<{ applicationKey: string; secret: string }>;
const authorization = policyUrl && policyKey
  ? new FoundationPolicyAuthorization(policyUrl, policyKey, clients)
  : new LocalCoreHostAuthorization(adminIds);
if (!policyUrl || !policyKey) console.warn('SEMA Core is using explicit local administrator IDs only. Configure Foundation Access policy before exposing Core beyond local transition work.');
const host = new SemaCoreHost(core, store, authorization, SEMA_CORE_VERSION, topology);

await host.initialize();
const server = await startCoreHostHttpServer(host, { hostname: process.env.SEMA_CORE_HOSTNAME ?? '127.0.0.1', port, applicationClients: clients });
console.log(`SEMA Core v${SEMA_CORE_VERSION} listening on http://${process.env.SEMA_CORE_HOSTNAME ?? '127.0.0.1'}:${port}`);
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => server.close(() => { void store.disconnect().finally(() => process.exit(0)); }));
