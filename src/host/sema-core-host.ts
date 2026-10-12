import type { SemaCore } from '../core/sema-core.js';
import { SEMA_CORE_VERSION } from '../version.js';
import { CoreHostAuthorizationError, CoreHostValidationError } from './errors.js';
import type { CoreCapability, CoreCommand, CoreExecution, CoreLifecycleStatus, JsonObject } from '../core/types.js';
import type { CoreHostAuthorization, CoreHostDocumentation, CoreHostRequestContext, CoreHostSettings, CoreHostStore, VersionedCoreHostSettings } from './types.js';
import { DEFAULT_CORE_HOST_SETTINGS } from './default-settings.js';
import { isNodeType, type LocalNodes, type NodeType } from '../topology/local-nodes.js';
import { Conversations, type AddressedPeers, type NodePeer } from '../topology/conversations.js';

/** How this Core reaches the others: a directory of peers and the stable address other Cores use to reach this one. */
export interface CoreTopologyOptions { peers: AddressedPeers; address?: string }

const settingsKeys = Object.keys(DEFAULT_CORE_HOST_SETTINGS) as Array<keyof CoreHostSettings>;
const settingsKeySet = new Set<string>(settingsKeys);

/**
 * Accepts only known settings of the right type. The known keys and their types come from
 * DEFAULT_CORE_HOST_SETTINGS, so adding a setting there makes it updatable here automatically.
 */
function validateSettings(input: unknown, current: CoreHostSettings): CoreHostSettings {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new CoreHostValidationError('Settings update must be a JSON object');
  }
  const patch = input as Record<string, unknown>;
  const unknownKeys = Object.keys(patch).filter((key) => !settingsKeySet.has(key));
  if (unknownKeys.length) throw new CoreHostValidationError(`Unknown Core Host setting: ${unknownKeys.join(', ')}`);
  for (const key of settingsKeys) {
    if (!Object.hasOwn(patch, key)) continue;
    const expected = typeof DEFAULT_CORE_HOST_SETTINGS[key];
    if (typeof patch[key] !== expected) throw new CoreHostValidationError(`${key} must be a ${expected}`);
  }
  const values = { ...current, ...patch } as CoreHostSettings;
  for (const key of ['maxReservationSize', 'auditRetentionDays', 'eventRetentionDays'] as const) {
    if (!Number.isSafeInteger(values[key]) || values[key] < 1) throw new CoreHostValidationError(`${key} must be a positive integer`);
  }
  if (values.maxReservationSize > 100_000) throw new CoreHostValidationError('maxReservationSize cannot exceed 100000');
  return values;
}

/** Installation backend: settings, operational statistics, docs, and Core runtime access. */
export class SemaCoreHost {
  constructor(
    private readonly core: SemaCore,
    private readonly store: CoreHostStore,
    private readonly authorization: CoreHostAuthorization,
    private readonly version: string = SEMA_CORE_VERSION,
    private readonly localNodes?: LocalNodes,
    private readonly topology?: CoreTopologyOptions,
  ) {}

  async initialize(context: CoreHostRequestContext = { actorId: null }) {
    const state = await this.core.initialize();
    let settings = await this.store.getHostSettings();
    if (!settings) {
      settings = { installationId: state.installationId, revision: 1, updatedAt: new Date(), updatedById: context.actorId, values: { ...DEFAULT_CORE_HOST_SETTINGS, maxReservationSize: this.core.getMaxReservationSize() } };
      await this.store.saveHostSettings(settings);
    }
    this.core.setMaxReservationSize(settings.values.maxReservationSize);
    return { state, settings };
  }

  async health(context: CoreHostRequestContext) {
    await this.requireRead(context, 'core.health.read');
    const statistics = await this.store.getHostStatistics();
    return { status: statistics.status, installationId: statistics.installationId, version: this.version, capturedAt: statistics.capturedAt };
  }

  async getSettings(context: CoreHostRequestContext) {
    await this.requireRead(context, 'core.settings.read');
    const settings = await this.store.getHostSettings();
    if (!settings) throw new Error('Core Host is not initialized');
    return settings;
  }

