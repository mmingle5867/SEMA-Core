import { type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { SemaCoreHost } from './sema-core-host.js';
export interface CoreApplicationClient {
    applicationKey: string;
    secret: string;
}
export interface CoreHostHttpOptions {
    hostname?: string;
    port?: number;
    applicationClients?: CoreApplicationClient[];
}
/** Minimal dependency-free local API. A reverse proxy or richer transport may wrap this later. */
export declare function createCoreHostHttpServer(host: SemaCoreHost, options?: CoreHostHttpOptions): Server;
export declare function startCoreHostHttpServer(host: SemaCoreHost, options?: CoreHostHttpOptions): Promise<Server<typeof IncomingMessage, typeof ServerResponse>>;
//# sourceMappingURL=http-server.d.ts.map