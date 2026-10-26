import { PrismaClient } from '@prisma/client';
import type { JsonObject } from '../core/types.js';
import type { CapabilityStore, CapabilityVersion, OperationDefinition, ServiceInstallation, ServiceInstance, ServiceOffers, ServiceVersion } from './records.js';

const iso = (value: Date | string) => new Date(value).toISOString();

type CapabilityRow = Omit<CapabilityVersion, 'createdAt' | 'operations' | 'choosing'> & { operations: unknown; choosing: unknown; createdAt: Date };
const toCapability = (row: CapabilityRow): CapabilityVersion => ({ ...row, operations: row.operations as OperationDefinition[], choosing: row.choosing as CapabilityVersion['choosing'], createdAt: iso(row.createdAt) });
type ServiceRow = Omit<ServiceVersion, 'createdAt' | 'operations' | 'extensions' | 'declarations'> & { operations: unknown; extensions: unknown; declarations: unknown; createdAt: Date };
const toService = (row: ServiceRow): ServiceVersion => ({ ...row, operations: row.operations as string[], extensions: row.extensions as string[], declarations: row.declarations as JsonObject, createdAt: iso(row.createdAt) });
type InstallationRow = { id: string; serviceVersionId: string; machineNodeId: string; settingsRef: string | null; endpointUrl: string | null; installedAt: Date };
const toInstallation = (row: InstallationRow): ServiceInstallation => ({ id: row.id, serviceVersionId: row.serviceVersionId, machineNodeId: row.machineNodeId, ...(row.settingsRef ? { settingsRef: row.settingsRef } : {}), ...(row.endpointUrl ? { endpointUrl: row.endpointUrl } : {}), installedAt: iso(row.installedAt) });
type InstanceRow = Omit<ServiceInstance, 'startedAt' | 'lastCheckInAt' | 'resources' | 'applicationKey' | 'offers'> & { startedAt: Date; lastCheckInAt: Date; resources: unknown; applicationKey: string | null; offers: unknown };
const toInstance = ({ applicationKey, offers, ...row }: InstanceRow): ServiceInstance => ({ ...row, resources: row.resources as JsonObject, startedAt: iso(row.startedAt), lastCheckInAt: iso(row.lastCheckInAt), ...(applicationKey ? { applicationKey } : {}), ...(offers && Object.keys(offers as object).length ? { offers: offers as ServiceOffers } : {}) });

const CAPABILITY = `SELECT "id", "capabilityKey", "version", "displayName", "description", "operations", "choosing", "approved", "legacy", "status", "createdAt" FROM "sema_core_capability_versions"`;
const SERVICE = `SELECT "id", "serviceKey", "version", "capabilityVersionId", "displayName", "operations", "extensions", "declarations", "legacy", "status", "createdAt" FROM "sema_core_service_versions"`;
const INSTALLATION = `SELECT "id", "serviceVersionId", "machineNodeId", "settingsRef", "endpointUrl", "installedAt" FROM "sema_core_service_installations"`;
const INSTANCE = `SELECT "id", "installationId", "startedAt", "lastCheckInAt", "capacity", "resources", "state", "applicationKey", "offers" FROM "sema_core_service_instances"`;

/**
 * PostgreSQL store for the capability and service records. Plain SQL, like the node store. Times are UTC: each record
 * carries its own time in ISO form, written into a column without a time zone.
 */
export class PrismaCapabilityStore implements CapabilityStore {
  constructor(private readonly prisma: PrismaClient) {}

  private async one<R, T>(sql: string, values: unknown[], map: (row: R) => T) { const rows = await this.prisma.$queryRawUnsafe<R[]>(sql, ...values); return rows[0] ? map(rows[0]) : undefined; }
  private async added(count: number, what: string) { if (count !== 1) throw new Error(`${what} already exists`); }

  async addCapabilityVersion(record: CapabilityVersion) {
    await this.added(await this.prisma.$executeRaw`
      INSERT INTO "sema_core_capability_versions" ("id", "capabilityKey", "version", "displayName", "description", "operations", "choosing", "approved", "legacy", "status", "createdAt")
      VALUES (${record.id}, ${record.capabilityKey}, ${record.version}, ${record.displayName}, ${record.description}, ${JSON.stringify(record.operations)}::jsonb, ${JSON.stringify(record.choosing)}::jsonb, ${record.approved}, ${record.legacy}, ${record.status}, ${record.createdAt}::timestamp)
      ON CONFLICT DO NOTHING`, `Capability ${record.capabilityKey} ${record.version}`);
  }
  getCapabilityVersion(id: string) { return this.one(`${CAPABILITY} WHERE "id" = $1`, [id], toCapability); }
  findCapabilityVersion(capabilityKey: string, version: string) { return this.one(`${CAPABILITY} WHERE "capabilityKey" = $1 AND "version" = $2`, [capabilityKey, version], toCapability); }
  async listCapabilityVersions() { return (await this.prisma.$queryRawUnsafe<CapabilityRow[]>(`${CAPABILITY} ORDER BY "capabilityKey", "version"`)).map(toCapability); }

