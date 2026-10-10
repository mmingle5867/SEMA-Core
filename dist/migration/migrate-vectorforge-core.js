import { PrismaClient } from '@prisma/client';
const sourceUrl = process.env.SEMA_CORE_SOURCE_DATABASE_URL;
if (!sourceUrl)
    throw new Error('SEMA_CORE_SOURCE_DATABASE_URL is required');
const source = new PrismaClient({ datasources: { db: { url: sourceUrl } } });
const target = new PrismaClient();
const tables = ['semaCoreIdentityState', 'semaIdentifierReservation', 'semaIssuedIdentifier', 'semaCoreCommand', 'semaCoreExecution', 'semaCoreResult', 'semaCoreEvent', 'semaCoreAuditEntry', 'semaCoreCapability'];
const sourceTables = source;
const targetTables = target;
try {
    const existing = await target.semaCoreIdentityState.count();
    if (existing !== 0)
        throw new Error('Target sema_core database already contains an identity state; migration refused');
    const sourceState = await source.semaCoreIdentityState.findUnique({ where: { stateKey: 'PRIMARY' } });
    if (!sourceState)
        throw new Error('Source VectorForge database has no PRIMARY Core identity state');
    const rows = await Promise.all(tables.map(async (table) => [table, await sourceTables[table].findMany()]));
    await target.$transaction(async (tx) => {
        const txTables = tx;
        for (const [table, records] of rows)
            if (records.length)
                await txTables[table].createMany({ data: records });
    });
    const verification = await Promise.all(tables.map(async (table) => [table, await targetTables[table].count()]));
    for (const [table, records] of rows)
        if (verification.find(([name]) => name === table)[1] !== records.length)
            throw new Error(`Verification failed for ${table}`);
    console.log(JSON.stringify({ migratedInstallationId: sourceState.installationId, tables: Object.fromEntries(verification) }, null, 2));
}
finally {
    await Promise.all([source.$disconnect(), target.$disconnect()]);
}
//# sourceMappingURL=migrate-vectorforge-core.js.map