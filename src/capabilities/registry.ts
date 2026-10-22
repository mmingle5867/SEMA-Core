import type { CoreCapability, JsonObject } from '../core/types.js';
import { CHOOSING_WAYS, type CapabilityStore, type CapabilityVersion, type ChoosingWay, type OperationDefinition, type ServiceDeclarations, type ServiceInstallation, type ServiceInstance, type ServiceVersion } from './records.js';
import { schemaProblems } from './schema.js';

/** A refusal the caller can fix: a bad name, a missing operation, an unknown record. */
export class CapabilityRecordError extends Error {
  constructor(message: string) { super(message); this.name = 'CapabilityRecordError'; }
}

const KEY = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\.[a-z0-9]+(?:-[a-z0-9]+)*)+$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const OPERATION = /^[a-z][a-z0-9-]*$/;
const RUNS_WHERE = new Set(['device', 'remote', 'either']);

const isObject = (value: unknown): value is JsonObject => typeof value === 'object' && value !== null && !Array.isArray(value);
function text(value: unknown, name: string, max = 200) {
  if (typeof value !== 'string' || !value.trim()) throw new CapabilityRecordError(`${name} must be a non-empty string`);
  if (value.trim().length > max) throw new CapabilityRecordError(`${name} must be at most ${max} characters`);
  return value.trim();
}
function key(value: unknown, name: string) {
  const checked = text(value, name, 120);
  if (!KEY.test(checked)) throw new CapabilityRecordError(`${name} must be lowercase words separated by dots, such as sema.document.write-copy`);
  return checked;
}
function version(value: unknown) {
  const checked = text(value, 'version', 40);
  if (!VERSION.test(checked)) throw new CapabilityRecordError('version must look like 1.0.0');
  return checked;
}
/** The reserved namespace (D-104). */
export const isReservedKey = (value: string) => value === 'sema' || value.startsWith('sema.');

/**
 * Registers the four records. Core decides nothing about which service is better; it checks only that a record is
 * complete and consistent, issues its ID, and keeps it. Published versions are never changed: registering the same
 * key and version again is refused, and a changed contract is a new version.
 */
export class CapabilityRegistry {
  constructor(
    private readonly store: CapabilityStore,
    private readonly issue: (typeCode: string, metadata: JsonObject) => Promise<string>,
    private readonly machineNodeId: () => Promise<string>,
  ) {}

  /** `approved` is true only when the caller holds the permission to use the reserved `sema.` names. */
  async registerCapabilityVersion(input: { capabilityKey: unknown; version: unknown; displayName: unknown; description?: unknown; operations: unknown; choosing: unknown }, approved: boolean) {
    const capabilityKey = key(input.capabilityKey, 'capabilityKey'), checkedVersion = version(input.version);
    if (isReservedKey(capabilityKey) && !approved) throw new CapabilityRecordError(`${capabilityKey} is in the reserved sema. namespace, which needs approval`);
    const operations = this.operations(input.operations);
    const choosing = this.choosing(input.choosing);
    if (await this.store.findCapabilityVersion(capabilityKey, checkedVersion)) throw new CapabilityRecordError(`${capabilityKey} ${checkedVersion} is already published; a changed contract is a new version`);
    const record: CapabilityVersion = {
      id: await this.issue('CAPABILITY', { capabilityKey, version: checkedVersion }),
      capabilityKey, version: checkedVersion, displayName: text(input.displayName, 'displayName'),
      description: input.description === undefined ? '' : text(input.description, 'description', 2000),
      operations, choosing, approved: isReservedKey(capabilityKey), legacy: false, status: 'ACTIVE', createdAt: new Date().toISOString(),
    };
    await this.store.addCapabilityVersion(record);
    return record;
  }

  /** A service version names the capability version it implements, offers every required operation, and declares where it runs, whether it works offline and on which systems (N8). */
  async registerServiceVersion(input: { serviceKey: unknown; version: unknown; capabilityVersionId: unknown; displayName: unknown; operations: unknown; declarations: unknown }, approved: boolean) {
    const serviceKey = key(input.serviceKey, 'serviceKey'), checkedVersion = version(input.version);
    if (isReservedKey(serviceKey) && !approved) throw new CapabilityRecordError(`${serviceKey} is in the reserved sema. namespace, which needs approval`);
    const capability = await this.store.getCapabilityVersion(text(input.capabilityVersionId, 'capabilityVersionId'));
    if (!capability) throw new CapabilityRecordError(`Capability version ${String(input.capabilityVersionId)} is not registered on this Core`);
    if (capability.status !== 'ACTIVE') throw new CapabilityRecordError(`Capability version ${capability.id} is not active`);
    if (capability.legacy) throw new CapabilityRecordError(`${capability.capabilityKey} ${capability.version} was moved from the old records and has no contract; publish a new version with its operations first`);
    if (!Array.isArray(input.operations) || !input.operations.length) throw new CapabilityRecordError('operations must list the operation keys the service offers');
    const operations = input.operations.map((value) => text(value, 'operation'));
    if (new Set(operations).size !== operations.length) throw new CapabilityRecordError('operations must not repeat');
    const missing = capability.operations.filter((operation) => operation.required && !operations.includes(operation.key)).map((operation) => operation.key);
    if (missing.length) throw new CapabilityRecordError(`The service must offer every required operation; missing: ${missing.join(', ')}`);
    const named = new Set(capability.operations.map((operation) => operation.key));
    const declarations = this.declarations(input.declarations);
    if (await this.store.findServiceVersion(serviceKey, checkedVersion, capability.id)) throw new CapabilityRecordError(`${serviceKey} ${checkedVersion} is already published for this capability version`);
    const record: ServiceVersion = {
      id: await this.issue('SERVICE', { serviceKey, version: checkedVersion }),
      serviceKey, version: checkedVersion, capabilityVersionId: capability.id, displayName: text(input.displayName, 'displayName'),
      operations, extensions: operations.filter((operation) => !named.has(operation)), declarations, legacy: false, status: 'ACTIVE', createdAt: new Date().toISOString(),
    };
    await this.store.addServiceVersion(record);
    return record;
  }

