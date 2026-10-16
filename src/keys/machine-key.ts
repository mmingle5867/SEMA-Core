import { execFileSync } from 'node:child_process';
import { createPrivateKey, createPublicKey, generateKeyPairSync, type JsonWebKey, type KeyObject } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { keyIdOf, signP256, type RequestSigner } from './signatures.js';

/**
 * Where a private key is kept: one small interface, with one way of keeping keys for each kind of system behind it
 * (D-122). Make a key, sign with it, give its public half. Software stores first; hardware stores (TPM, Secure Enclave,
 * StrongBox) can be added later behind the same interface without changing anything that travels.
 */
export interface KeyStore {
  /** Loads the key, making a new one the first time. */
  open(): Promise<StoredKey>;
}
export interface StoredKey extends RequestSigner {
  /** The public half, as a JWK. */
  publicJwk: JsonWebKey;
}

function wrap(privateKey: KeyObject): StoredKey {
  const publicJwk = createPublicKey(privateKey).export({ format: 'jwk' }) as JsonWebKey;
  const jwk = { kty: publicJwk.kty, crv: publicJwk.crv, x: publicJwk.x, y: publicJwk.y };
  return { keyId: keyIdOf(jwk), publicJwk: jwk, sign: signP256(privateKey) };
}

/** A key held only in memory: for tests, and for a Core that must not keep a key. */
export class MemoryKeyStore implements KeyStore {
  private key: StoredKey | undefined;
  async open() { return (this.key ??= wrap(generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey)); }
}

/**
 * The software store on every system: the private key in a file. On Windows the file is encrypted by Windows for the
 * account Core runs as (DPAPI, reached through PowerShell, so no native module is needed), so a copy is useless on
 * another machine or account. Elsewhere the file is readable only by Core's own account. Someone with full control of
 * the machine can still use the key; that is what the hardware stores are for.
 */
export class FileKeyStore implements KeyStore {
  constructor(private readonly path: string, private readonly windows = process.platform === 'win32') {}

  async open() {
    if (existsSync(this.path)) return wrap(createPrivateKey(this.read()));
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    mkdirSync(dirname(this.path), { recursive: true });
    this.write(privateKey.export({ format: 'pem', type: 'pkcs8' }).toString());
    return wrap(createPrivateKey(this.read())); // read back, so a key that cannot be read again is found now
  }

  private write(pem: string) {
    if (this.windows) writeFileSync(this.path, dpapi('Protect', Buffer.from(pem, 'utf8').toString('base64')), { encoding: 'utf8' });
    else { writeFileSync(this.path, pem, { encoding: 'utf8', mode: 0o600 }); chmodSync(this.path, 0o600); }
  }
  private read() {
    const stored = readFileSync(this.path, 'utf8').trim();
    if (!this.windows) return stored;
    return Buffer.from(dpapi('Unprotect', stored), 'base64').toString('utf8');
  }
}

/** Runs Windows' own encryption for the current account. The data goes through standard input, never the command line. */
function dpapi(action: 'Protect' | 'Unprotect', base64: string) {
  const script = `Add-Type -AssemblyName System.Security; $in = [Console]::In.ReadToEnd().Trim(); $bytes = [Convert]::FromBase64String($in); $out = [Security.Cryptography.ProtectedData]::${action}($bytes, $null, 'CurrentUser'); [Console]::Out.Write([Convert]::ToBase64String($out))`;
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { input: base64, encoding: 'utf8', windowsHide: true, maxBuffer: 1024 * 1024 }).trim();
}
