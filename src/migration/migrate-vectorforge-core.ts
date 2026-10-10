import { PrismaClient } from '@prisma/client';

const sourceUrl = process.env.SEMA_CORE_SOURCE_DATABASE_URL;
if (!sourceUrl) throw new Error('SEMA_CORE_SOURCE_DATABASE_URL is required');
const source = new PrismaClient({ datasources: { db: { url: sourceUrl } } });
const target = new PrismaClient();
const tables = ['semaCoreIdentityState', 'semaIdentifierReservation', 'semaIssuedIdentifier', 'semaCoreCommand', 'semaCoreExecution', 'semaCoreResult', 'semaCoreEvent', 'semaCoreAuditEntry', 'semaCoreCapability'] as const;
type TableName = typeof tables[number];
type Delegate = { findMany(): Promise<unknown[]>; count(): Promise<number>; createMany(input: { data: unknown[] }): Promise<unknown> };
const sourceTables = source as unknown as Record<TableName, Delegate>;
const targetTables = target as unknown as Record<TableName, Delegate>;

try {
  const existing = await target.semaCoreIdentityState.count();
  if (existing !== 0) throw new Error('Target sema_core database already contains an identity state; migration refused');
  const sourceState = await source.semaCoreIdentityState.findUnique({ where: { stateKey: 'PRIMARY' } });
  if (!sourceState) throw new Error('Source VectorForge database has no PRIMARY Core identity state');
  const rows = await Promise.all(tables.map(async (table) => [table, await sourceTables[table].findMany()] as const));
  await target.$transaction(async (tx) => {
    const txTables = tx as unknown as Record<TableName, Delegate>;
    for (const [table, records] of rows) if (records.length) await txTables[table].createMany({ data: records });
  });
  const verification = await Promise.all(tables.map(async (table) => [table, await targetTables[table].count()] as const));
  for (const [table, records] of rows) if (verification.find(([name]) => name === table)![1] !== records.length) throw new Error(`Verification failed for ${table}`);
  console.log(JSON.stringify({ migratedInstallationId: sourceState.installationId, tables: Object.fromEntries(verification) }, null, 2));
} finally {
  await Promise.all([source.$disconnect(), target.$disconnect()]);
}
