import { createHash, createPublicKey, randomBytes, sign as signData, verify as verifyData, type JsonWebKey, type KeyObject } from 'node:crypto';

/**
 * Signed requests: HTTP Message Signatures (RFC 9421), with ECDSA over P-256 and SHA-256 (D-121, D-123).
 *
 * A SEMA request signs its method, authority, path and query, and a SHA-256 digest of its body when it has one
 * (Content-Digest, RFC 9530). The signature carries when it was created, a one-time value (nonce), the key's ID and the
 * algorithm. A request older than the window, or whose nonce was already seen within it, is refused.
 */
export const SIGNATURE_ALGORITHM = 'ecdsa-p256-sha256';
export const SIGNATURE_LABEL = 'sema';
/** The parts of every SEMA request that are signed, in this order, plus content-digest when there is a body. */
export const REQUEST_COMPONENTS = ['@method', '@authority', '@path', '@query'] as const;

export interface SignatureParams { created: number; keyid: string; nonce?: string; alg?: string; expires?: number }

/** One signing key: its ID and the signing itself. The private key never leaves whatever implements this. */
export interface RequestSigner { keyId: string; sign(data: Buffer): Buffer | Promise<Buffer> }

const quote = (value: string) => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/** The serialized signature parameters: the covered components as an inner list, then the parameters, as RFC 9421 §2.3 writes them. */
export function serializeParams(components: readonly string[], params: SignatureParams) {
  const parts = [`(${components.map(quote).join(' ')})`, `;created=${params.created}`];
  if (params.expires !== undefined) parts.push(`;expires=${params.expires}`);
  parts.push(`;keyid=${quote(params.keyid)}`);
  if (params.nonce !== undefined) parts.push(`;nonce=${quote(params.nonce)}`);
  if (params.alg !== undefined) parts.push(`;alg=${quote(params.alg)}`);
  return parts.join('');
}

/** The signature base (RFC 9421 §2.5): one line per covered component, then the signature parameters, joined by newlines. */
export function signatureBase(components: readonly string[], valueOf: (component: string) => string, serializedParams: string) {
  const lines = components.map((component) => {
    const value = valueOf(component);
    if (/[\r\n]/.test(value)) throw new Error(`The value of ${component} cannot contain a line break`);
    return `${quote(component)}: ${value}`;
  });
  lines.push(`"@signature-params": ${serializedParams}`);
  return lines.join('\n');
}

/** A request as both sides see it. Header names are lower case; the body is the exact bytes sent. */
export interface SignableRequest {
  method: string;
  /** The Host the request was sent to, e.g. 127.0.0.1:4310. */
  authority: string;
  path: string;
  /** The query string with its leading "?", or empty. */
  search: string;
  headers: Record<string, string | string[] | undefined>;
  body?: Buffer;
}

const headerValue = (headers: SignableRequest['headers'], name: string) => {
  const value = headers[name];
  if (value === undefined) return undefined;
  return (Array.isArray(value) ? value : [value]).map((item) => item.trim()).join(', ');
};

/** The value of one covered component of a request, as RFC 9421 §2.2 derives it. */
export function componentValue(request: SignableRequest, component: string) {
  switch (component) {
    case '@method': return request.method.toUpperCase();
    case '@authority': return request.authority.toLowerCase();
    case '@path': return request.path || '/';
    case '@query': return request.search && request.search !== '?' ? request.search : '?';
    default: {
      if (component.startsWith('@')) throw new Error(`The component ${component} is not supported`);
      const value = headerValue(request.headers, component);
      if (value === undefined) throw new Error(`The signed header ${component} is missing`);
      return value;
    }
  }
}

/** The Content-Digest header for a body (RFC 9530), with SHA-256. */
export const contentDigest = (body: Buffer) => `sha-256=:${createHash('sha256').update(body).digest('base64')}:`;

/** Signs a request: returns the headers to add (Content-Digest when there is a body, Signature-Input and Signature). */
export async function signRequest(request: Omit<SignableRequest, 'headers'> & { headers?: SignableRequest['headers'] }, signer: RequestSigner, now = Date.now()) {
  const added: Record<string, string> = {};
  const body = request.body && request.body.length ? request.body : undefined;
  if (body) added['content-digest'] = contentDigest(body);
  const components = [...REQUEST_COMPONENTS, ...(body ? ['content-digest'] : [])];
  const params: SignatureParams = { created: Math.floor(now / 1000), keyid: signer.keyId, nonce: randomBytes(16).toString('base64url'), alg: SIGNATURE_ALGORITHM };
  const serialized = serializeParams(components, params);
  const full: SignableRequest = { ...request, headers: { ...(request.headers ?? {}), ...added } };
  const base = signatureBase(components, (component) => componentValue(full, component), serialized);
  const signature = await signer.sign(Buffer.from(base, 'utf8'));
  added['signature-input'] = `${SIGNATURE_LABEL}=${serialized}`;
  added['signature'] = `${SIGNATURE_LABEL}=:${Buffer.from(signature).toString('base64')}:`;
  return added;
}