  async updateSettings(context: CoreHostRequestContext, patch: Partial<CoreHostSettings>) {
    await this.requireAdministration(context, 'core.settings.write');
    const current = await this.getSettings(context);
    const values = validateSettings(patch, current.values);
    const next: VersionedCoreHostSettings = { ...current, values, revision: current.revision + 1, updatedAt: new Date(), updatedById: context.actorId };
    // Persist first: the running Core limit must never get ahead of what is stored.
    const saved = await this.store.saveHostSettings(next);
    this.core.setMaxReservationSize(saved.values.maxReservationSize);
    await this.core.recordAudit({ action: 'core-host.settings.updated', actorId: context.actorId, evidence: { changedKeys: settingsKeys.filter((key) => current.values[key] !== values[key]), revision: saved.revision } });
    return saved;
  }

  async statistics(context: CoreHostRequestContext) { await this.requireRead(context, 'core.statistics.read'); return this.store.getHostStatistics(); }
  async capabilities(context: CoreHostRequestContext) { await this.requireRead(context, 'core.capabilities.read'); return this.store.getCapabilitiesForHost(); }

  async reserveIdentifiers(context: CoreHostRequestContext, input: { count: number; typeCode?: string; metadata?: import('../core/types.js').JsonObject }) {
    await this.requireAdministration(context, 'core.identifiers.reserve');
    return this.core.reserveIdentifiers(input.count, input.typeCode, input.metadata ?? {});
  }

  async consumeReservedIdentifier(context: CoreHostRequestContext, input: { reservationId: string; id: string; metadata?: import('../core/types.js').JsonObject }) {
    await this.requireAdministration(context, 'core.identifiers.consume');
    return this.core.consumeReservedIdentifier(input.id, input.reservationId, input.metadata ?? {});
  }

  /** Core runtime records live in the Core database, never in an application's database. */
  async createCommand(context: CoreHostRequestContext, input: { commandType: string; actorId?: string | null; workspaceId?: string | null; subjectIds?: string[]; context?: JsonObject; payload?: JsonObject }) {
    await this.requireAdministration(context, 'core.commands.create');
    return this.core.createCommand(input);
  }
  async updateCommandStatus(context: CoreHostRequestContext, input: { commandId: string; status: CoreLifecycleStatus }) { await this.requireAdministration(context, 'core.commands.update'); return this.core.updateCommandStatus(input); }
  async getCommand(context: CoreHostRequestContext, commandId: string) { await this.requireRead(context, 'core.commands.read'); return this.core.getCommand(commandId); }
  async listCommands(context: CoreHostRequestContext, input: { actorId?: string | null; commandTypePrefix?: string; status?: CoreCommand['status']; limit?: number }) { await this.requireRead(context, 'core.commands.read'); return this.core.listCommands(input); }

  async startExecution(context: CoreHostRequestContext, input: { commandId: string; providerId?: string | null; context?: JsonObject }) {
    await this.requireAdministration(context, 'core.executions.start');
    return this.core.startExecution(input);
  }

  async completeExecution(context: CoreHostRequestContext, input: { execution: CoreExecution; status: Extract<CoreLifecycleStatus, 'SUCCESS' | 'FAILED' | 'CANCELLED' | 'WAITING'>; resultType?: string; subjectIds?: string[]; result?: JsonObject; error?: JsonObject }) {
    await this.requireAdministration(context, 'core.executions.complete');
    return this.core.completeExecution(input);
  }

  async recordEvent(context: CoreHostRequestContext, input: { eventType: string; commandId?: string | null; executionId?: string | null; subjectIds?: string[]; data?: JsonObject }) {
    await this.requireAdministration(context, 'core.events.record');
    return this.core.recordEvent(input);
  }

  async recordAudit(context: CoreHostRequestContext, input: { action: string; actorId?: string | null; commandId?: string | null; executionId?: string | null; subjectIds?: string[]; evidence?: JsonObject }) {
    await this.requireAdministration(context, 'core.audits.record');
    return this.core.recordAudit(input);
  }

  async registerCapability(context: CoreHostRequestContext, input: Omit<CoreCapability, 'id' | 'status'> & { status?: CoreCapability['status'] }) {
    await this.requireAdministration(context, 'core.capabilities.register');
    return this.core.registerCapability(input);
  }

  async discoverCapabilities(context: CoreHostRequestContext, query = '') {
    await this.requireRead(context, 'core.capabilities.read');
    return this.core.discoverCapabilities(query);
  }

  async authorizeInvocation(context: CoreHostRequestContext, input: { capabilityKey: string; actorId?: string | null; workspaceId?: string | null }) {
    await this.requireAdministration(context, 'core.capabilities.authorize');
    return this.core.authorizeInvocation(input);
  }

