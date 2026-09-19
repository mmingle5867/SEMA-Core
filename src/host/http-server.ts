import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { CoreHostSettings } from './types.js';
import type { CoreCapability, CoreExecution, CoreLifecycleStatus, JsonObject } from '../core/types.js';
import { SemaCoreHost } from './sema-core-host.js';

export interface CoreHostHttpOptions { hostname?: string; port?: number; }

function serialize(value: unknown) {
  return JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item);
}

function write(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(serialize(body));
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let byteCount = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    byteCount += buffer.length;
    if (byteCount > 256 * 1024) throw new Error('Request body exceeds 256 KiB');
    chunks.push(buffer);
  }
  const source = Buffer.concat(chunks).toString('utf8').trim();
  return source ? JSON.parse(source) : {};
}

/** Minimal dependency-free local API. A reverse proxy or richer transport may wrap this later. */
export function createCoreHostHttpServer(host: SemaCoreHost): Server {
  return createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const actorHeader = request.headers['x-sema-actor-id'];
    const actorId = typeof actorHeader === 'string' && actorHeader.trim() ? actorHeader.trim() : null;
    const context = { actorId };
    try {
      if (request.method === 'GET' && url.pathname === '/v1/core/health') return write(response, 200, await host.health(context));
      if (request.method === 'GET' && url.pathname === '/v1/core/settings') return write(response, 200, await host.getSettings(context));
      if (request.method === 'PUT' && url.pathname === '/v1/core/settings') return write(response, 200, await host.updateSettings(context, await readJson(request) as Partial<CoreHostSettings>));
      if (request.method === 'GET' && url.pathname === '/v1/core/statistics') return write(response, 200, await host.statistics(context));
      if (request.method === 'GET' && url.pathname === '/v1/core/capabilities') return write(response, 200, await host.capabilities(context));
      if (request.method === 'GET' && url.pathname === '/v1/core/documentation') return write(response, 200, await host.documentation(context));
      if (request.method === 'POST' && url.pathname === '/v1/core/identifiers/reservations') return write(response, 201, await host.reserveIdentifiers(context, await readJson(request) as { count: number; typeCode?: string; metadata?: import('../core/types.js').JsonObject }));
      if (request.method === 'POST' && url.pathname === '/v1/core/identifiers/consume') return write(response, 200, await host.consumeReservedIdentifier(context, await readJson(request) as { reservationId: string; id: string; metadata?: import('../core/types.js').JsonObject }));
      if (request.method === 'POST' && url.pathname === '/v1/core/runtime/commands') return write(response, 201, await host.createCommand(context, await readJson(request) as { commandType: string; actorId?: string | null; workspaceId?: string | null; subjectIds?: string[]; context?: JsonObject; payload?: JsonObject }));
      if (request.method === 'POST' && url.pathname === '/v1/core/runtime/executions') return write(response, 201, await host.startExecution(context, await readJson(request) as { commandId: string; providerId?: string | null; context?: JsonObject }));
      if (request.method === 'POST' && url.pathname === '/v1/core/runtime/executions/complete') return write(response, 200, await host.completeExecution(context, await readJson(request) as { execution: CoreExecution; status: Extract<CoreLifecycleStatus, 'SUCCESS' | 'FAILED' | 'CANCELLED' | 'WAITING'>; resultType?: string; subjectIds?: string[]; result?: JsonObject; error?: JsonObject }));
      if (request.method === 'POST' && url.pathname === '/v1/core/runtime/events') return write(response, 201, await host.recordEvent(context, await readJson(request) as { eventType: string; commandId?: string | null; executionId?: string | null; subjectIds?: string[]; data?: JsonObject }));
      if (request.method === 'POST' && url.pathname === '/v1/core/runtime/audits') return write(response, 201, await host.recordAudit(context, await readJson(request) as { action: string; actorId?: string | null; commandId?: string | null; executionId?: string | null; subjectIds?: string[]; evidence?: JsonObject }));
      if (request.method === 'POST' && url.pathname === '/v1/core/runtime/capabilities') return write(response, 200, await host.registerCapability(context, await readJson(request) as Omit<CoreCapability, 'id' | 'status'> & { status?: CoreCapability['status'] }));
      if (request.method === 'GET' && url.pathname === '/v1/core/runtime/capabilities') return write(response, 200, await host.discoverCapabilities(context, url.searchParams.get('query') ?? ''));
      if (request.method === 'POST' && url.pathname === '/v1/core/runtime/capabilities/authorize') return write(response, 200, await host.authorizeInvocation(context, await readJson(request) as { capabilityKey: string; actorId?: string | null; workspaceId?: string | null }));
      if (request.method === 'POST' && url.pathname === '/v1/core/runtime/capabilities/resolve') return write(response, 200, await host.resolveCapability(context, await readJson(request) as { capabilityKey: string; actorId?: string | null; workspaceId?: string | null }));
      return write(response, 404, { error: { code: 'NOT_FOUND', message: 'Core Host endpoint not found' } });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unexpected Core Host error';
      const status = /not authorized/i.test(message) ? 403 : /JSON|Request body|must be|cannot exceed/i.test(message) ? 400 : 500;
      return write(response, status, { error: { code: status === 403 ? 'FORBIDDEN' : status === 400 ? 'INVALID_REQUEST' : 'CORE_HOST_ERROR', message } });
    }
  });
}

export async function startCoreHostHttpServer(host: SemaCoreHost, options: CoreHostHttpOptions = {}) {
  const server = createCoreHostHttpServer(host);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 4310, options.hostname ?? '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  return server;
}
