import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { CoreHostAuthorizationError, CoreHostValidationError } from './errors.js';
import type { CoreHostSettings } from './types.js';
import type { CoreCapability, CoreCommand, CoreExecution, CoreLifecycleStatus, JsonObject } from '../core/types.js';
import { SemaCoreHost } from './sema-core-host.js';

export interface CoreApplicationClient { applicationKey: string; secret: string; }
export interface CoreHostHttpOptions { hostname?: string; port?: number; applicationClients?: CoreApplicationClient[]; }

const MAX_BODY_BYTES = 256 * 1024;

/** Transport-level failure with an explicit HTTP status. */
class HttpRequestError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = 'HttpRequestError';
  }
}

function secretMatches(expected: string | undefined, presented: string) {
  if (!expected) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(presented);
  return a.length === b.length && timingSafeEqual(a, b);
}

function serialize(value: unknown) {
  return JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item);
}

function write(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  response.end(serialize(body));
}

/** Only origin-form paths are served. "//" and "//host/path" are rejected rather than reinterpreted. */
function parseRequestUrl(raw: string | undefined) {
  const target = raw ?? '/';
  if (!target.startsWith('/') || target.startsWith('//')) throw new HttpRequestError(400, 'INVALID_REQUEST', 'Malformed request URL');
  try {
    return new URL(target, 'http://localhost');
  } catch {
    throw new HttpRequestError(400, 'INVALID_REQUEST', 'Malformed request URL');
  }
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let byteCount = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    byteCount += buffer.length;
    if (byteCount > MAX_BODY_BYTES) throw new HttpRequestError(413, 'PAYLOAD_TOO_LARGE', 'Request body exceeds 256 KiB');
    chunks.push(buffer);
  }
  const source = Buffer.concat(chunks).toString('utf8').trim();
  if (!source) return {};
  try {
    return JSON.parse(source);
  } catch {
    throw new HttpRequestError(400, 'INVALID_REQUEST', 'Request body is not valid JSON');
  }
}

function classify(error: unknown): { status: number; code: string; message: string } {
  if (error instanceof HttpRequestError) return { status: error.status, code: error.code, message: error.message };
  if (error instanceof CoreHostAuthorizationError) return { status: 403, code: 'FORBIDDEN', message: error.message };
  if (error instanceof CoreHostValidationError) return { status: 400, code: 'INVALID_REQUEST', message: error.message };
  const message = error instanceof Error ? error.message : 'Unexpected Core Host error';
  // Errors raised by custom authorization or store implementations are still recognised by message.
  const status = /not authorized/i.test(message) ? 403 : /JSON|Request body|must be|cannot exceed/i.test(message) ? 400 : 500;
  return { status, code: status === 403 ? 'FORBIDDEN' : status === 400 ? 'INVALID_REQUEST' : 'CORE_HOST_ERROR', message };
}