  async resolveCapability(context: CoreHostRequestContext, input: { capabilityKey: string; actorId?: string | null; workspaceId?: string | null }) {
    await this.requireAdministration(context, 'core.capabilities.resolve');
    return this.core.resolveCapability(input);
  }

  async documentation(context: CoreHostRequestContext): Promise<CoreHostDocumentation> {
    await this.requireRead(context, 'core.documentation.read');
    return {
      packageName: '@selo/sema-core', version: this.version,
      summary: 'Local-first Core Host for settings, statistics, health, and documented access to SEMA Core runtime services.',
      endpoints: [
        { method: 'GET', path: '/v1/core/topology/nodes', purpose: 'Describe a node held by this Core: type, parent, basis, child count and status (query: id).' },
        { method: 'POST', path: '/v1/core/topology/nodes/accept', purpose: 'Record a node on this machine from an ID that another Core issued. Its type (ORGANIZATION, GROUP, USER or MACHINE) is set here and never changes.' },
        { method: 'POST', path: '/v1/core/topology/nodes/issue-child', purpose: 'Issue the ID for a new child from a node\'s basis and count the child.' },
        { method: 'POST', path: '/v1/core/topology/nodes/issue-basis', purpose: 'Issue a fresh value another node will adopt as its basis in a roll-up.' },
        { method: 'POST', path: '/v1/core/topology/nodes/set-parent', purpose: 'Change a node\'s parent pointer.' },
        { method: 'POST', path: '/v1/core/topology/nodes/set-basis', purpose: 'Adopt a shorter basis after a roll-up and restart its counter.' },
        { method: 'POST', path: '/v1/core/topology/nodes/child-count', purpose: 'Move a node\'s child count by a signed amount, never below zero.' },
        { method: 'POST', path: '/v1/core/topology/nodes/retire', purpose: 'Retire a node and return its child count so the parent can absorb it.' },
        { method: 'GET', path: '/v1/core/topology/local', purpose: 'List the nodes this Core holds and the address other Cores use to reach it.' },
        { method: 'GET', path: '/v1/core/topology/walk-up', purpose: 'Walk up from a node by asking each parent in turn (query: nodeId, nodeAddress).' },
        { method: 'POST', path: '/v1/core/topology/create', purpose: 'Create a node of a given type (ORGANIZATION, GROUP, USER or MACHINE) under a parent, here or on another machine: installs a machine or adds a user.' },
        { method: 'POST', path: '/v1/core/topology/insert-above', purpose: 'Insert a new node of a given type (ORGANIZATION, GROUP, USER or MACHINE) between a node and its parent.' },
        { method: 'POST', path: '/v1/core/topology/rehome', purpose: 'Move a node and everything below it under a new parent.' },
        { method: 'POST', path: '/v1/core/topology/remove', purpose: 'Retire a node; its children follow its pointer to the nearest live ancestor.' },
        { method: 'POST', path: '/v1/core/topology/roll-up', purpose: 'Shorten a node\'s basis using a reachable ancestor.' },
        { method: 'POST', path: '/v1/core/topology/repair-parent', purpose: 'Point a node whose parent was retired at its nearest live ancestor.' },
        { method: 'GET', path: '/v1/core/health', purpose: 'Read Core availability and installation identity.' },
        { method: 'GET', path: '/v1/core/settings', purpose: 'Read installation-level Core settings.' },
        { method: 'PUT', path: '/v1/core/settings', purpose: 'Update authorized installation-level Core settings.' },
        { method: 'GET', path: '/v1/core/statistics', purpose: 'Read operational totals without application business data.' },
        { method: 'GET', path: '/v1/core/capabilities', purpose: 'List installed capability records.' },
        { method: 'GET', path: '/v1/core/documentation', purpose: 'Read machine-readable backend documentation.' },
        { method: 'POST', path: '/v1/core/identifiers/reservations', purpose: 'Reserve permanent identifiers for authorized local application work.' },
        { method: 'POST', path: '/v1/core/identifiers/consume', purpose: 'Record use of a previously reserved identifier.' },
        { method: 'POST', path: '/v1/core/runtime/commands', purpose: 'Create a Core command in the shared Core database.' },
        { method: 'POST', path: '/v1/core/runtime/commands/status', purpose: 'Update the lifecycle status of a shared Core command.' },
        { method: 'GET', path: '/v1/core/runtime/commands', purpose: 'Read one Core command or a bounded, filtered Core command list.' },
        { method: 'POST', path: '/v1/core/runtime/executions', purpose: 'Start a Core execution in the shared Core database.' },
        { method: 'POST', path: '/v1/core/runtime/executions/complete', purpose: 'Complete a Core execution and optionally record its result.' },
        { method: 'POST', path: '/v1/core/runtime/events', purpose: 'Record a Core event in the shared Core database.' },
        { method: 'POST', path: '/v1/core/runtime/audits', purpose: 'Record a Core audit entry in the shared Core database.' },
        { method: 'POST', path: '/v1/core/runtime/capabilities', purpose: 'Register or update a Core capability.' },
        { method: 'GET', path: '/v1/core/runtime/capabilities', purpose: 'Discover active Core capabilities.' },
        { method: 'POST', path: '/v1/core/runtime/capabilities/authorize', purpose: 'Authorize a Core capability invocation.' },
        { method: 'POST', path: '/v1/core/runtime/capabilities/resolve', purpose: 'Resolve an authorized Core capability.' },
      ],
      settings: [
        { key: 'maxReservationSize', description: 'Maximum IDs granted by one reservation request.' },
        { key: 'auditRetentionDays', description: 'Configured retention period for audit records.' },
        { key: 'eventRetentionDays', description: 'Configured retention period for event records.' },
        { key: 'capabilityAutoFallback', description: 'Whether policy may select an approved fallback capability.' },
        { key: 'documentationEnabled', description: 'Whether host documentation endpoint is available.' },
      ],
      statisticGroups: ['identity reservations and issuance', 'commands', 'executions', 'results', 'events', 'audit', 'capabilities'],
    };
  }

