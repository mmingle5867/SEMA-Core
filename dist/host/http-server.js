import { createServer } from 'node:http';
function serialize(value) {
    return JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item);
}
function write(response, status, body) {
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    response.end(serialize(body));
}
async function readJson(request) {
    const chunks = [];
    let byteCount = 0;
    for await (const chunk of request) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        byteCount += buffer.length;
        if (byteCount > 256 * 1024)
            throw new Error('Request body exceeds 256 KiB');
        chunks.push(buffer);
    }
    const source = Buffer.concat(chunks).toString('utf8').trim();
    return source ? JSON.parse(source) : {};
}
/** Minimal dependency-free local API. A reverse proxy or richer transport may wrap this later. */
export function createCoreHostHttpServer(host) {
    return createServer(async (request, response) => {
        const url = new URL(request.url ?? '/', 'http://localhost');
        const actorHeader = request.headers['x-sema-actor-id'];
        const actorId = typeof actorHeader === 'string' && actorHeader.trim() ? actorHeader.trim() : null;
        const context = { actorId };
        try {
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
            return write(response, 404, { error: { code: 'NOT_FOUND', message: 'Core Host endpoint not found' } });
        }
        catch (error) {
            const message = error instanceof Error ? error.message : 'Unexpected Core Host error';
            const status = /not authorized/i.test(message) ? 403 : /JSON|Request body|must be|cannot exceed/i.test(message) ? 400 : 500;
            return write(response, status, { error: { code: status === 403 ? 'FORBIDDEN' : status === 400 ? 'INVALID_REQUEST' : 'CORE_HOST_ERROR', message } });
        }
    });
}
export async function startCoreHostHttpServer(host, options = {}) {
    const server = createCoreHostHttpServer(host);
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(options.port ?? 4310, options.hostname ?? '127.0.0.1', () => { server.off('error', reject); resolve(); });
    });
    return server;
}
//# sourceMappingURL=http-server.js.map