async function handleRequest(host: SemaCoreHost, applicationClients: ReadonlyMap<string, string>, request: IncomingMessage, response: ServerResponse) {
  try {
    const url = parseRequestUrl(request.url);
    const actorHeader = request.headers['x-sema-application-key'] ?? request.headers['x-sema-actor-id'];
    const actorId = typeof actorHeader === 'string' && actorHeader.trim() ? actorHeader.trim() : null;
    // When application clients are registered, every request must prove which application is calling.
    // The secret authenticates the application; it is never recorded as a person.
    if (applicationClients.size > 0) {
      const secretHeader = request.headers['x-sema-application-secret'];
      const secret = typeof secretHeader === 'string' ? secretHeader : '';
      if (!actorId || !secretMatches(applicationClients.get(actorId), secret)) throw new HttpRequestError(401, 'UNAUTHENTICATED', 'A valid SEMA application credential is required.');
    }
    const context = { actorId };
    if (request.method === 'GET' && url.pathname === '/v1/core/health') return write(response, 200, await host.health(context));
    if (request.method === 'GET' && url.pathname === '/v1/core/settings') return write(response, 200, await host.getSettings(context));
    if (request.method === 'PUT' && url.pathname === '/v1/core/settings') return write(response, 200, await host.updateSettings(context, await readJson(request) as Partial<CoreHostSettings>));
    if (request.method === 'GET' && url.pathname === '/v1/core/statistics') return write(response, 200, await host.statistics(context));
    if (request.method === 'GET' && url.pathname === '/v1/core/capabilities') return write(response, 200, await host.capabilities(context));
    if (request.method === 'GET' && url.pathname === '/v1/core/documentation') return write(response, 200, await host.documentation(context));
    if (request.method === 'POST' && url.pathname === '/v1/core/identifiers/reservations') return write(response, 201, await host.reserveIdentifiers(context, await readJson(request) as { count: number; typeCode?: string; metadata?: import('../core/types.js').JsonObject }));
    if (request.method === 'POST' && url.pathname === '/v1/core/identifiers/consume') return write(response, 200, await host.consumeReservedIdentifier(context, await readJson(request) as { reservationId: string; id: string; metadata?: import('../core/types.js').JsonObject }));
    if (request.method === 'POST' && url.pathname === '/v1/core/runtime/commands') return write(response, 201, await host.createCommand(context, await readJson(request) as { commandType: string; actorId?: string | null; workspaceId?: string | null; subjectIds?: string[]; context?: JsonObject; payload?: JsonObject }));
    if (request.method === 'POST' && url.pathname === '/v1/core/runtime/commands/status') return write(response, 200, await host.updateCommandStatus(context, await readJson(request) as { commandId: string; status: CoreLifecycleStatus }));
    if (request.method === 'GET' && url.pathname === '/v1/core/runtime/commands') { const commandId = url.searchParams.get('id'); if (commandId) return write(response, 200, await host.getCommand(context, commandId)); const limit = url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : undefined; return write(response, 200, await host.listCommands(context, { actorId: url.searchParams.has('actorId') ? url.searchParams.get('actorId') : undefined, commandTypePrefix: url.searchParams.get('commandTypePrefix') ?? undefined, status: (url.searchParams.get('status') ?? undefined) as CoreCommand['status'] | undefined, limit })); }
    if (request.method === 'POST' && url.pathname === '/v1/core/runtime/executions') return write(response, 201, await host.startExecution(context, await readJson(request) as { commandId: string; providerId?: string | null; context?: JsonObject }));
    if (request.method === 'POST' && url.pathname === '/v1/core/runtime/executions/complete') return write(response, 200, await host.completeExecution(context, await readJson(request) as { execution: CoreExecution; status: Extract<CoreLifecycleStatus, 'SUCCESS' | 'FAILED' | 'CANCELLED' | 'WAITING'>; resultType?: string; subjectIds?: string[]; result?: JsonObject; error?: JsonObject }));
    if (request.method === 'POST' && url.pathname === '/v1/core/runtime/events') return write(response, 201, await host.recordEvent(context, await readJson(request) as { eventType: string; commandId?: string | null; executionId?: string | null; subjectIds?: string[]; data?: JsonObject }));
    if (request.method === 'POST' && url.pathname === '/v1/core/runtime/audits') return write(response, 201, await host.recordAudit(context, await readJson(request) as { action: string; actorId?: string | null; commandId?: string | null; executionId?: string | null; subjectIds?: string[]; evidence?: JsonObject }));
    if (request.method === 'POST' && url.pathname === '/v1/core/runtime/capabilities') return write(response, 200, await host.registerCapability(context, await readJson(request) as Omit<CoreCapability, 'id' | 'status'> & { status?: CoreCapability['status'] }));
    if (request.method === 'GET' && url.pathname === '/v1/core/runtime/capabilities') return write(response, 200, await host.discoverCapabilities(context, url.searchParams.get('query') ?? ''));
    if (request.method === 'POST' && url.pathname === '/v1/core/runtime/capabilities/authorize') return write(response, 200, await host.authorizeInvocation(context, await readJson(request) as { capabilityKey: string; actorId?: string | null; workspaceId?: string | null }));
    if (request.method === 'POST' && url.pathname === '/v1/core/runtime/capabilities/resolve') return write(response, 200, await host.resolveCapability(context, await readJson(request) as { capabilityKey: string; actorId?: string | null; workspaceId?: string | null }));
    if (request.method === 'GET' && url.pathname === '/v1/core/topology/nodes') return write(response, 200, await host.nodeDescribe(context, { id: url.searchParams.get('id') ?? '' }));
    if (request.method === 'POST' && url.pathname === '/v1/core/topology/nodes/accept') return write(response, 201, await host.nodeAccept(context, await readJson(request) as Parameters<typeof host.nodeAccept>[1]));
    if (request.method === 'POST' && url.pathname === '/v1/core/topology/nodes/issue-child') return write(response, 201, await host.nodeIssueChild(context, await readJson(request) as { nodeId: string }));
    if (request.method === 'POST' && url.pathname === '/v1/core/topology/nodes/issue-basis') return write(response, 201, await host.nodeIssueBasis(context, await readJson(request) as { nodeId: string }));
    if (request.method === 'POST' && url.pathname === '/v1/core/topology/nodes/set-parent') return write(response, 200, await host.nodeSetParent(context, await readJson(request) as { nodeId: string; parentId: string; parentAddress?: string }));
    if (request.method === 'POST' && url.pathname === '/v1/core/topology/nodes/set-basis') return write(response, 200, await host.nodeSetBasis(context, await readJson(request) as { nodeId: string; basis: string }));
    if (request.method === 'POST' && url.pathname === '/v1/core/topology/nodes/child-count') return write(response, 200, await host.nodeAdjustChildCount(context, await readJson(request) as { nodeId: string; delta: number }));
    if (request.method === 'POST' && url.pathname === '/v1/core/topology/nodes/retire') return write(response, 200, await host.nodeRetire(context, await readJson(request) as { nodeId: string }));
    if (request.method === 'GET' && url.pathname === '/v1/core/topology/local') return write(response, 200, await host.topologyLocal(context));
    if (request.method === 'GET' && url.pathname === '/v1/core/topology/walk-up') return write(response, 200, await host.topologyWalkUp(context, { nodeId: url.searchParams.get('nodeId') ?? '', nodeAddress: url.searchParams.get('nodeAddress') ?? undefined }));
    if (request.method === 'POST' && url.pathname === '/v1/core/topology/create') return write(response, 201, await host.topologyCreate(context, await readJson(request) as Parameters<typeof host.topologyCreate>[1]));
    if (request.method === 'POST' && url.pathname === '/v1/core/topology/insert-above') return write(response, 201, await host.topologyInsertAbove(context, await readJson(request) as Parameters<typeof host.topologyInsertAbove>[1]));
    if (request.method === 'POST' && url.pathname === '/v1/core/topology/rehome') return write(response, 200, await host.topologyRehome(context, await readJson(request) as Parameters<typeof host.topologyRehome>[1]));
    if (request.method === 'POST' && url.pathname === '/v1/core/topology/remove') return write(response, 200, await host.topologyRemove(context, await readJson(request) as Parameters<typeof host.topologyRemove>[1]));
    if (request.method === 'POST' && url.pathname === '/v1/core/topology/roll-up') return write(response, 200, await host.topologyRollUp(context, await readJson(request) as Parameters<typeof host.topologyRollUp>[1]));
    if (request.method === 'POST' && url.pathname === '/v1/core/topology/repair-parent') return write(response, 200, await host.topologyRepairParent(context, await readJson(request) as Parameters<typeof host.topologyRepairParent>[1]));
    return write(response, 404, { error: { code: 'NOT_FOUND', message: 'Core Host endpoint not found' } });
  } catch (error) {
    const { status, code, message } = classify(error);
    // An oversized upload is still arriving; close the connection instead of draining it.
    return write(response, status, { error: { code, message } }, status === 413 ? { connection: 'close' } : {});
  }
}

/** Minimal dependency-free local API. A reverse proxy or richer transport may wrap this later. */
export function createCoreHostHttpServer(host: SemaCoreHost, options: CoreHostHttpOptions = {}): Server {
  const applicationClients = new Map((options.applicationClients ?? []).filter((client) => client.applicationKey && client.secret).map((client) => [client.applicationKey, client.secret] as const));
  return createServer((request, response) => {
    handleRequest(host, applicationClients, request, response).catch(() => {
      // Last resort: nothing thrown while handling one request may take the whole process down.
      try {
        if (response.headersSent) response.end();
        else write(response, 500, { error: { code: 'CORE_HOST_ERROR', message: 'Unexpected Core Host error' } });
      } catch {
        response.destroy();
      }
    });
  });
}

export async function startCoreHostHttpServer(host: SemaCoreHost, options: CoreHostHttpOptions = {}) {
  const server = createCoreHostHttpServer(host, options);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 4310, options.hostname ?? '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  return server;
}