  // Nodes held by this Core. Operations across machines are conversations between Cores built from these.
  private requireNodes() { if (!this.localNodes) throw new CoreHostValidationError('Local nodes are not enabled on this Core'); return this.localNodes; }
  private text(value: unknown, name: string) { if (typeof value !== 'string' || !value.trim()) throw new CoreHostValidationError(`${name} must be a non-empty string`); return value.trim(); }
  private nodeType(value: unknown): NodeType { if (!isNodeType(value)) throw new CoreHostValidationError('type must be ORGANIZATION, GROUP, USER or MACHINE'); return value; }
  private async nodeChange<T>(context: CoreHostRequestContext, action: string, subjectIds: string[], work: (nodes: LocalNodes) => Promise<T>, evidence: (result: T) => JsonObject = () => ({})) {
    await this.requireAdministration(context, 'core.topology.write');
    const result = await work(this.requireNodes());
    await this.core.recordAudit({ action, actorId: context.actorId, subjectIds, evidence: evidence(result) });
    return result;
  }
  /** What any authorized caller, including another Core walking up the tree, may learn about a node held here. */
  async nodeDescribe(context: CoreHostRequestContext, input: { id: string }) { await this.requireRead(context, 'core.topology.read'); return (await this.requireNodes().describe(this.text(input.id, 'id'))) ?? null; }
  nodeAccept(context: CoreHostRequestContext, input: { id: string; type: NodeType; parentId?: string; parentAddress?: string }) { const id = this.text(input.id, 'id'); const type = this.nodeType(input.type); const parentId = input.parentId === undefined ? undefined : this.text(input.parentId, 'parentId'); const parentAddress = input.parentAddress === undefined ? undefined : this.text(input.parentAddress, 'parentAddress'); return this.nodeChange(context, 'core.topology.node-accepted', [id, ...(parentId ? [parentId] : [])], (nodes) => nodes.accept({ id, type, parentId, parentAddress }), (result) => ({ type: result.type })); }
  nodeIssueChild(context: CoreHostRequestContext, input: { nodeId: string }) { const nodeId = this.text(input.nodeId, 'nodeId'); return this.nodeChange(context, 'core.topology.child-id-issued', [nodeId], (nodes) => nodes.issueChildId(nodeId), (result) => ({ value: result.value, childCount: result.childCount })); }
  nodeIssueBasis(context: CoreHostRequestContext, input: { nodeId: string }) { const nodeId = this.text(input.nodeId, 'nodeId'); return this.nodeChange(context, 'core.topology.basis-issued', [nodeId], (nodes) => nodes.issueBasis(nodeId), (result) => ({ value: result.value })); }
  nodeSetParent(context: CoreHostRequestContext, input: { nodeId: string; parentId: string; parentAddress?: string }) { const nodeId = this.text(input.nodeId, 'nodeId'); const parentId = this.text(input.parentId, 'parentId'); const parentAddress = input.parentAddress === undefined ? undefined : this.text(input.parentAddress, 'parentAddress'); return this.nodeChange(context, 'core.topology.parent-set', [nodeId, parentId], (nodes) => nodes.setParent(nodeId, parentId, parentAddress)); }
  nodeSetBasis(context: CoreHostRequestContext, input: { nodeId: string; basis: string }) { const nodeId = this.text(input.nodeId, 'nodeId'); const basis = this.text(input.basis, 'basis'); return this.nodeChange(context, 'core.topology.basis-set', [nodeId], (nodes) => nodes.setBasis(nodeId, basis), (result) => ({ previousBasis: result.previousBasis, basis: result.basis })); }
  nodeAdjustChildCount(context: CoreHostRequestContext, input: { nodeId: string; delta: number }) { const nodeId = this.text(input.nodeId, 'nodeId'); if (typeof input.delta !== 'number') throw new CoreHostValidationError('delta must be a number'); return this.nodeChange(context, 'core.topology.child-count-adjusted', [nodeId], (nodes) => nodes.adjustChildCount(nodeId, input.delta), (result) => ({ delta: input.delta, childCount: result.childCount })); }
  nodeRetire(context: CoreHostRequestContext, input: { nodeId: string }) { const nodeId = this.text(input.nodeId, 'nodeId'); return this.nodeChange(context, 'core.topology.node-retired', [nodeId], (nodes) => nodes.retire(nodeId), (result) => ({ parentId: result.parentId ?? null, childCount: result.childCount })); }