  async addServiceVersion(record: ServiceVersion) {
    await this.added(await this.prisma.$executeRaw`
      INSERT INTO "sema_core_service_versions" ("id", "serviceKey", "version", "capabilityVersionId", "displayName", "operations", "extensions", "declarations", "legacy", "status", "createdAt")
      VALUES (${record.id}, ${record.serviceKey}, ${record.version}, ${record.capabilityVersionId}, ${record.displayName}, ${JSON.stringify(record.operations)}::jsonb, ${JSON.stringify(record.extensions)}::jsonb, ${JSON.stringify(record.declarations)}::jsonb, ${record.legacy}, ${record.status}, ${record.createdAt}::timestamp)
      ON CONFLICT DO NOTHING`, `Service ${record.serviceKey} ${record.version}`);
  }
  getServiceVersion(id: string) { return this.one(`${SERVICE} WHERE "id" = $1`, [id], toService); }
  findServiceVersion(serviceKey: string, version: string, capabilityVersionId: string) { return this.one(`${SERVICE} WHERE "serviceKey" = $1 AND "version" = $2 AND "capabilityVersionId" = $3`, [serviceKey, version, capabilityVersionId], toService); }
  async listServiceVersions() { return (await this.prisma.$queryRawUnsafe<ServiceRow[]>(`${SERVICE} ORDER BY "serviceKey", "version"`)).map(toService); }

  async addInstallation(record: ServiceInstallation) {
    await this.added(await this.prisma.$executeRaw`
      INSERT INTO "sema_core_service_installations" ("id", "serviceVersionId", "machineNodeId", "settingsRef", "endpointUrl", "installedAt")
      VALUES (${record.id}, ${record.serviceVersionId}, ${record.machineNodeId}, ${record.settingsRef ?? null}, ${record.endpointUrl ?? null}, ${record.installedAt}::timestamp)
      ON CONFLICT DO NOTHING`, `Installation of ${record.serviceVersionId}`);
  }
  getInstallation(id: string) { return this.one(`${INSTALLATION} WHERE "id" = $1`, [id], toInstallation); }
  findInstallation(serviceVersionId: string) { return this.one(`${INSTALLATION} WHERE "serviceVersionId" = $1`, [serviceVersionId], toInstallation); }
  async listInstallations() { return (await this.prisma.$queryRawUnsafe<InstallationRow[]>(`${INSTALLATION} ORDER BY "installedAt"`)).map(toInstallation); }

  async addInstance(record: ServiceInstance) {
    await this.added(await this.prisma.$executeRaw`
      INSERT INTO "sema_core_service_instances" ("id", "installationId", "startedAt", "lastCheckInAt", "capacity", "resources", "state", "applicationKey", "offers")
      VALUES (${record.id}, ${record.installationId}, ${record.startedAt}::timestamp, ${record.lastCheckInAt}::timestamp, ${record.capacity}, ${JSON.stringify(record.resources)}::jsonb, ${record.state}, ${record.applicationKey ?? null}, ${JSON.stringify(record.offers ?? {})}::jsonb)
      ON CONFLICT DO NOTHING`, `Instance ${record.id}`);
  }
  getInstance(id: string) { return this.one(`${INSTANCE} WHERE "id" = $1`, [id], toInstance); }
  async updateInstance(id: string, change: Partial<Pick<ServiceInstance, 'lastCheckInAt' | 'resources' | 'state'>>) {
    const updated = await this.one(`
      UPDATE "sema_core_service_instances" SET
        "lastCheckInAt" = COALESCE($2::timestamp, "lastCheckInAt"),
        "resources" = COALESCE($3::jsonb, "resources"),
        "state" = COALESCE($4, "state")
      WHERE "id" = $1
      RETURNING "id", "installationId", "startedAt", "lastCheckInAt", "capacity", "resources", "state", "applicationKey", "offers"`,
    [id, change.lastCheckInAt ?? null, change.resources === undefined ? null : JSON.stringify(change.resources), change.state ?? null], toInstance);
    if (!updated) throw new Error(`Instance ${id} does not exist`);
    return updated;
  }
  async listInstances() { return (await this.prisma.$queryRawUnsafe<InstanceRow[]>(`${INSTANCE} ORDER BY "startedAt"`)).map(toInstance); }
}
