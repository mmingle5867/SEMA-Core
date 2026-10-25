import { FileKeyStore, type StoredKey } from './machine-key.js';
import { signRequest } from './signatures.js';

/**
 * Everything a program needs to sign its requests to Core (RFC 9421, D-123), in one place for every program: its own
 * key, kept the way Core keeps its machine key; registering that key with Core; and sending signed requests. A program
 * proves who it is with its key and secret only to register; after that it signs. When Core answers that it does not
 * know the key (Core was down when the program started, or lost the key), the program registers and retries once. A
 * revoked key stays refused: the same key cannot be registered twice.
 *
 * This file and the two it uses need nothing but Node.js, so a program on the same machine as Core can load them from
 * Core's folder without Core's database layer. Until the wrapper around every service carries this, that is how the
 * System Console and Foundation Access use it.
 */
export interface CoreClientSigning {
  keyId: string;
  /** The headers that sign one request. */
  headers(method: string, url: URL, body?: Buffer): Promise<Record<string, string>>;
  /** Registers the program's public key with Core, proving who it is with its key and secret one more time. */
  register(): Promise<void>;
  /** Sends a signed request; if Core does not know the key yet, registers it and tries once more. */
  fetch(method: string, url: URL, body?: Buffer, headers?: Record<string, string>, timeoutMs?: number): Promise<Response>;
}

/**
 * Why a request to Core could not be sent, in plain words with what to do, instead of "fetch failed". Every program that
 * talks to Core through this file gets the same words.
 */
export function whyUnreachable(name: string, url: string, error: unknown) {
  const cause = (error as { cause?: { code?: string; message?: string } })?.cause;
  const code = cause?.code ?? (error as { code?: string })?.code;
  if (code === 'ECONNREFUSED') return `${name} is not running (nothing answers at ${url}). Start the SEMA services in order from the System Console's Service Status page.`;
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return `${name}'s address ${url} could not be found. Check the address in the .env file.`;
  if ((error as { name?: string })?.name === 'TimeoutError' || code === 'UND_ERR_CONNECT_TIMEOUT') return `${name} did not answer at ${url} in time. It may be starting, or stuck: check it on the Service Status page.`;
  return `${name} could not be reached at ${url}: ${cause?.message ?? (error as Error)?.message ?? String(error)}`;
}

export async function openCoreClientSigning(input: { keyFile: string; coreUrl: string; applicationKey: string; secret: string; key?: StoredKey }): Promise<CoreClientSigning> {
  const key = input.key ?? await new FileKeyStore(input.keyFile).open();
  const coreUrl = input.coreUrl.replace(/\/$/, '');
  const headers = (method: string, url: URL, body?: Buffer) => signRequest({ method, authority: url.host, path: url.pathname, search: url.search, ...(body && body.length ? { body } : {}) }, key);
  const register = async () => {
    const proof = Buffer.from(await key.sign(Buffer.from(`sema-key-registration\n${input.applicationKey}\n${key.keyId}`, 'utf8'))).toString('base64');
    let response: Response;
    try {
      response = await fetch(`${coreUrl}/v1/core/keys/clients`, {
        method: 'POST',
        headers: { 'x-sema-application-key': input.applicationKey, 'x-sema-application-secret': input.secret, 'content-type': 'application/json' },
        body: JSON.stringify({ publicKey: key.publicJwk, proof }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (error) { throw new Error(whyUnreachable('SEMA Core', coreUrl, error), { cause: error }); }
    if (response.status === 201) return;
    const payload = await response.json().catch(() => null) as { error?: { message?: string } } | null;
    const message = payload?.error?.message ?? `Core answered ${response.status}`;
    if (/already registered/.test(message)) return;
    throw new Error(`The key of ${input.applicationKey} could not be registered with Core: ${message}`);
  };
  const send = async (method: string, url: URL, body?: Buffer, extra: Record<string, string> = {}, timeoutMs = 30_000) => {
    try { return await fetch(url, { method, headers: { ...extra, ...(await headers(method, url, body)) }, ...(body && body.length ? { body: new Uint8Array(body) } : {}), signal: AbortSignal.timeout(timeoutMs) }); }
    catch (error) { throw new Error(whyUnreachable('SEMA Core', coreUrl, error), { cause: error }); }
  };
  return {
    keyId: key.keyId,
    headers,
    register,
    async fetch(method, url, body, extra, timeoutMs) {
      const first = await send(method, url, body, extra, timeoutMs);
      if (first.status !== 401) return first;
      await register();
      return send(method, url, body, extra, timeoutMs);
    },
  };
}