  /** A service version installed on this machine, once. Its settings and secrets stay with the service; Core keeps only where they are. */
  async install(input: { serviceVersionId: unknown; settingsRef?: unknown }) {
    const service = await this.store.getServiceVersion(text(input.serviceVersionId, 'serviceVersionId'));
    if (!service) throw new CapabilityRecordError(`Service version ${String(input.serviceVersionId)} is not registered on this Core`);
    if (service.status !== 'ACTIVE') throw new CapabilityRecordError(`Service version ${service.id} is not active`);
    if (await this.store.findInstallation(service.id)) throw new CapabilityRecordError(`Service version ${service.id} is already installed on this machine`);
    const record: ServiceInstallation = {
      id: await this.issue('SERVICE-INSTALLATION', { serviceVersionId: service.id }),
      serviceVersionId: service.id, machineNodeId: await this.machineNodeId(),
      ...(input.settingsRef === undefined ? {} : { settingsRef: text(input.settingsRef, 'settingsRef', 500) }),
      installedAt: new Date().toISOString(),
    };
    await this.store.addInstallation(record);
    return record;
  }

  /** A running copy starts and says how many jobs it takes at once and what it has (D-158). */
  async startInstance(input: { installationId: unknown; capacity?: unknown; resources?: unknown }, applicationKey?: string) {
    const installation = await this.store.getInstallation(text(input.installationId, 'installationId'));
    if (!installation) throw new CapabilityRecordError(`Installation ${String(input.installationId)} is not on this machine`);
    const capacity = input.capacity === undefined ? 1 : input.capacity;
    if (!Number.isSafeInteger(capacity) || (capacity as number) < 1 || (capacity as number) > 1000) throw new CapabilityRecordError('capacity must be a whole number from 1 to 1000');
    const now = new Date().toISOString();
    const record: ServiceInstance = {
      id: await this.issue('SERVICE-INSTANCE', { installationId: installation.id }),
      installationId: installation.id, startedAt: now, lastCheckInAt: now, capacity: capacity as number, resources: this.resources(input.resources), state: 'RUNNING', ...(applicationKey ? { applicationKey } : {}),
    };
    await this.store.addInstance(record);
    return record;
  }

  /** A running instance checks in, with what it has now. A stopped instance cannot come back; a new start is a new instance. */
  async checkIn(input: { instanceId: unknown; resources?: unknown }) {
    const instance = await this.runningInstance(input.instanceId);
    return this.store.updateInstance(instance.id, { lastCheckInAt: new Date().toISOString(), ...(input.resources === undefined ? {} : { resources: this.resources(input.resources) }) });
  }

  async stopInstance(input: { instanceId: unknown }) {
    const instance = await this.runningInstance(input.instanceId);
    return this.store.updateInstance(instance.id, { state: 'STOPPED', lastCheckInAt: new Date().toISOString() });
  }

  async list() {
    const [capabilities, services, installations, instances] = await Promise.all([this.store.listCapabilityVersions(), this.store.listServiceVersions(), this.store.listInstallations(), this.store.listInstances()]);
    const byKey = <T>(items: T[], name: (item: T) => string) => items.sort((a, b) => name(a).localeCompare(name(b)));
    return {
      capabilities: byKey(capabilities, (item) => `${item.capabilityKey} ${item.version}`),
      services: byKey(services, (item) => `${item.serviceKey} ${item.version}`),
      installations, instances,
    };
  }

