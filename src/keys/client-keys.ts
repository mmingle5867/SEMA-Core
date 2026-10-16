import { PrismaClient } from '@prisma/client';
import type { JsonWebKey } from 'node:crypto';

/**
 * The public keys programs have registered with this Core: each belongs to one program (its application key). A
 * program registers its own key while it still proves itself the old way, and from then on signs its requests with it.
 * Only public halves are kept here.
 */
export interface ClientKey { keyId: string; applicationKey: string; publicJwk: JsonWebKey; createdAt: string; revokedAt?: string }

export interface ClientKeyStore {
  get(keyId: string): Promise<ClientKey | undefined>;
  list(applicationKey: string): Promise<ClientKey[]>;
  /** Adds a key. Refused when the key ID is already registered. */
  add(key: Omit<ClientKey, 'createdAt' | 'revokedAt'>): Promise<ClientKey>;
  /** Marks a key revoked; it is kept as a record. Says whether it was found and active. */
  revoke(keyId: string): Promise<boolean>;
}

export class InMemoryClientKeyStore implements ClientKeyStore {
  private readonly keys = new Map<string, ClientKey>();
  async get(keyId: string) { const key = this.keys.get(keyId); return key ? structuredClone(key) : undefined; }
  async list(applicationKey: string) { return [...this.keys.values()].filter((key) => key.applicationKey === applicationKey).map((key) => structuredClone(key)); }
  async add(key: Omit<ClientKey, 'createdAt' | 'revokedAt'>) {
    if (this.keys.has(key.keyId)) throw new Error(`Key ${key.keyId} is already registered`);
    const stored: ClientKey = { ...structuredClone(key), createdAt: new Date().toISOString() };
    this.keys.set(key.keyId, stored);
    return structuredClone(stored);
  }
  async revoke(keyId: string) {
    const key = this.keys.get(keyId);
    if (!key || key.revokedAt) return false;
    key.revokedAt = new Date().toISOString();
    return true;
  }
}

type Row = { keyId: string; applicationKey: string; publicJwk: string; createdAt: Date; revokedAt: Date | null };
const toKey = (row: Row): ClientKey => ({ keyId: row.keyId, applicationKey: row.applicationKey, publicJwk: JSON.parse(row.publicJwk) as JsonWebKey, createdAt: new Date(row.createdAt).toISOString(), ...(row.revokedAt ? { revokedAt: new Date(row.revokedAt).toISOString() } : {}) });

/** PostgreSQL store for registered program keys. Plain SQL, like the node store. */
export class PrismaClientKeyStore implements ClientKeyStore {
  constructor(private readonly prisma: PrismaClient) {}
  async get(keyId: string) {
    const rows = await this.prisma.$queryRaw<Row[]>`SELECT "keyId", "applicationKey", "publicJwk", "createdAt", "revokedAt" FROM "sema_core_client_keys" WHERE "keyId" = ${keyId}`;
    return rows[0] ? toKey(rows[0]) : undefined;
  }
  async list(applicationKey: string) {
    const rows = await this.prisma.$queryRaw<Row[]>`SELECT "keyId", "applicationKey", "publicJwk", "createdAt", "revokedAt" FROM "sema_core_client_keys" WHERE "applicationKey" = ${applicationKey} ORDER BY "createdAt"`;
    return rows.map(toKey);
  }
  async add(key: Omit<ClientKey, 'createdAt' | 'revokedAt'>) {
    const inserted = await this.prisma.$executeRaw`
      INSERT INTO "sema_core_client_keys" ("keyId", "applicationKey", "publicJwk", "createdAt")
      VALUES (${key.keyId}, ${key.applicationKey}, ${JSON.stringify(key.publicJwk)}, (NOW() AT TIME ZONE 'UTC'))
      ON CONFLICT ("keyId") DO NOTHING`;
    if (inserted !== 1) throw new Error(`Key ${key.keyId} is already registered`);
    return (await this.get(key.keyId))!;
  }
  async revoke(keyId: string) {
    return (await this.prisma.$executeRaw`UPDATE "sema_core_client_keys" SET "revokedAt" = (NOW() AT TIME ZONE 'UTC') WHERE "keyId" = ${keyId} AND "revokedAt" IS NULL`) === 1;
  }
}
