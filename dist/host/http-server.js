import { timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { CoreHostAuthorizationError, CoreHostValidationError } from './errors.js';
const MAX_BODY_BYTES = 256 * 1024;
/** Transport-level failure with an explicit HTTP status. */
class HttpRequestError extends Error {
    status;
    code;
    constructor(status, code, message) {
        super(message);
        this.status = status;
        this.code = code;
        this.name = 'HttpRequestError';
    }
}
function secretMatches(expected, presented) {
    if (!expected)
        return false;
    const a = Buffer.from(expected);
    const b = Buffer.from(presented);
    return a.length === b.length && timingSafeEqual(a, b);
}
function serialize(value) {
    return JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item);
}
function write(response, status, body, headers = {}) {
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
    response.end(serialize(body));
}
/** Only origin-form paths are served. "//" and "//host/path" are rejected rather than reinterpreted. */
function parseRequestUrl(raw) {
    const target = raw ?? '/';
    if (!target.startsWith('/') || target.startsWith('//'))
        throw new HttpRequestError(400, 'INVALID_REQUEST', 'Malformed request URL');
    try {
        return new URL(target, 'http://localhost');
    }
    catch {
        throw new HttpRequestError(400, 'INVALID_REQUEST', 'Malformed request URL');
    }
}
async function readJson(request) {
    const chunks = [];
    let byteCount = 0;
    for await (const chunk of request) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        byteCount += buffer.length;
        if (byteCount > MAX_BODY_BYTES)
            throw new HttpRequestError(413, 'PAYLOAD_TOO_LARGE', 'Request body exceeds 256 KiB');
        chunks.push(buffer);
    }
    const source = Buffer.concat(chunks).toString('utf8').trim();
    if (!source)
        return {};
    try {
        return JSON.parse(source);
    }
    catch {
        throw new HttpRequestError(400, 'INVALID_REQUEST', 'Request body is not valid JSON');
    }
}
function classify(error) {
    if (error instanceof HttpRequestError)
        return { status: error.status, code: error.code, message: error.message };
    if (error instanceof CoreHostAuthorizationError)
        return { status: 403, code: 'FORBIDDEN', message: error.message };
    if (error instanceof CoreHostValidationError)
        return { status: 400, code: 'INVALID_REQUEST', message: error.message };
    const message = error instanceof Error ? error.message : 'Unexpected Core Host error';
    // Errors raised by custom authorization or store implementations are still recognised by message.
    const status = /not authorized/i.test(message) ? 403 : /JSON|Request body|must be|cannot exceed/i.test(message) ? 400 : 500;
    return { status, code: status === 403 ? 'FORBIDDEN' : status === 400 ? 'INVALID_REQUEST' : 'CORE_HOST_ERROR', message };
}
async function handleRequest(host, applicationClients, request, response) {
    try {
        const url = parseRequestUrl(request.url);
        const actorHeader = request.headers['x-sema-application-key'] ?? request.headers['x-sema-actor-id'];
        const actorId = typeof actorHeader === 'string' && actorHeader.trim() ? actorHeader.trim() : null;
        // When application clients are registered, every request must prove which application is calling.
        // The secret authenticates the application; it is never recorded as a person.
        if (applicationClients.size > 0) {
            const secretHeader = request.headers['x-sema-application-secret'];
            const secret = typeof secretHeader === 'string' ? secretHeader : '';
            if (!actorId || !secretMatches(applicationClients.get(actorId), secret))
                throw new HttpRequestError(401, 'UNAUTHENTICATED', 'A valid SEMA application credential is required.');
        }
        const context = { actorId };
        if (request.method === 'GET' && url.pathname === '/v1/core/health')
            return write(response, 200, await host.health(context));
        if (request.method === 'GET' && url.pathname === '/v1/core/settings')
            return write(response, 200, await host.getSettings(context));
        if (request.method === 'PUT' && url.pathname === '/v1/core/settings')
            return write(response, 200, await host.updateSettings(context, await readJson(request)));
        if (request.method === 'GET' && url.pathname === '/v1/core/statistics')
            return write(response, 200, await host.statistics(context));
        if (request.method === 'GET' && url.pathname === '/v1/core/capabilities')
            return write(response, 200, await host.capabilities(context));
        if (request.method === 'GET' && url.pathname === '/v1/core/documentation')
            return write(response, 200, await host.documentation(context));
        if (request.method === 'POST' && url.pathname === '/v1/core/identifiers/reservations')
            return write(response, 201, await host.reserveIdentifiers(context, await readJson(request)));
        if (request.method === 'POST' && url.pathname === '/v1/core/identifiers/consume')
            return write(response, 200, await host.consumeReservedIdentifier(context, await readJson(request)));
        if (request.method === 'POST' && url.pathname === '/v1/core/runtime/commands')
            return write(response, 201, await host.createCommand(context, await readJson(request)));
        if (request.method === 'POST' && url.pathname === '/v1/core/runtime/commands/status')
            return write(response, 200, await host.updateCommandStatus(context, await readJson(request)));
        if (request.method === 'GET' && url.pathname === '/v1/core/runtime/commands') {
            const commandId = url.searchParams.get('id');
            if (commandId)
                return write(response, 200, await host.getCommand(context, commandId));
            const limit = url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : undefined;
            return write(response, 200, await host.listCommands(context, { actorId: url.searchParams.has('actorId') ? url.searchParams.get('actorId') : undefined, commandTypePrefix: url.searchParams.get('commandTypePrefix') ?? undefined, status: (url.searchParams.get('status') ?? undefined), limit }));
        }
        if (request.method === 'POST' && url.pathname === '/v1/core/runtime/executions')
            return write(response, 201, await host.startExecution(context, await readJson(request)));
        if (request.method === 'POST' && url.pathname === '/v1/core/runtime/executions/complete')
            return write(response, 200, await host.completeExecution(context, await readJson(request)));
        if (request.method === 'POST' && url.pathname === '/v1/core/runtime/events')
            return write(response, 201, await host.recordEvent(context, await readJson(request)));
        if (request.method === 'POST' && url.pathname === '/v1/core/runtime/audits')
            return write(response, 201, await host.recordAudit(context, await readJson(request)));
        if (request.method === 'POST' && url.pathname === '/v1/core/runtime/capabilities')
            return write(response, 200, await host.registerCapability(context, await readJson(request)));
        if (request.method === 'GET' && url.pathname === '/v1/core/runtime/capabilities')
            return write(response, 200, await host.discoverCapabilities(context, url.searchParams.get('query') ?? ''));
        if (request.method === 'POST' && url.pathname === '/v1/core/runtime/capabilities/authorize')
            return write(response, 200, await host.authorizeInvocation(context, await readJson(request)));
        if (request.method === 'POST' && url.pathname === '/v1/core/runtime/capabilities/resolve')
            return write(response, 200, await host.resolveCapability(context, await readJson(request)));
        return write(response, 404, { error: { code: 'NOT_FOUND', message: 'Core Host endpoint not found' } });
    }
    catch (error) {
        const { status, code, message } = classify(error);
        // An oversized upload is still arriving; close the connection instead of draining it.
        return write(response, status, { error: { code, message } }, status === 413 ? { connection: 'close' } : {});
    }
}
/** Minimal dependency-free local API. A reverse proxy or richer transport may wrap this later. */
export function createCoreHostHttpServer(host, options = {}) {
    const applicationClients = new Map((options.applicationClients ?? []).filter((client) => client.applicationKey && client.secret).map((client) => [client.applicationKey, client.secret]));
    return createServer((request, response) => {
        handleRequest(host, applicationClients, request, response).catch(() => {
            // Last resort: nothing thrown while handling one request may take the whole process down.
            try {
                if (response.headersSent)
                    response.end();
                else
                    write(response, 500, { error: { code: 'CORE_HOST_ERROR', message: 'Unexpected Core Host error' } });
            }
            catch {
                response.destroy();
            }
        });
    });
}
export async function startCoreHostHttpServer(host, options = {}) {
    const server = createCoreHostHttpServer(host, options);
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(options.port ?? 4310, options.hostname ?? '127.0.0.1', () => { server.off('error', reject); resolve(); });
    });
    return server;
}
//# sourceMappingURL=http-server.js.map