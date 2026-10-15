import { FoundationPolicyAuthorization, LocalCoreHostAuthorization } from './authorization.js';
import { startCoreHostHttpServer } from './http-server.js';
import { PrismaClient } from '@prisma/client';
import { PrismaSemaCoreHostStore } from './prisma-host-store.js';
import { LocalNodes } from '../topology/local-nodes.js';
import { HttpPeerDirectory, joiningPeer } from '../topology/http-peers.js';
import { PrismaLocalNodeStore } from '../topology/prisma-local-node-store.js';
import { SemaCoreHost } from './sema-core-host.js';
import { SEMA_CORE_VERSION } from '../version.js';
import { SemaCore } from '../core/sema-core.js';
import { resolveStart, startJoinServer } from './join.js';

const port = Number(process.env.SEMA_CORE_PORT ?? '4310');
if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('SEMA_CORE_PORT must be a valid port');
const hostname = process.env.SEMA_CORE_HOSTNAME ?? '127.0.0.1';
const adminIds = new Set((process.env.SEMA_CORE_ADMIN_IDS ?? '').split(',').map((value) => value.trim()).filter(Boolean));
const prisma = new PrismaClient();
const store = new PrismaSemaCoreHostStore(prisma);
const localNodes = new LocalNodes(new PrismaLocalNodeStore(prisma));

// Which node this Core is. Its database says so once it has an identity; an ID typed into the settings never
// creates one. A Core with no identity is the first machine of a new system when SEMA_CORE_INSTALL_CODE carries
// the ID assigned to that system; otherwise it waits to be joined to a system by a node that is already in one.
let start = resolveStart({ storedId: await store.storedInstallationId(), configuredId: process.env.SEMA_CORE_INSTALLATION_ID, installCode: process.env.SEMA_CORE_INSTALL_CODE });
if (start.mode === 'join') {
  const joinCode = process.env.SEMA_CORE_JOIN_CODE;
  const waiting = await startJoinServer({ hostname, port, joinCode, version: SEMA_CORE_VERSION, record: (request) => store.joinSystem(request) });
  console.log(`SEMA Core v${SEMA_CORE_VERSION} has not joined a system yet. Waiting on http://${hostname}:${port} to be installed from a Core that has.`);
  if (!joinCode) console.warn('SEMA_CORE_JOIN_CODE is not set, so nothing can join this Core. Set it and start again.');
  const joined = await waiting.joinedAs;
  await new Promise<void>((resolve) => { waiting.server.close(() => resolve()); waiting.server.closeAllConnections(); });
  console.log(`This Core joined as node ${joined.id}, under ${joined.parentId}.`);
  start = { mode: 'run', installationId: joined.id };
}
const installationId = start.installationId;

const core = new SemaCore(store, { installationId, maxReservationSize: 100 });
const policyUrl = process.env.SEMA_FOUNDATION_ACCESS_URL?.replace(/\/$/, '');
const policyKey = process.env.SEMA_POLICY_KEY ?? process.env.SEMA_CORE_POLICY_KEY;
const clients = JSON.parse(process.env.SEMA_APPLICATION_CLIENTS_JSON ?? process.env.SEMA_CORE_APPLICATION_CLIENTS_JSON ?? '[]') as Array<{ applicationKey: string; secret: string }>;
const authorization = policyUrl && policyKey
  ? new FoundationPolicyAuthorization(policyUrl, policyKey, clients)
  : new LocalCoreHostAuthorization(adminIds);
if (!policyUrl || !policyKey) console.warn('SEMA Core is using explicit local administrator IDs only. Configure Foundation Access policy before exposing Core beyond local transition work.');
// How this Core reaches the others. SEMA_CORE_ADDRESS is the stable name other Cores use for this one;
// SEMA_CORE_PEER_APPLICATION_KEY and SEMA_CORE_PEER_SECRET are the shared credential presented to them (later: per-machine keys).
const ownAddress = process.env.SEMA_CORE_ADDRESS?.replace(/\/$/, '');
const peerKey = process.env.SEMA_CORE_PEER_APPLICATION_KEY;
const peerSecret = process.env.SEMA_CORE_PEER_SECRET;
const topology = peerKey && peerSecret
  ? { address: ownAddress, peers: new HttpPeerDirectory({ credentials: { applicationKey: peerKey, secret: peerSecret }, local: { address: ownAddress ?? '', peer: localNodes } }), joining: joiningPeer }
  : undefined;
if (!topology) console.warn('SEMA_CORE_PEER_APPLICATION_KEY / SEMA_CORE_PEER_SECRET are not set: this Core cannot hold conversations with other Cores.');
const host = new SemaCoreHost(core, store, authorization, SEMA_CORE_VERSION, localNodes, topology);

await host.initialize();
const server = await startCoreHostHttpServer(host, { hostname, port, applicationClients: clients });
console.log(`SEMA Core v${SEMA_CORE_VERSION} listening on http://${hostname}:${port}`);
// How often to look for nodes nearing their organization's length limit and fetch a ready basis. 0 turns it off.
const keyLimitCheckSeconds = Number(process.env.SEMA_CORE_KEY_LIMIT_CHECK_SECONDS ?? 300);
host.startKeyLimitChecks(Number.isFinite(keyLimitCheckSeconds) ? keyLimitCheckSeconds * 1000 : 300_000);
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => server.close(() => { void store.disconnect().finally(() => process.exit(0)); }));