  /**
   * Moves old single capability records over (D-159): each becomes a capability version, keeping its ID where it is
   * free, plus a service version for its provider and an installation on this machine. Safe to run again: whatever
   * already exists is left alone, so a move stopped half-way finishes on the next run. A record moved at start-up is
   * approved for a `sema.` name, as the old route always allowed; one arriving later through the old route is not.
   */
  async moveLegacy(records: CoreCapability[], approved: boolean) {
    let moved = 0;
    for (const old of records) {
      let capability = await this.store.findCapabilityVersion(old.capabilityKey, old.version);
      if (!capability) {
        const id = (await this.store.getCapabilityVersion(old.id)) ? await this.issue('CAPABILITY', { capabilityKey: old.capabilityKey, version: old.version }) : old.id;
        capability = {
          id, capabilityKey: old.capabilityKey, version: old.version, displayName: old.displayName, description: old.description, operations: [], choosing: [],
          approved: approved && isReservedKey(old.capabilityKey), legacy: true, status: old.status, createdAt: new Date().toISOString(),
        };
        await this.store.addCapabilityVersion(capability);
        moved += 1;
      }
      let service = await this.store.findServiceVersion(old.providerKey, old.version, capability.id);
      if (!service) {
        service = {
          id: await this.issue('SERVICE', { serviceKey: old.providerKey, version: old.version }),
          serviceKey: old.providerKey, version: old.version, capabilityVersionId: capability.id, displayName: old.providerKey,
          operations: [], extensions: [], declarations: {}, legacy: true, status: old.status, createdAt: new Date().toISOString(),
        };
        await this.store.addServiceVersion(service);
      }
      if (!(await this.store.findInstallation(service.id))) {
        const endpointUrl = typeof old.metadata.endpointUrl === 'string' ? old.metadata.endpointUrl : undefined;
        await this.store.addInstallation({
          id: await this.issue('SERVICE-INSTALLATION', { serviceVersionId: service.id }),
          serviceVersionId: service.id, machineNodeId: await this.machineNodeId(), ...(endpointUrl ? { endpointUrl } : {}), installedAt: new Date().toISOString(),
        });
      }
    }
    return { moved };
  }

  private operations(value: unknown): OperationDefinition[] {
    if (!Array.isArray(value) || !value.length) throw new CapabilityRecordError('operations must list at least one operation');
    const operations = value.map((item, index): OperationDefinition => {
      if (!isObject(item)) throw new CapabilityRecordError(`operation ${index + 1} must be an object`);
      const operationKey = text(item.key, 'operation key', 60);
      if (!OPERATION.test(operationKey)) throw new CapabilityRecordError(`operation key ${operationKey} must be lowercase words joined by hyphens`);
      if (typeof item.required !== 'boolean') throw new CapabilityRecordError(`operation ${operationKey} must say whether it is required`);
      for (const part of ['input', 'output'] as const) {
        if (item[part] === undefined) continue;
        if (!isObject(item[part])) throw new CapabilityRecordError(`operation ${operationKey} ${part} must be a JSON Schema object`);
        const problems = schemaProblems(item[part], `operation ${operationKey} ${part}`);
        if (problems.length) throw new CapabilityRecordError(problems.slice(0, 5).join('; '));
      }
      return {
        key: operationKey, required: item.required,
        ...(item.description === undefined ? {} : { description: text(item.description, 'operation description', 2000) }),
        ...(item.input === undefined ? {} : { input: item.input as JsonObject }),
        ...(item.output === undefined ? {} : { output: item.output as JsonObject }),
      };
    });
    if (new Set(operations.map((operation) => operation.key)).size !== operations.length) throw new CapabilityRecordError('operation keys must not repeat');
    if (!operations.some((operation) => operation.required)) throw new CapabilityRecordError('at least one operation must be required');
    return operations;
  }

  private choosing(value: unknown): ChoosingWay[] {
    if (!Array.isArray(value) || !value.length || !value.every((way) => (CHOOSING_WAYS as readonly unknown[]).includes(way))) throw new CapabilityRecordError(`choosing must list the ways its services may be chosen: ${CHOOSING_WAYS.join(', ')}`);
    if (new Set(value).size !== value.length) throw new CapabilityRecordError('choosing must not repeat a way');
    return value as ChoosingWay[];
  }

  private declarations(value: unknown): ServiceDeclarations {
    if (!isObject(value)) throw new CapabilityRecordError('declarations must say where the service runs, whether it works offline, and on which systems');
    if (typeof value.runsWhere !== 'string' || !RUNS_WHERE.has(value.runsWhere)) throw new CapabilityRecordError('declarations.runsWhere must be device, remote or either');
    if (typeof value.offline !== 'boolean') throw new CapabilityRecordError('declarations.offline must be true or false');
    if (!Array.isArray(value.systems) || !value.systems.length || !value.systems.every((system) => typeof system === 'string' && system.trim())) throw new CapabilityRecordError('declarations.systems must list the operating systems it runs on');
    return value as ServiceDeclarations;
  }

  private resources(value: unknown): JsonObject {
    if (value === undefined) return {};
    if (!isObject(value)) throw new CapabilityRecordError('resources must be an object');
    if (JSON.stringify(value).length > 4000) throw new CapabilityRecordError('resources must be under 4000 characters');
    return value;
  }

  private async runningInstance(id: unknown) {
    const instance = await this.store.getInstance(text(id, 'instanceId'));
    if (!instance) throw new CapabilityRecordError(`Instance ${String(id)} is not on this machine`);
    if (instance.state !== 'RUNNING') throw new CapabilityRecordError(`Instance ${instance.id} has stopped; start a new one`);
    return instance;
  }
}
