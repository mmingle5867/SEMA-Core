import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { encodeBase56 } from '../identity/base56.js';
import type { NodeDescription } from '../topology/local-nodes.js';
import { parseInstallCode } from './install-code.js';

/** The first node of the original system: the only ID that was ever typed by hand. Its Core assigns the first ID of every other system. */
export const FIRST_NODE_ID = encodeBase56(BigInt(1));

/** What a new Core is told when it joins: its own node ID and the parent that issued it. */
export interface JoinRequest { id: string; parentId: string; parentAddress?: string }

/**
 * Decides how a Core starts. A Core that already has an identity in its database runs as that node, and
 * nothing in its settings can change it. A Core with none is either the first machine of a new system,
 * which needs an install code carrying the ID assigned to that system, or it waits to be joined to a
 * system by a node that is already in one. An ID typed into the settings never creates an identity.
 */
export function resolveStart(input: { storedId?: string; configuredId?: string; installCode?: string }): { mode: 'run'; installationId: string } | { mode: 'join' } {
  if (input.storedId) {
    if (input.configuredId && input.configuredId !== input.storedId) throw new Error(`SEMA_CORE_INSTALLATION_ID is ${input.configuredId}, but this Core is node ${input.storedId}. A Core's identity cannot be changed by its settings`);
    return { mode: 'run', installationId: input.storedId };
  }
  if (input.installCode) {
    const assigned = parseInstallCode(input.installCode);
    if (input.configuredId && input.configuredId !== assigned) throw new Error(`SEMA_CORE_INSTALLATION_ID is ${input.configuredId}, but the install code assigns ${assigned}. Remove SEMA_CORE_INSTALLATION_ID`);
    return { mode: 'run', installationId: assigned };
  }
  return { mode: 'join' };
}

const sameSecret = (expected: string, presented: unknown) => { if (typeof presented !== 'string') return false; const a = Buffer.from(expected), b = Buffer.from(presented); return a.length === b.length && timingSafeEqual(a, b); };
async function readBody(request: IncomingMessage) { const parts: Buffer[] = []; let size = 0; for await (const part of request) { const buffer = Buffer.from(part); size += buffer.length; if (size > 16 * 1024) throw new Error('Request body is too large'); parts.push(buffer); } return JSON.parse(Buffer.concat(parts).toString('utf8') || '{}') as Record<string, unknown>; }
const text = (value: unknown, name: string) => { if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} must be a non-empty string`); return value.trim(); };

/**
 * What a Core serves before it has an identity: its health, and one request that gives it one.
 * The join code is a value set on this machine before its first start and entered once by the person
 * installing it, so only someone who set this machine up can join it. Without a code nothing can join.
 * The promise resolves once, with the server and the identity that was recorded; the caller then closes
 * this server and starts the Core proper.
 */
export function startJoinServer(options: { hostname?: string; port: number; joinCode?: string; version: string; record: (request: JoinRequest) => Promise<NodeDescription> }) {
  let joined = false;
  let done!: (value: JoinRequest) => void;
  const joinedAs = new Promise<JoinRequest>((resolve) => { done = resolve; });
  const server: Server = createServer(async (request, response) => {
    const send = (status: number, body: unknown) => { response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); response.end(JSON.stringify(body)); };
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (request.method === 'GET' && url.pathname === '/v1/core/health') return send(200, { status: 'NOT_JOINED', version: options.version });
    if (request.method !== 'POST' || url.pathname !== '/v1/core/join') return send(503, { error: { code: 'NOT_JOINED', message: 'This Core has not joined a system yet.' } });
    try {
      if (joined) return send(409, { error: { code: 'ALREADY_JOINED', message: 'This Core has already joined a system.' } });
      if (!options.joinCode) return send(503, { error: { code: 'NO_JOIN_CODE', message: 'This Core has no join code. Set SEMA_CORE_JOIN_CODE on this machine and start it again.' } });
      const body = await readBody(request);
      if (!sameSecret(options.joinCode, body.joinCode)) return send(403, { error: { code: 'FORBIDDEN', message: 'The join code is not correct.' } });
      const id = text(body.id, 'id'), parentId = text(body.parentId, 'parentId');
      if (id.split('-').some((part) => !part)) throw new Error('A node ID must be hyphen-separated non-empty segments');
      if (id === parentId) throw new Error('A node cannot be its own parent');
      const join: JoinRequest = { id, parentId, ...(body.parentAddress === undefined || body.parentAddress === null ? {} : { parentAddress: text(body.parentAddress, 'parentAddress').replace(/\/$/, '') }) };
      joined = true; // set before the write, so a second request arriving meanwhile is refused
      let node: NodeDescription;
      try { node = await options.record(join); } catch (error) { joined = false; throw error; }
      send(201, node);
      done(join);
    } catch (error) { send(400, { error: { code: 'INVALID_REQUEST', message: error instanceof Error ? error.message : 'The request could not be completed.' } }); }
  });
  return new Promise<{ server: Server; joinedAs: Promise<JoinRequest> }>((resolve, reject) => { server.once('error', reject); server.listen(options.port, options.hostname ?? '127.0.0.1', () => { server.off('error', reject); resolve({ server, joinedAs }); }); });
}
