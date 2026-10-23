import type { JsonObject } from '../core/types.js';

/**
 * The capability and service layer's records (design doc section 9, D-151): a capability version (the contract), a
 * service version (one provider's published software for one capability version), an installation (that service on
 * this machine) and an instance (a running copy). Every ID is issued by Core. A published capability or service version
 * never changes (D-152, D-056).
 */
export interface OperationDefinition {
  key: string;
  /** Every service of the capability must provide a required operation; anything else a service offers is an extension. */
  required: boolean;
  description?: string;
  /** JSON Schema for what goes in and what comes back (D-155). Checked from phase 2. */
  input?: JsonObject;
  output?: JsonObject;
  /**
   * For a general capability whose callers say what shape they want back (D-174): the input property that carries the
   * requested shape (JSON Schema, within the supported subset), and the output property that must match it. Core checks
   * the shape on the way in and the answer against it on the way back.
   */
  answerShape?: { input: string; output: string };
  /**
   * The input property naming the job a call is for (`{ key, version }`, D-173). The "may" step then also needs the
   * permission capability.<capability key>.job.<job key>, so AI can be allowed per job (D-174).
   */
  job?: string;
}

/**
 * The ways a command may choose services (N2, D-162): exactly one and no other; a list tried in order; all of them
 * (or those listed); or the organization's rules (not built yet).
 */
export const CHOOSING_WAYS = ['bound', 'dynamic', 'consensus', 'policy'] as const;
export type ChoosingWay = typeof CHOOSING_WAYS[number];

export interface CapabilityVersion {
  id: string;
  capabilityKey: string;
  version: string;
  displayName: string;
  description: string;
  operations: OperationDefinition[];
  /** The ways of choosing its services that the capability permits (D-162). Empty for a record moved from the old ones: it cannot be run by command. */
  choosing: ChoosingWay[];
  /** A name under the reserved `sema.` namespace may be used only when approved (D-104). */
  approved: boolean;
  /** Moved from the old single capability record; its contract is not written yet. */
  legacy: boolean;
  status: 'ACTIVE' | 'INACTIVE';
  createdAt: string;
}

/**
 * What a service says about itself (N8). Required for a new service: `runsWhere` (device, remote or either), `offline`
 * (true or false) and `systems` (the operating systems it runs on). Empty for a service moved from the old records.
 */
export type ServiceDeclarations = JsonObject;

export interface ServiceVersion {
  id: string;
  serviceKey: string;
  version: string;
  capabilityVersionId: string;
  displayName: string;
  /** The operation keys it offers: every required one, and any extensions. */
  operations: string[];
  /** Offered operations the capability does not name: extensions (N5). */
  extensions: string[];
  declarations: ServiceDeclarations;
  legacy: boolean;
  status: 'ACTIVE' | 'INACTIVE';
  createdAt: string;
}

export interface ServiceInstallation {
  id: string;
  serviceVersionId: string;
  /** The machine node it is installed on: this Core's own. */
  machineNodeId: string;
  /** Where the service keeps its own settings and secrets. Never the secrets themselves. */
  settingsRef?: string;
  /** Where an old-style provider answered; services check in for work instead (D-153). */
  endpointUrl?: string;
  installedAt: string;
}

export interface ServiceInstance {
  id: string;
  installationId: string;
  startedAt: string;
  lastCheckInAt: string;
  /** How many jobs it takes at once. */
  capacity: number;
  /** What it last reported having: free memory, disk, network and so on (D-158). */
  resources: JsonObject;
  /** STOPPED: it said it stopped. LOST: it stopped checking in, so Core marked it (a crash, a process ended outright, a power cut). */
  state: 'RUNNING' | 'STOPPED' | 'LOST';
  /** The program that started it. That program can never issue a capability command (D-160). Missing on instances recorded before 0.4.0. */
  applicationKey?: string;
}

