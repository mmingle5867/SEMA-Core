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
import { recordStops } from './stop-log.js';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { FileKeyStore } from '../keys/machine-key.js';
import { PrismaClientKeyStore } from '../keys/client-keys.js';
import { NonceMemory } from '../keys/signatures.js';
import { CapabilityRegistry } from '../capabilities/registry.js';
import { PrismaCapabilityStore } from '../capabilities/prisma-capability-store.js';
import { CapabilityWork } from '../capabilities/work.js';
import { PrismaWorkStore } from '../capabilities/prisma-work-store.js';

const sayWhyStopping = recordStops(join(process.cwd(), 'logs', 'stops.log'), SEMA_CORE_VERSION);
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
// This machine's own key (D-121, D-122): made on the first start, kept in a file encrypted by Windows for this account,
// or readable only by this account elsewhere. SEMA_CORE_KEY_FILE says where; it must never be committed or copied.
const keyFile = process.env.SEMA_CORE_KEY_FILE ?? join(process.cwd(), 'keys', process.platform === 'win32' ? 'machine-key.dpapi' : 'machine-key.pem');
const machineKey = await new FileKeyStore(keyFile).open();
console.log(`Machine key ${machineKey.keyId}`);
// The capability and service records (D-151). Every ID comes from this Core's own counter; installations are on this machine.
const issue = async (typeCode: string, metadata: import('../core/types.js').JsonObject) => (await core.issueIdentifier(typeCode, metadata)).id;
const capabilityStore = new PrismaCapabilityStore(prisma);
const capabilityRecords = new CapabilityRegistry(capabilityStore, issue, async () => installationId);
// Commands to a capability, their executions and results (phase 2).
const capabilityWork = new CapabilityWork(core, capabilityStore, new PrismaWorkStore(prisma), issue);
const host = new SemaCoreHost(core, store, authorization, SEMA_CORE_VERSION, localNodes, topology, { machine: machineKey, clients: new PrismaClientKeyStore(prisma), nonces: new NonceMemory() }, capabilityRecords, capabilityWork);

await host.initialize();
const server = await startCoreHostHttpServer(host, { hostname, port, applicationClients: clients });
console.log(`SEMA Core v${SEMA_CORE_VERSION} listening on http://${hostname}:${port}`);
// How often to look for nodes nearing their organization's length limit and fetch a ready basis. 0 turns it off.
const keyLimitCheckSeconds = Number(process.env.SEMA_CORE_KEY_LIMIT_CHECK_SECONDS ?? 300);
host.startKeyLimitChecks(Number.isFinite(keyLimitCheckSeconds) ? keyLimitCheckSeconds * 1000 : 300_000);
// How often each node held here checks in with its own parent, set by this Core's administrator. 0 turns it off.
const checkInSeconds = Number(process.env.SEMA_CORE_CHECK_IN_SECONDS ?? 300);
host.startCheckIns(Number.isFinite(checkInSeconds) ? checkInSeconds * 1000 : 300_000);
// A service's running copy that has not checked in for this many minutes is marked lost (it was ended without saying
// so). Checked every minute. 0 turns it off.
const lostMinutes = Number(process.env.SEMA_CORE_INSTANCE_LOST_MINUTES ?? 10);
// A job whose service has not said it is still working for this many seconds is marked failed (D-180). 0 turns it off.
const silentSeconds = Number(process.env.SEMA_CORE_EXECUTION_SILENT_SECONDS ?? 90);
host.startInstanceSweep(15_000, Number.isFinite(lostMinutes) ? lostMinutes * 60_000 : 600_000, Number.isFinite(silentSeconds) && silentSeconds > 0 ? silentSeconds * 1000 : Number.MAX_SAFE_INTEGER);
// Stopping: on Ctrl+C or Ctrl+Break, when its console closes, or when the Console's stop script writes a file named
// .sema-stop into this folder (a background process on Windows cannot be sent Ctrl+C). Core then ends on its own rather
// than through process.exit(): on Windows, Node can crash when made to exit right after requests. The timer only
// fires if something is still holding the process open.
let stopping = false;
const shutdown = (why: string) => {
  if (stopping) return;
  stopping = true;
  sayWhyStopping(why);
  server.close(() => { void store.disconnect().finally(() => setTimeout(() => process.exit(0), 5000).unref()); });
};
for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP'] as const) process.on(signal, () => shutdown(`received ${signal}`));
const stopRequest = join(process.cwd(), '.sema-stop');
setInterval(() => { if (existsSync(stopRequest)) { rmSync(stopRequest, { force: true }); shutdown('stop requested by the System Console'); } }, 1000).unref();