/** Signs with a P-256 private key, giving the 64-byte r||s signature RFC 9421 uses for ecdsa-p256-sha256. */
export const signP256 = (privateKey: KeyObject) => (data: Buffer) => signData('sha256', data, { key: privateKey, dsaEncoding: 'ieee-p1363' });
export const verifyP256 = (publicKey: KeyObject, data: Buffer, signature: Buffer) => signature.length === 64 && verifyData('sha256', data, { key: publicKey, dsaEncoding: 'ieee-p1363' }, signature);

/** The key ID of a P-256 public key: its JWK thumbprint (RFC 7638), base64url. */
export function keyIdOf(jwk: JsonWebKey) {
  if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || typeof jwk.x !== 'string' || typeof jwk.y !== 'string') throw new Error('A key must be a P-256 public key in JWK form');
  return createHash('sha256').update(JSON.stringify({ crv: 'P-256', kty: 'EC', x: jwk.x, y: jwk.y })).digest('base64url');
}
/** A public key from its JWK form, refusing anything that is not a P-256 public key. */
export function publicKeyFromJwk(jwk: JsonWebKey) {
  keyIdOf(jwk);
  if ('d' in jwk && jwk.d) throw new Error('Send only the public half of a key, never the private one');
  return createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y }, format: 'jwk' });
}

// ---- Reading Signature-Input and Signature (the parts of RFC 8941 structured fields SEMA uses) ----

interface ParsedInput { components: string[]; params: SignatureParams; serialized: string }

function parseString(source: string, at: number): [string, number] {
  if (source[at] !== '"') throw new Error('A quoted string was expected');
  let value = '', i = at + 1;
  for (; i < source.length; i += 1) {
    const char = source[i];
    if (char === '\\') { value += source[i + 1] ?? ''; i += 1; continue; }
    if (char === '"') return [value, i + 1];
    value += char;
  }
  throw new Error('A quoted string was not closed');
}

/** Reads one dictionary member of Signature-Input: label=("a" "b");created=1;keyid="x". */
export function parseSignatureInput(header: string, label: string): ParsedInput | undefined {
  for (const member of splitTopLevel(header)) {
    const eq = member.indexOf('=');
    if (eq < 0 || member.slice(0, eq).trim() !== label) continue;
    const value = member.slice(eq + 1).trim();
    if (!value.startsWith('(')) throw new Error('Signature-Input must hold a list of components');
    const components: string[] = [];
    let i = 1;
    while (i < value.length && value[i] !== ')') {
      if (value[i] === ' ') { i += 1; continue; }
      const [component, next] = parseString(value, i);
      components.push(component);
      i = next;
    }
    if (value[i] !== ')') throw new Error('Signature-Input component list was not closed');
    i += 1;
    const params: Partial<SignatureParams> & Record<string, unknown> = {};
    while (i < value.length) {
      if (value[i] !== ';') throw new Error('Malformed Signature-Input parameters');
      i += 1;
      const nameEnd = value.slice(i).search(/[=;]|$/);
      const name = value.slice(i, i + nameEnd);
      i += nameEnd;
      if (value[i] !== '=') throw new Error(`Signature-Input parameter ${name} has no value`);
      i += 1;
      if (value[i] === '"') { const [text, next] = parseString(value, i); params[name] = text; i = next; }
      else { const end = value.slice(i).search(/;|$/); const raw = value.slice(i, i + end); if (!/^-?\d{1,15}$/.test(raw)) throw new Error(`Signature-Input parameter ${name} must be a whole number`); params[name] = Number(raw); i += end; }
    }
    if (typeof params.created !== 'number' || typeof params.keyid !== 'string') throw new Error('Signature-Input must give created and keyid');
    return { components, params: params as SignatureParams, serialized: value };
  }
  return undefined;
}