  // Operations across machines. This Core runs the conversation; the other Cores are reached at their stored addresses.
  private conversations() {
    if (!this.topology) throw new CoreHostValidationError('Core-to-Core conversations are not configured on this Core');
    return new Conversations(this.topology.peers);
  }
  /** Where this Core can be reached by the others. A node held here is recorded with this address beside any pointer to it. */
  private ownAddress() { return this.topology?.address; }
  private address(value: unknown, name: string) { return value === undefined || value === null || value === '' ? this.ownAddress() : this.text(value, name); }
  private async placement(address: string | undefined): Promise<NodePeer> {
    if (!address || address === this.ownAddress()) return this.requireNodes();
    const peer = await this.topology?.peers.at(address);
    if (!peer) throw new CoreHostValidationError(`The Core at ${address} is not reachable`);
    return peer;
  }
  private async conversation<T>(context: CoreHostRequestContext, action: string, subjectIds: string[], work: (talk: Conversations) => Promise<T>, evidence: (result: T) => JsonObject = () => ({})) {
    await this.requireAdministration(context, 'core.topology.write');
    const result = await work(this.conversations());
    await this.core.recordAudit({ action, actorId: context.actorId, subjectIds, evidence: evidence(result) });
    return result;
  }
  /** The nodes this Core holds, with the address others use to reach it. */
  async topologyLocal(context: CoreHostRequestContext) { await this.requireRead(context, 'core.topology.read'); return { address: this.ownAddress() ?? null, nodes: await this.requireNodes().list() }; }
  /** Walks up from a node, one parent at a time, stopping where a machine cannot be reached. */
  async topologyWalkUp(context: CoreHostRequestContext, input: { nodeId: string; nodeAddress?: string }) { await this.requireRead(context, 'core.topology.read'); return this.conversations().walkUp(this.text(input.nodeId, 'nodeId'), this.address(input.nodeAddress, 'nodeAddress')); }
  /** Creates a node under a parent, on this machine or on the Core at newNodeAddress. Installing a machine and adding a user are this operation. */
  topologyCreate(context: CoreHostRequestContext, input: { parentId: string; parentAddress?: string; type: NodeType; newNodeAddress?: string }) {
    const parentId = this.text(input.parentId, 'parentId'), type = this.nodeType(input.type);
    return this.conversation(context, 'core.topology.node-created', [parentId], async (talk) => {
      const parentAddress = this.address(input.parentAddress, 'parentAddress');
      const newNodeAddress = this.address(input.newNodeAddress, 'newNodeAddress');
      const created = await talk.createNode({ parentId, parentAddress, type, newNodePeer: await this.placement(newNodeAddress) });
      return { ...created, address: newNodeAddress ?? null };
    }, (result) => ({ id: result.id, type, parentId, address: result.address }));
  }
  /** Inserts a new node between a node and its parent. */
  topologyInsertAbove(context: CoreHostRequestContext, input: { childId: string; childAddress?: string; type: NodeType; newNodeAddress?: string }) {
    const childId = this.text(input.childId, 'childId'), type = this.nodeType(input.type);
    return this.conversation(context, 'core.topology.node-inserted', [childId], async (talk) => {
      const newNodeAddress = this.address(input.newNodeAddress, 'newNodeAddress');
      const inserted = await talk.insertAbove({ childId, childAddress: this.address(input.childAddress, 'childAddress'), type, newNodePeer: await this.placement(newNodeAddress), newNodeAddress });
      return { ...inserted, address: newNodeAddress ?? null };
    }, (result) => ({ id: result.id, type, parentId: result.parentId, address: result.address }));
  }
  /** Moves a node and everything below it under a new parent. Only a move under itself is refused. */
  topologyRehome(context: CoreHostRequestContext, input: { nodeId: string; nodeAddress?: string; newParentId: string; newParentAddress?: string; administratorOverride?: boolean }) {
    const nodeId = this.text(input.nodeId, 'nodeId'), newParentId = this.text(input.newParentId, 'newParentId');
    return this.conversation(context, 'core.topology.node-rehomed', [nodeId, newParentId], (talk) => talk.rehome({ nodeId, nodeAddress: this.address(input.nodeAddress, 'nodeAddress'), newParentId, newParentAddress: this.address(input.newParentAddress, 'newParentAddress'), administratorOverride: input.administratorOverride === true }), (result) => ({ changed: result.changed, administratorOverride: input.administratorOverride === true }));
  }
  topologyRemove(context: CoreHostRequestContext, input: { nodeId: string; nodeAddress?: string; childrenParentId?: string; childrenParentAddress?: string }) {
    const nodeId = this.text(input.nodeId, 'nodeId');
    const childrenParentId = input.childrenParentId ? this.text(input.childrenParentId, 'childrenParentId') : undefined;
    return this.conversation(context, 'core.topology.node-removed', [nodeId, ...(childrenParentId ? [childrenParentId] : [])], (talk) => talk.remove({ nodeId, nodeAddress: this.address(input.nodeAddress, 'nodeAddress'), childrenParentId, childrenParentAddress: childrenParentId ? this.address(input.childrenParentAddress, 'childrenParentAddress') : undefined }), (result) => ({ parentId: result.parentId ?? null, childCount: result.childCount }));
  }
  /** Shortens a node's basis using the highest reachable ancestor, or the named one. */
  topologyRollUp(context: CoreHostRequestContext, input: { nodeId: string; nodeAddress?: string; issuerId?: string }) {
    const nodeId = this.text(input.nodeId, 'nodeId');
    return this.conversation(context, 'core.topology.node-rolled-up', [nodeId], (talk) => talk.rollUp({ nodeId, nodeAddress: this.address(input.nodeAddress, 'nodeAddress'), issuerId: input.issuerId ? this.text(input.issuerId, 'issuerId') : undefined }), (result) => ({ issuerId: result.issuerId, previousBasis: result.previousBasis, basis: result.basis }));
  }
  /** A child whose parent was retired follows the chain up and points itself at the nearest live ancestor. */
  topologyRepairParent(context: CoreHostRequestContext, input: { nodeId: string; nodeAddress?: string }) {
    const nodeId = this.text(input.nodeId, 'nodeId');
    return this.conversation(context, 'core.topology.parent-repaired', [nodeId], (talk) => talk.repairParent(nodeId, this.address(input.nodeAddress, 'nodeAddress')), (result) => ({ changed: result.changed }));
  }

  private async requireRead(context: CoreHostRequestContext, resource: string) {
    if (!(await this.authorization.canRead({ actorId: context.actorId, resource }))) throw new CoreHostAuthorizationError(`Core Host ${resource} access is not authorized`);
  }

  private async requireAdministration(context: CoreHostRequestContext, resource: string) {
    if (!(await this.authorization.canAdminister({ actorId: context.actorId, resource }))) throw new CoreHostAuthorizationError(`Core Host ${resource} administration is not authorized`);
  }
}