export interface CapabilityStore {
  addCapabilityVersion(record: CapabilityVersion): Promise<void>;
  getCapabilityVersion(id: string): Promise<CapabilityVersion | undefined>;
  findCapabilityVersion(capabilityKey: string, version: string): Promise<CapabilityVersion | undefined>;
  listCapabilityVersions(): Promise<CapabilityVersion[]>;
  addServiceVersion(record: ServiceVersion): Promise<void>;
  getServiceVersion(id: string): Promise<ServiceVersion | undefined>;
  findServiceVersion(serviceKey: string, version: string, capabilityVersionId: string): Promise<ServiceVersion | undefined>;
  listServiceVersions(): Promise<ServiceVersion[]>;
  addInstallation(record: ServiceInstallation): Promise<void>;
  getInstallation(id: string): Promise<ServiceInstallation | undefined>;
  findInstallation(serviceVersionId: string): Promise<ServiceInstallation | undefined>;
  listInstallations(): Promise<ServiceInstallation[]>;
  addInstance(record: ServiceInstance): Promise<void>;
  getInstance(id: string): Promise<ServiceInstance | undefined>;
  updateInstance(id: string, change: Partial<Pick<ServiceInstance, 'lastCheckInAt' | 'resources' | 'state'>>): Promise<ServiceInstance>;
  listInstances(): Promise<ServiceInstance[]>;
}

const copy = <T>(value: T): T => structuredClone(value);

export class InMemoryCapabilityStore implements CapabilityStore {
  private readonly capabilities = new Map<string, CapabilityVersion>();
  private readonly services = new Map<string, ServiceVersion>();
  private readonly installations = new Map<string, ServiceInstallation>();
  private readonly instances = new Map<string, ServiceInstance>();
  private add<T extends { id: string }>(map: Map<string, T>, record: T, what: string) { if (map.has(record.id)) throw new Error(`${what} ${record.id} already exists`); map.set(record.id, copy(record)); }
  async addCapabilityVersion(record: CapabilityVersion) {
    if ([...this.capabilities.values()].some((item) => item.capabilityKey === record.capabilityKey && item.version === record.version)) throw new Error(`Capability ${record.capabilityKey} ${record.version} already exists`);
    this.add(this.capabilities, record, 'Capability version');
  }
  async getCapabilityVersion(id: string) { const item = this.capabilities.get(id); return item && copy(item); }
  async findCapabilityVersion(key: string, version: string) { const item = [...this.capabilities.values()].find((entry) => entry.capabilityKey === key && entry.version === version); return item && copy(item); }
  async listCapabilityVersions() { return [...this.capabilities.values()].map(copy); }
  async addServiceVersion(record: ServiceVersion) {
    if ([...this.services.values()].some((item) => item.serviceKey === record.serviceKey && item.version === record.version && item.capabilityVersionId === record.capabilityVersionId)) throw new Error(`Service ${record.serviceKey} ${record.version} already exists for that capability version`);
    this.add(this.services, record, 'Service version');
  }
  async getServiceVersion(id: string) { const item = this.services.get(id); return item && copy(item); }
  async findServiceVersion(key: string, version: string, capabilityVersionId: string) { const item = [...this.services.values()].find((entry) => entry.serviceKey === key && entry.version === version && entry.capabilityVersionId === capabilityVersionId); return item && copy(item); }
  async listServiceVersions() { return [...this.services.values()].map(copy); }
  async addInstallation(record: ServiceInstallation) {
    if ([...this.installations.values()].some((item) => item.serviceVersionId === record.serviceVersionId)) throw new Error(`Service version ${record.serviceVersionId} is already installed on this machine`);
    this.add(this.installations, record, 'Installation');
  }
  async getInstallation(id: string) { const item = this.installations.get(id); return item && copy(item); }
  async findInstallation(serviceVersionId: string) { const item = [...this.installations.values()].find((entry) => entry.serviceVersionId === serviceVersionId); return item && copy(item); }
  async listInstallations() { return [...this.installations.values()].map(copy); }
  async addInstance(record: ServiceInstance) { this.add(this.instances, record, 'Instance'); }
  async getInstance(id: string) { const item = this.instances.get(id); return item && copy(item); }
  async updateInstance(id: string, change: Partial<Pick<ServiceInstance, 'lastCheckInAt' | 'resources' | 'state'>>) {
    const item = this.instances.get(id);
    if (!item) throw new Error(`Instance ${id} does not exist`);
    const next = { ...item, ...copy(change) };
    this.instances.set(id, next);
    return copy(next);
  }
  async listInstances() { return [...this.instances.values()].map(copy); }
}