/** Reads one dictionary member of Signature: label=:base64:. */
export function parseSignature(header: string, label: string): Buffer | undefined {
  for (const member of splitTopLevel(header)) {
    const eq = member.indexOf('=');
    if (eq < 0 || member.slice(0, eq).trim() !== label) continue;
    const match = /^:([A-Za-z0-9+/=]+):$/.exec(member.slice(eq + 1).trim());
    if (!match) throw new Error('Signature must be a byte sequence');
    return Buffer.from(match[1], 'base64');
  }
  return undefined;
}

/** Splits a dictionary at its top-level commas, leaving commas inside quotes and parentheses alone. */
function splitTopLevel(header: string) {
  const members: string[] = [];
  let depth = 0, inString = false, start = 0;
  for (let i = 0; i < header.length; i += 1) {
    const char = header[i];
    if (inString) { if (char === '\\') i += 1; else if (char === '"') inString = false; continue; }
    if (char === '"') inString = true;
    else if (char === '(') depth += 1;
    else if (char === ')') depth -= 1;
    else if (char === ',' && depth === 0) { members.push(header.slice(start, i).trim()); start = i + 1; }
  }
  members.push(header.slice(start).trim());
  return members.filter(Boolean);
}

// ---- Checking a signed request ----

export interface VerifyOptions {
  /** The registered public key for a key ID, or undefined when it is unknown or revoked. */
  publicKey(keyId: string): Promise<KeyObject | undefined>;
  /** Seconds a signature stays acceptable after it was created. */
  windowSeconds?: number;
  now?: number;
  nonces: NonceMemory;
}

/** Remembers the nonces seen within the window, so a copied request is refused the second time. Memory only. */
export class NonceMemory {
  private readonly seen = new Map<string, number>();
  /** Records a nonce; false if it was already seen and has not expired. */
  remember(key: string, expiresAt: number, now: number) {
    if (this.seen.size > 10_000) for (const [entry, at] of this.seen) if (at <= now) this.seen.delete(entry);
    const at = this.seen.get(key);
    if (at !== undefined && at > now) return false;
    this.seen.set(key, expiresAt);
    return true;
  }
}

/** Checks a signed request. Returns the key ID that signed it; throws, saying why, when anything is wrong. */
export async function verifyRequest(request: SignableRequest, options: VerifyOptions) {
  const inputHeader = headerValue(request.headers, 'signature-input'), signatureHeader = headerValue(request.headers, 'signature');
  if (!inputHeader || !signatureHeader) throw new Error('The request is not signed');
  const input = parseSignatureInput(inputHeader, SIGNATURE_LABEL);
  const signature = parseSignature(signatureHeader, SIGNATURE_LABEL);
  if (!input || !signature) throw new Error(`The request has no signature labelled ${SIGNATURE_LABEL}`);
  const body = request.body && request.body.length ? request.body : undefined;
  const required = [...REQUEST_COMPONENTS, ...(body ? ['content-digest'] : [])];
  for (const component of required) if (!input.components.includes(component)) throw new Error(`The signature must cover ${component}`);
  if (input.params.alg !== undefined && input.params.alg !== SIGNATURE_ALGORITHM) throw new Error(`The signature algorithm must be ${SIGNATURE_ALGORITHM}`);
  if (!input.params.nonce) throw new Error('The signature must carry a nonce');
  const now = options.now ?? Date.now(), window = options.windowSeconds ?? 60, nowSeconds = Math.floor(now / 1000);
  if (input.params.created > nowSeconds + 5) throw new Error('The signature was created in the future');
  if (nowSeconds - input.params.created > window) throw new Error(`The signature is older than ${window} seconds`);
  if (input.params.expires !== undefined && input.params.expires < nowSeconds) throw new Error('The signature has expired');
  if (body && headerValue(request.headers, 'content-digest') !== contentDigest(body)) throw new Error('The body does not match its Content-Digest');
  const publicKey = await options.publicKey(input.params.keyid);
  if (!publicKey) throw new Error('The key that signed the request is not registered on this Core, or was revoked');
  const base = signatureBase(input.components, (component) => componentValue(request, component), input.serialized);
  if (!verifyP256(publicKey, Buffer.from(base, 'utf8'), signature)) throw new Error('The signature does not match the request');
  if (!options.nonces.remember(`${input.params.keyid} ${input.params.nonce}`, (input.params.created + window + 5) * 1000, now)) throw new Error('This request was already received: a copied request is refused');
  return { keyId: input.params.keyid, created: input.params.created };
}
