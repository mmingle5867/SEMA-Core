import type { SemaCore } from '../core/sema-core.js';
import { SEMA_CORE_VERSION } from '../version.js';
import { CoreHostAuthorizationError, CoreHostLockedError, CoreHostValidationError } from './errors.js';
import type { CoreCapability, CoreCommand, CoreExecution, CoreLifecycleStatus, JsonObject } from '../core/types.js';
import type { CheckInRun, CoreHostAuthorization, CoreHostDocumentation, CoreHostRequestContext, CoreHostSettings, CoreHostStore, KeyLimitCheck, VersionedCoreHostSettings } from './types.js';
import { DEFAULT_CORE_HOST_SETTINGS } from './default-settings.js';
import { checkKeyLimits, isNodeType, type KeyLimits, type LocalNodes, type NodeType, type Shutdown, type Suspension } from '../topology/local-nodes.js';
import { Conversations, limitNotes, type AddressedPeers, type NodePeer } from '../topology/conversations.js';
import { encodeBase56 } from '../identity/base56.js';
import { TOP_LEVEL_BLOCK_COUNT, formatInstallCode, topLevelBlockRange } from './install-code.js';
import { FIRST_NODE_ID } from './join.js';

/** How this Core reaches the others: a directory of peers and the stable address other Cores use to reach this one. */
export interface CoreTopologyOptions {
  peers: AddressedPeers;
  address?: string;
  /** Reaches a Core that has no identity yet, to give it one. Needed only to install a new machine. */
  joining?: (address: string, joinCode: string) => NodePeer;
}

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
    const shutdown = await this.lockedBy();
    return { status: statistics.status, installationId: statistics.installationId, version: this.version, capturedAt: statistics.capturedAt, ...(shutdown ? { shutdown } : {}) };
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
        { method: 'GET', path: '/v1/core/topology/nodes', purpose: 'Describe a node held by this Core: type, parent, basis, number of children and status (query: id).' },
        { method: 'GET', path: '/v1/core/topology/nodes/children', purpose: 'List the direct children a node held by this Core believes it has (query: id).' },
        { method: 'POST', path: '/v1/core/topology/nodes/accept', purpose: 'Record a node on this machine from an ID that another Core issued. Its type (ORGANIZATION, GROUP, USER or MACHINE) is set here and never changes.' },
        { method: 'POST', path: '/v1/core/topology/nodes/issue-child', purpose: 'Issue the ID for a new child from a node\'s basis and put the child on its list in the same step.' },
        { method: 'POST', path: '/v1/core/topology/nodes/issue-basis', purpose: 'Issue a fresh value another node will adopt as its basis in a roll-up.' },
        { method: 'POST', path: '/v1/core/topology/nodes/set-parent', purpose: 'Change a node\'s parent pointer.' },
        { method: 'POST', path: '/v1/core/topology/nodes/set-basis', purpose: 'Adopt a shorter basis after a roll-up and restart its counter.' },
        { method: 'POST', path: '/v1/core/topology/nodes/add-children', purpose: 'Add children to a node\'s list, or update entries already there.' },
        { method: 'POST', path: '/v1/core/topology/nodes/remove-child', purpose: 'Take one child off a node\'s list.' },
        { method: 'POST', path: '/v1/core/topology/nodes/child-list-complete', purpose: 'Say whether a node\'s list of children is known to be complete.' },
        { method: 'POST', path: '/v1/core/topology/nodes/retire', purpose: 'Retire a node and return its list of children so the parent can take them.' },
        { method: 'GET', path: '/v1/core/topology/local', purpose: 'List the nodes this Core holds, each with the next ID it would issue, and the address other Cores use to reach it.' },
        { method: 'GET', path: '/v1/core/topology/walk-up', purpose: 'Walk up from a node by asking each parent in turn (query: nodeId, nodeAddress).' },
        { method: 'GET', path: '/v1/core/topology/walk-down', purpose: 'Walk down from a node by asking each Core for its children, with each node\'s last check-in (query: nodeId, nodeAddress, view = organization or global, maxDepth).' },
        { method: 'POST', path: '/v1/core/topology/create', purpose: 'Create a node of a given type (ORGANIZATION, GROUP, USER or MACHINE) under a parent, here or on another machine: installs a machine or adds a user.' },
        { method: 'POST', path: '/v1/core/authority/install-codes', purpose: 'Assign the first ID of a new system from the block this Core holds, and return the install code that carries it. Needs core.authority.issue-install-code.' },
        { method: 'GET', path: '/v1/core/authority/block', purpose: 'Read the block of first IDs this Core may assign, and how many are left.' },
        { method: 'POST', path: '/v1/core/authority/block', purpose: 'Give this Core a block of first IDs, so a standby can carry on if the original system is lost. Needs core.authority.grant-block.' },
        { method: 'POST', path: '/v1/core/topology/install-machine', purpose: 'Install a new machine: issue a node ID from a parent and give it to a Core that has no identity yet, using that machine\'s join code.' },
        { method: 'POST', path: '/v1/core/topology/insert-above', purpose: 'Insert a new node of a given type (ORGANIZATION, GROUP, USER or MACHINE) between a node and its parent.' },
        { method: 'POST', path: '/v1/core/topology/add-parent-above', purpose: 'Add a parent above a top node, so the tree grows from the ground up. Needs the permission core.authority.add-top.' },
        { method: 'POST', path: '/v1/core/topology/replace-lost', purpose: 'Record that a node was lost and name the node that replaced it; its children follow the retired record to the replacement. Needs the permission core.authority.replace-lost.' },
        { method: 'POST', path: '/v1/core/topology/nodes/accept-retired', purpose: 'Record the old ID of a lost node as retired, pointing at its replacement. Used between Cores during replace-lost; needs core.authority.replace-lost.' },
        { method: 'POST', path: '/v1/core/topology/key-limits', purpose: 'Set, change or clear an organization\'s optional key limits: maxSegments, maxSegmentLength, maxLastSegmentLength. A roll-up may leave the organization only when the basis has more segments than maxSegments.' },
        { method: 'POST', path: '/v1/core/topology/nodes/key-limits', purpose: 'Set, change or clear the key limits on an organization node held here. Used between Cores during key-limits.' },
        { method: 'POST', path: '/v1/core/topology/nodes/next-basis', purpose: 'Keep a basis fetched early on a node held here, ready to take over when its counter would pass switchAt. Used between Cores.' },
        { method: 'POST', path: '/v1/core/topology/suspend', purpose: 'Suspend a node: its parent marks it, and its own Core locks itself and stays readable. Suspending a machine node locks that whole Core. Nodes below lock at their next check-in. Needs core.authority.suspend.' },
        { method: 'POST', path: '/v1/core/topology/resume', purpose: 'Resume a suspended node: clear its parent\'s mark and its own lock. Nodes below unlock at their next check-in. Needs core.authority.resume.' },
        { method: 'POST', path: '/v1/core/topology/seat-limits', purpose: 'Set or clear an organization\'s allowed numbers of user and machine seats (users, machines; null clears). A division cannot allow more than its parent organization. Needs core.authority.seats.' },
        { method: 'POST', path: '/v1/core/topology/recount-seats', purpose: 'Count an organization\'s seats again by walking down its lists; lowers a count only when everything answered.' },
        { method: 'POST', path: '/v1/core/topology/nodes/seat-change', purpose: 'Take seats on an organization node held here, or give them back (negative). Used between Cores.' },
        { method: 'POST', path: '/v1/core/topology/nodes/seat-limits', purpose: 'Set the allowed numbers of seats on an organization node held here. Used between Cores; needs core.authority.seats.' },
        { method: 'POST', path: '/v1/core/topology/nodes/seat-count', purpose: 'Set the seats in use on an organization node held here from a recount. Used between Cores.' },
        { method: 'POST', path: '/v1/core/topology/retire-away', purpose: 'Retire a user or machine that cannot be reached, for good: its parent keeps the entry marked retired, so it is refused if it comes back and its ID is never used again. Needs core.authority.retire.' },
        { method: 'POST', path: '/v1/core/topology/nodes/retire-child', purpose: 'Mark a child on a node\'s list as retired while it cannot be reached. Used between Cores during retire-away; needs core.authority.retire.' },
        { method: 'POST', path: '/v1/core/topology/nodes/shutdown', purpose: 'Lock a node held here, or clear its lock (null). Used between Cores; clearing needs core.authority.resume.' },
        { method: 'POST', path: '/v1/core/topology/nodes/mark-child', purpose: 'Mark a child on a node\'s list as suspended, or clear the mark (null). Used between Cores; clearing needs core.authority.resume.' },
        { method: 'POST', path: '/v1/core/topology/nodes/check-in', purpose: 'A child checks in with a node held here, its parent: the time is stamped on its entry, which is added if missing. A retired parent answers with its own pointer. Used between Cores.' },
        { method: 'GET', path: '/v1/core/topology/check-in-status', purpose: 'The last round of check-ins by the nodes this Core holds, each with its own parent, or null before the first round.' },
        { method: 'POST', path: '/v1/core/topology/check-in', purpose: 'Check in now: every active node this Core holds checks in with its own parent. Returns the report.' },
        { method: 'GET', path: '/v1/core/topology/key-limit-status', purpose: 'The last report of the check that fetches a ready basis before a node reaches its organization\'s length limit, or null before the first run.' },
        { method: 'POST', path: '/v1/core/topology/key-limit-check', purpose: 'Run that check now and return its report.' },
        { method: 'POST', path: '/v1/core/topology/adopt-issued', purpose: 'Make an ID this Core already issued, and took into use as the same type, into a node, keeping the ID, so nothing pointing at it is renumbered. Needs the permission core.authority.adopt-issued.' },
        { method: 'POST', path: '/v1/core/topology/rehome', purpose: 'Move a node and everything below it under a new parent.' },
        { method: 'POST', path: '/v1/core/topology/remove', purpose: 'Retire a node for good; its children follow its pointer to the nearest live ancestor. Needs core.authority.retire.' },
        { method: 'POST', path: '/v1/core/topology/roll-up', purpose: 'Shorten a node\'s basis using a reachable ancestor.' },
        { method: 'POST', path: '/v1/core/topology/repair-parent', purpose: 'Point a node whose parent was retired at its nearest live ancestor, adding it to that ancestor\'s list.' },
        { method: 'POST', path: '/v1/core/topology/check-children', purpose: 'Check a node\'s list against its children\'s own pointers; drop an entry only when the child names a different parent or says it is retired.' },
        { method: 'POST', path: '/v1/core/topology/mark-child-list', purpose: 'An administrator says whether a node\'s list of children is complete.' },
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

  /** The block this Core holds. The original system holds block 0 without being given it. */
  private async firstIdBlock() {
    const held = await this.store.topLevelBlock();
    if (held) return held;
    if ((await this.store.getHostStatistics()).installationId !== FIRST_NODE_ID) return undefined;
    const range = topLevelBlockRange(0);
    await this.store.grantTopLevelBlock({ block: 0, ...range });
    return this.store.topLevelBlock();
  }
  private describeBlock(held: { block: number; issued: bigint; end: bigint }) {
    const remaining = held.end - held.issued - BigInt(1);
    return { block: held.block, firstId: encodeBase56(topLevelBlockRange(held.block).start), lastId: encodeBase56(held.end - BigInt(1)), nextId: remaining > BigInt(0) ? encodeBase56(held.issued + BigInt(1)) : null, remaining: Number(remaining) };
  }
  /** The block of first IDs this Core may assign, or null when it holds none. */
  async firstIdBlockStatus(context: CoreHostRequestContext) {
    await this.requireRead(context, 'core.authority.read');
    const held = await this.firstIdBlock();
    return held ? this.describeBlock(held) : null;
  }
  /**
   * Gives this Core a block of first IDs, so it can assign them to new systems. This is the failsafe for losing
   * the original system: a standby holds a different block and simply carries on. A block must never be given to
   * two Cores. Until the keyholders' signed list records the grants, that is tracked by hand, so this has its own
   * permission, `core.authority.grant-block`, which nobody holds by default. Refused while this Core still has
   * values left in a block it holds.
   */
  async grantFirstIdBlock(context: CoreHostRequestContext, input: { block: number; note?: string }) {
    await this.requireAdministration(context, 'core.authority.grant-block');
    const note = input.note === undefined || input.note === null || input.note === '' ? undefined : this.text(input.note, 'note');
    if (typeof input.block !== 'number' || !Number.isSafeInteger(input.block) || input.block < 0 || input.block >= TOP_LEVEL_BLOCK_COUNT) throw new CoreHostValidationError(`block must be a whole number from 0 to ${TOP_LEVEL_BLOCK_COUNT - 1}`);
    const original = (await this.store.getHostStatistics()).installationId === FIRST_NODE_ID;
    if (input.block === 0 && !original) throw new CoreHostValidationError(`Block 0 belongs to the original system, node ${FIRST_NODE_ID}`);
    const held = await this.firstIdBlock();
    if (held && held.issued + BigInt(1) < held.end) throw new CoreHostValidationError(`This Core already holds block ${held.block}, which still has values left`);
    if (held && held.block === input.block) throw new CoreHostValidationError(`Block ${input.block} is used up. Grant a different block`);
    await this.store.grantTopLevelBlock({ block: input.block, ...topLevelBlockRange(input.block) });
    const granted = this.describeBlock((await this.store.topLevelBlock())!);
    await this.core.recordAudit({ action: 'core.authority.block-granted', actorId: context.actorId, subjectIds: [], evidence: { block: granted.block, firstId: granted.firstId, lastId: granted.lastId, ...(note ? { note } : {}) } });
    return granted;
  }
  /**
   * Assigns the first ID of a new system and returns the install code that carries it. The IDs `3` to `zzzzz`
   * are reserved and given out one at a time from the block this Core holds, so a Core with no block cannot.
   * It has its own permission, `core.authority.issue-install-code`, which nobody holds by default.
   * The code is used once, on the first machine of the new system.
   */
  async issueInstallCode(context: CoreHostRequestContext, input: { note?: string } = {}) {
    await this.requireAdministration(context, 'core.authority.issue-install-code');
    const note = input.note === undefined || input.note === null || input.note === '' ? undefined : this.text(input.note, 'note');
    const held = await this.firstIdBlock();
    if (!held) throw new CoreHostValidationError('This Core holds no block of first IDs, so it cannot assign one. A block must be granted to it first');
    const value = await this.store.issueTopLevelValue();
    if (value === undefined) throw new CoreHostValidationError(`Block ${held.block} is used up. A new block must be granted to this Core`);
    const id = encodeBase56(value);
    await this.core.recordAudit({ action: 'core.authority.install-code-issued', actorId: context.actorId, subjectIds: [id], evidence: { block: held.block, ...(note ? { note } : {}) } });
    return { id, installCode: formatInstallCode(id), block: held.block, remaining: Number(held.end - value - BigInt(1)) };
  }

  // Nodes held by this Core. Operations across machines are conversations between Cores built from these.
  private requireNodes() { if (!this.localNodes) throw new CoreHostValidationError('Local nodes are not enabled on this Core'); return this.localNodes; }
  private keyLimits(value: unknown) { try { return checkKeyLimits(value); } catch (error) { throw new CoreHostValidationError(error instanceof Error ? error.message : 'Invalid key limits'); } }
  private text(value: unknown, name: string) { if (typeof value !== 'string' || !value.trim()) throw new CoreHostValidationError(`${name} must be a non-empty string`); return value.trim(); }
  private nodeType(value: unknown): NodeType { if (!isNodeType(value)) throw new CoreHostValidationError('type must be ORGANIZATION, GROUP, SITE, USER or MACHINE'); return value; }
  private async nodeChange<T>(context: CoreHostRequestContext, action: string, subjectIds: string[], work: (nodes: LocalNodes) => Promise<T>, evidence: (result: T) => JsonObject = () => ({}), permission = 'core.topology.write', whileLocked = false) {
    await this.requireAdministration(context, permission, whileLocked);
    const result = await work(this.requireNodes());
    await this.core.recordAudit({ action, actorId: context.actorId, subjectIds, evidence: evidence(result) });
    return result;
  }
  /** What any authorized caller, including another Core walking up the tree, may learn about a node held here. */
  async nodeDescribe(context: CoreHostRequestContext, input: { id: string }) { await this.requireRead(context, 'core.topology.read'); return (await this.requireNodes().describe(this.text(input.id, 'id'))) ?? null; }
  nodeAccept(context: CoreHostRequestContext, input: { id: string; type: NodeType; parentId?: string; parentAddress?: string }) { const id = this.text(input.id, 'id'); const type = this.nodeType(input.type); const parentId = input.parentId === undefined ? undefined : this.text(input.parentId, 'parentId'); const parentAddress = input.parentAddress === undefined ? undefined : this.text(input.parentAddress, 'parentAddress'); return this.nodeChange(context, 'core.topology.node-accepted', [id, ...(parentId ? [parentId] : [])], (nodes) => nodes.accept({ id, type, parentId, parentAddress }), (result) => ({ type: result.type })); }
  /** The children a node held here believes it has. Read by another Core removing or checking the node. */
  async nodeChildren(context: CoreHostRequestContext, input: { id: string }) { await this.requireRead(context, 'core.topology.read'); return this.requireNodes().children(this.text(input.id, 'id')); }
  nodeIssueChild(context: CoreHostRequestContext, input: { nodeId: string; type: NodeType; address?: string }) { const nodeId = this.text(input.nodeId, 'nodeId'), type = this.nodeType(input.type); const address = input.address === undefined || input.address === null ? undefined : this.text(input.address, 'address'); return this.nodeChange(context, 'core.topology.child-id-issued', [nodeId], (nodes) => nodes.issueChildId(nodeId, { type, address }), (result) => ({ value: result.value, type, childCount: result.childCount })); }
  nodeIssueBasis(context: CoreHostRequestContext, input: { nodeId: string }) { const nodeId = this.text(input.nodeId, 'nodeId'); return this.nodeChange(context, 'core.topology.basis-issued', [nodeId], (nodes) => nodes.issueBasis(nodeId), (result) => ({ value: result.value })); }
  nodeSetParent(context: CoreHostRequestContext, input: { nodeId: string; parentId: string; parentAddress?: string }) { const nodeId = this.text(input.nodeId, 'nodeId'); const parentId = this.text(input.parentId, 'parentId'); const parentAddress = input.parentAddress === undefined ? undefined : this.text(input.parentAddress, 'parentAddress'); return this.nodeChange(context, 'core.topology.parent-set', [nodeId, parentId], (nodes) => nodes.setParent(nodeId, parentId, parentAddress)); }
  nodeSetBasis(context: CoreHostRequestContext, input: { nodeId: string; basis: string }) { const nodeId = this.text(input.nodeId, 'nodeId'); const basis = this.text(input.basis, 'basis'); return this.nodeChange(context, 'core.topology.basis-set', [nodeId], (nodes) => nodes.setBasis(nodeId, basis), (result) => ({ previousBasis: result.previousBasis, basis: result.basis })); }
  private childEntries(value: unknown) { if (!Array.isArray(value)) throw new CoreHostValidationError('children must be a list'); return value.map((child: { childId?: unknown; type?: unknown; address?: unknown }) => ({ childId: this.text(child?.childId, 'childId'), type: this.nodeType(child?.type), ...(child?.address === undefined || child?.address === null ? {} : { address: this.text(child.address, 'address') }) })); }
  nodeAddChildren(context: CoreHostRequestContext, input: { nodeId: string; children: unknown }) { const nodeId = this.text(input.nodeId, 'nodeId'), children = this.childEntries(input.children); return this.nodeChange(context, 'core.topology.children-added', [nodeId, ...children.map((child) => child.childId)], (nodes) => nodes.addChildren(nodeId, children), (result) => ({ added: children.length, childCount: result.childCount })); }
  nodeRemoveChild(context: CoreHostRequestContext, input: { nodeId: string; childId: string }) { const nodeId = this.text(input.nodeId, 'nodeId'), childId = this.text(input.childId, 'childId'); return this.nodeChange(context, 'core.topology.child-removed', [nodeId, childId], (nodes) => nodes.removeChild(nodeId, childId), (result) => ({ removed: result.removed, childCount: result.childCount })); }
  nodeSetChildListComplete(context: CoreHostRequestContext, input: { nodeId: string; complete: boolean }) { const nodeId = this.text(input.nodeId, 'nodeId'); if (typeof input.complete !== 'boolean') throw new CoreHostValidationError('complete must be true or false'); return this.nodeChange(context, 'core.topology.child-list-marked', [nodeId], (nodes) => nodes.setChildListComplete(nodeId, input.complete), () => ({ complete: input.complete })); }
  /** Sets, changes or clears the key limits on an organization node held here. Another Core asks this for a key-limits operation. */
  nodeSetKeyLimits(context: CoreHostRequestContext, input: { nodeId: string; limits?: KeyLimits | null }) { const nodeId = this.text(input.nodeId, 'nodeId'); const limits = this.keyLimits(input.limits); return this.nodeChange(context, 'core.topology.key-limits-set', [nodeId], (nodes) => nodes.setKeyLimits(nodeId, limits), (result) => ({ keyLimits: (result.keyLimits ?? null) as JsonObject | null })); }
  /** Keeps a basis fetched early on a node held here, ready to take over. Another Core asks this while preparing a ready basis. */
  nodeSetNextBasis(context: CoreHostRequestContext, input: { nodeId: string; basis: string; switchAt: string }) { const nodeId = this.text(input.nodeId, 'nodeId'), basis = this.text(input.basis, 'basis'); return this.nodeChange(context, 'core.topology.next-basis-kept', [nodeId], (nodes) => nodes.setNextBasis(nodeId, { basis, switchAt: String(input.switchAt) }), (result) => ({ nextBasis: result.nextBasis ?? null, switchAt: result.switchAt ?? null })); }
  /** Records a lost node's old ID as retired, pointing at its replacement. Another Core asks this during replace-lost; it needs the same permission. */
  nodeAcceptRetired(context: CoreHostRequestContext, input: { id: string; type: NodeType; replacementId: string; replacementAddress?: string }) { const id = this.text(input.id, 'id'), type = this.nodeType(input.type), replacementId = this.text(input.replacementId, 'replacementId'); const replacementAddress = input.replacementAddress === undefined ? undefined : this.text(input.replacementAddress, 'replacementAddress'); return this.nodeChange(context, 'core.topology.lost-node-recorded', [id, replacementId], (nodes) => nodes.acceptRetired({ id, type, replacementId, replacementAddress }), () => ({ type, replacementId }), 'core.authority.replace-lost'); }
  /**
   * A child checks in with a node held here. Routine, so an ordinary check-in is not audited; adding a missing entry is,
   * because it changes the list.
   */
  async nodeCheckIn(context: CoreHostRequestContext, input: { nodeId: string; childId: string; type: NodeType; address?: string }) {
    const nodeId = this.text(input.nodeId, 'nodeId'), childId = this.text(input.childId, 'childId'), type = this.nodeType(input.type);
    const address = input.address === undefined || input.address === null ? undefined : this.text(input.address, 'address');
    await this.requireAdministration(context, 'core.topology.write', true); // a locked Core still answers, so its children learn it
    const answer = await this.requireNodes().checkIn(nodeId, { childId, type, ...(address ? { address } : {}) });
    if (answer.status === 'ACTIVE' && answer.added) await this.core.recordAudit({ action: 'core.topology.child-added-by-check-in', actorId: context.actorId, subjectIds: [nodeId, childId], evidence: { type } });
    return answer;
  }
  private shutdownInput(value: unknown): Shutdown | null {
    if (value === null || value === undefined) return null;
    const v = value as Partial<Shutdown>;
    if (typeof v !== 'object' || v.via !== 'ORDER' && v.via !== 'PARENT') throw new CoreHostValidationError('shutdown must be null or { nodeId, reason, by?, at, via: ORDER or PARENT }');
    return { nodeId: this.text(v.nodeId, 'shutdown.nodeId'), reason: this.text(v.reason, 'shutdown.reason'), ...(typeof v.by === 'string' && v.by ? { by: v.by } : {}), at: this.text(v.at, 'shutdown.at'), via: v.via };
  }
  private suspensionInput(value: unknown): Suspension | null {
    if (value === null || value === undefined) return null;
    const v = value as Partial<Suspension>;
    return { reason: this.text(v.reason, 'suspension.reason'), ...(typeof v.by === 'string' && v.by ? { by: v.by } : {}), at: this.text(v.at, 'suspension.at') };
  }
  /** Locks a node held here, or clears its lock. Another Core asks this while suspending, resuming or checking in. Locking leans the safe way; clearing needs the resume permission. */
  nodeSetShutdown(context: CoreHostRequestContext, input: { nodeId: string; shutdown?: unknown }) {
    const nodeId = this.text(input.nodeId, 'nodeId'), shutdown = this.shutdownInput(input.shutdown);
    return this.nodeChange(context, shutdown ? 'core.topology.node-locked' : 'core.topology.node-unlocked', [nodeId, ...(shutdown && shutdown.nodeId !== nodeId ? [shutdown.nodeId] : [])], (nodes) => nodes.setShutdown(nodeId, shutdown), (): JsonObject => (shutdown ? { reason: shutdown.reason, via: shutdown.via } : {}), shutdown ? 'core.topology.write' : 'core.authority.resume', true);
  }
  /** Marks a child on a node's list as suspended, or clears the mark. Another Core asks this while suspending or resuming. */
  nodeMarkChild(context: CoreHostRequestContext, input: { nodeId: string; childId: string; type?: NodeType; address?: string; suspension?: unknown }) {
    const nodeId = this.text(input.nodeId, 'nodeId'), childId = this.text(input.childId, 'childId'), suspension = this.suspensionInput(input.suspension);
    const type = input.type === undefined || input.type === null ? undefined : this.nodeType(input.type);
    const address = input.address === undefined || input.address === null ? undefined : this.text(input.address, 'address');
    return this.nodeChange(context, suspension ? 'core.topology.child-marked-suspended' : 'core.topology.child-mark-cleared', [nodeId, childId], (nodes) => nodes.markChild(nodeId, { childId, ...(type ? { type } : {}), ...(address ? { address } : {}) }, suspension), (result) => ({ marked: result.marked }), suspension ? 'core.topology.write' : 'core.authority.resume', true);
  }
  /** Marks a child on a node's list as retired while it cannot be reached. Another Core asks this during retire-away; it needs the same permission. */
  nodeRetireChild(context: CoreHostRequestContext, input: { nodeId: string; childId: string; type?: NodeType; address?: string; retired?: unknown }) {
    const nodeId = this.text(input.nodeId, 'nodeId'), childId = this.text(input.childId, 'childId'), retired = this.suspensionInput(input.retired);
    if (!retired) throw new CoreHostValidationError('retired must be { reason, by?, at }');
    const type = input.type === undefined || input.type === null ? undefined : this.nodeType(input.type);
    const address = input.address === undefined || input.address === null ? undefined : this.text(input.address, 'address');
    return this.nodeChange(context, 'core.topology.child-retired-away', [nodeId, childId], (nodes) => nodes.retireChild(nodeId, { childId, ...(type ? { type } : {}), ...(address ? { address } : {}) }, retired), () => ({ reason: retired.reason }), 'core.authority.retire', true);
  }
  private seatNumber(value: unknown, name: string) { if (value === undefined) return undefined; if (value === null) return null; if (!Number.isInteger(value)) throw new CoreHostValidationError(`${name} must be a whole number, or null to clear it`); return value as number; }
  /** Takes or gives back seats on an organization node held here. Another Core asks this while adding, moving or removing a user or machine. */
  nodeSeatChange(context: CoreHostRequestContext, input: { nodeId: string; users?: number; machines?: number }) {
    const nodeId = this.text(input.nodeId, 'nodeId'), users = this.seatNumber(input.users, 'users') ?? undefined, machines = this.seatNumber(input.machines, 'machines') ?? undefined;
    return this.nodeChange(context, 'core.topology.seats-changed', [nodeId], (nodes) => nodes.changeSeats(nodeId, { ...(users !== undefined ? { users } : {}), ...(machines !== undefined ? { machines } : {}) }), () => ({ ...(users !== undefined ? { users } : {}), ...(machines !== undefined ? { machines } : {}) }));
  }
  /** Sets the allowed numbers of seats on an organization node held here. Another Core asks this for seat-limits; it needs the same permission. */
  nodeSeatLimits(context: CoreHostRequestContext, input: { nodeId: string; users?: number | null; machines?: number | null }) {
    const nodeId = this.text(input.nodeId, 'nodeId'), users = this.seatNumber(input.users, 'users'), machines = this.seatNumber(input.machines, 'machines');
    return this.nodeChange(context, 'core.topology.seat-limits-set', [nodeId], (nodes) => nodes.setSeatLimits(nodeId, { ...(users !== undefined ? { users } : {}), ...(machines !== undefined ? { machines } : {}) }), (seats) => ({ usersAllowed: seats.users.allowed ?? null, machinesAllowed: seats.machines.allowed ?? null }), 'core.authority.seats');
  }
  /** Sets the seats in use on an organization node held here from a recount. */
  nodeSeatCount(context: CoreHostRequestContext, input: { nodeId: string; users: number; machines: number; complete: boolean }) {
    const nodeId = this.text(input.nodeId, 'nodeId');
    if (typeof input.complete !== 'boolean') throw new CoreHostValidationError('complete must be true or false');
    return this.nodeChange(context, 'core.topology.seats-recounted', [nodeId], (nodes) => nodes.setSeatsUsed(nodeId, { users: input.users, machines: input.machines }, input.complete), (seats) => ({ usersUsed: seats.users.used, machinesUsed: seats.machines.used, complete: input.complete }));
  }
  nodeRetire(context: CoreHostRequestContext, input: { nodeId: string }) { const nodeId = this.text(input.nodeId, 'nodeId'); return this.nodeChange(context, 'core.topology.node-retired', [nodeId], (nodes) => nodes.retire(nodeId), (result) => ({ parentId: result.parentId ?? null, childCount: result.children.length })); }

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
  private async conversation<T>(context: CoreHostRequestContext, action: string, subjectIds: string[], work: (talk: Conversations) => Promise<T>, evidence: (result: T) => JsonObject = () => ({}), permission = 'core.topology.write', whileLocked = false) {
    await this.requireAdministration(context, permission, whileLocked);
    const result = await work(this.conversations());
    await this.core.recordAudit({ action, actorId: context.actorId, subjectIds, evidence: evidence(result) });
    return result;
  }
  /** The nodes this Core holds, with the address others use to reach it. */
  async topologyLocal(context: CoreHostRequestContext) { await this.requireRead(context, 'core.topology.read'); return { address: this.ownAddress() ?? null, nodes: await this.requireNodes().listWithNextId() }; }
  /** Walks up from a node, one parent at a time, stopping where a machine cannot be reached. */
  /** Walks down from a node: inside its organization, or across organizations (global). Read-only. */
  async topologyWalkDown(context: CoreHostRequestContext, input: { nodeId: string; nodeAddress?: string; view?: string; maxDepth?: string | number }) {
    await this.requireRead(context, 'core.topology.read');
    const view = input.view === undefined || input.view === '' ? 'organization' : input.view;
    if (view !== 'organization' && view !== 'global') throw new CoreHostValidationError('view must be organization or global');
    const maxDepth = input.maxDepth === undefined || input.maxDepth === '' ? undefined : Number(input.maxDepth);
    if (maxDepth !== undefined && !(Number.isInteger(maxDepth) && maxDepth >= 0 && maxDepth <= 50)) throw new CoreHostValidationError('maxDepth must be a whole number from 0 to 50');
    return this.conversations().walkDown({ nodeId: this.text(input.nodeId, 'nodeId'), nodeAddress: this.address(input.nodeAddress, 'nodeAddress'), view, ...(maxDepth !== undefined ? { maxDepth } : {}) });
  }
  async topologyWalkUp(context: CoreHostRequestContext, input: { nodeId: string; nodeAddress?: string }) { await this.requireRead(context, 'core.topology.read'); return this.conversations().walkUp(this.text(input.nodeId, 'nodeId'), this.address(input.nodeAddress, 'nodeAddress')); }
  /** Creates a node under a parent, on this machine or on the Core at newNodeAddress. Installing a machine and adding a user are this operation. */
  topologyCreate(context: CoreHostRequestContext, input: { parentId: string; parentAddress?: string; type: NodeType; newNodeAddress?: string }) {
    const parentId = this.text(input.parentId, 'parentId'), type = this.nodeType(input.type);
    return this.conversation(context, 'core.topology.node-created', [parentId], async (talk) => {
      const parentAddress = this.address(input.parentAddress, 'parentAddress');
      const newNodeAddress = this.address(input.newNodeAddress, 'newNodeAddress');
      const created = await talk.createNode({ parentId, parentAddress, type, newNodePeer: await this.placement(newNodeAddress), newNodeAddress });
      return { ...created, address: newNodeAddress ?? null };
    }, (result) => ({ id: result.id, type, parentId, address: result.address }));
  }
  /**
   * Installs a new machine: gives a Core that has no identity yet its node ID. The parent's Core issues the ID
   * and counts the child, as for any node, and the new Core records it as its own machine node. Nobody types an ID.
   * The join code proves the request comes from the person who set that machine up. It is never recorded.
   * The new Core must be able to reach its parent afterwards, so the parent's address has to be known.
   */
  topologyInstallMachine(context: CoreHostRequestContext, input: { parentId: string; parentAddress?: string; newCoreAddress: string; joinCode: string }) {
    const parentId = this.text(input.parentId, 'parentId'), newCoreAddress = this.text(input.newCoreAddress, 'newCoreAddress').replace(/\/$/, ''), joinCode = this.text(input.joinCode, 'joinCode');
    return this.conversation(context, 'core.topology.machine-installed', [parentId], async (talk) => {
      const joining = this.topology?.joining;
      if (!joining) throw new CoreHostValidationError('This Core is not set up to install new machines');
      if (newCoreAddress === this.ownAddress()) throw new CoreHostValidationError('The new machine cannot be this Core');
      const parentAddress = this.address(input.parentAddress, 'parentAddress');
      if (!parentAddress) throw new CoreHostValidationError('The new machine must be able to reach its parent. Set SEMA_CORE_ADDRESS on this Core, or give parentAddress');
      const created = await talk.createNode({ parentId, parentAddress, type: 'MACHINE', newNodePeer: joining(newCoreAddress, joinCode), newNodeAddress: newCoreAddress });
      return { ...created, address: newCoreAddress };
    }, (result) => ({ id: result.id, type: 'MACHINE', parentId, address: result.address }));
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
  /**
   * Adds a parent above a top node. This is a change at the top of the tree, so it has its own permission,
   * `core.authority.add-top`, which no grant of `core.topology.*` covers. It is granted by hand for the one
   * occasion until keyholder signatures replace it. The new ID is issued by the node named, or by the one with
   * the shortest basis among the top node and the active nodes this Core holds.
   */
  topologyAddParentAbove(context: CoreHostRequestContext, input: { nodeId: string; nodeAddress?: string; type: NodeType; newNodeAddress?: string; issuerId?: string; issuerAddress?: string }) {
    const nodeId = this.text(input.nodeId, 'nodeId'), type = this.nodeType(input.type);
    const issuerId = input.issuerId ? this.text(input.issuerId, 'issuerId') : undefined;
    return this.conversation(context, 'core.topology.parent-added-above-top', [nodeId, ...(issuerId ? [issuerId] : [])], async (talk) => {
      const newNodeAddress = this.address(input.newNodeAddress, 'newNodeAddress');
      const alsoConsider = (await this.requireNodes().list()).filter((node) => node.status === 'ACTIVE').map((node) => ({ id: node.id, basis: node.basis, address: this.ownAddress() }));
      const added = await talk.addParentAbove({ nodeId, nodeAddress: this.address(input.nodeAddress, 'nodeAddress'), type, newNodePeer: await this.placement(newNodeAddress), newNodeAddress, issuerId, issuerAddress: issuerId ? this.address(input.issuerAddress, 'issuerAddress') : undefined, alsoConsider });
      return { ...added, type, address: newNodeAddress ?? null };
    }, (result) => ({ id: result.id, type, childId: result.childId, issuerId: result.issuerId, address: result.address }), 'core.authority.add-top');
  }
  /**
   * Records that a node was lost and names the node that replaced it. The replacement is created first, like any
   * other node. Pointing a lost node's children at another node is a powerful act, so this has its own permission,
   * `core.authority.replace-lost`, which no grant of `core.topology.*` covers and nobody holds by default.
   */
  topologyReplaceLost(context: CoreHostRequestContext, input: { lostId: string; type: NodeType; replacementId: string; replacementAddress?: string; lostParentId?: string; lostParentAddress?: string }) {
    const lostId = this.text(input.lostId, 'lostId'), type = this.nodeType(input.type), replacementId = this.text(input.replacementId, 'replacementId');
    const lostParentId = input.lostParentId ? this.text(input.lostParentId, 'lostParentId') : undefined;
    return this.conversation(context, 'core.topology.lost-node-replaced', [lostId, replacementId, ...(lostParentId ? [lostParentId] : [])], (talk) => talk.replaceLost({ lostId, type, replacementId, replacementAddress: this.address(input.replacementAddress, 'replacementAddress'), lostParentId, lostParentAddress: lostParentId ? this.address(input.lostParentAddress, 'lostParentAddress') : undefined }), (result) => ({ type, replacementId, lostParentId: lostParentId ?? null, oldParentListStale: result.oldParentListStale }), 'core.authority.replace-lost');
  }
  /**
   * Makes an ID this Core already issued into a node, keeping the ID, so nothing that already points at it has to
   * be renumbered. Used for records made before they were nodes, such as an organization or a user first recorded
   * in Foundation Access. Refused unless this Core issued the ID, it was taken into use, it was issued as the same
   * type, and it is not a node yet. It has its own permission, `core.authority.adopt-issued`, which no grant of
   * `core.topology.*` covers and nobody holds by default.
   */
  topologyAdoptIssued(context: CoreHostRequestContext, input: { id: string; type: NodeType; parentId?: string; parentAddress?: string; nodeAddress?: string }) {
    const id = this.text(input.id, 'id'), type = this.nodeType(input.type);
    const parentId = input.parentId ? this.text(input.parentId, 'parentId') : undefined;
    return this.conversation(context, 'core.authority.issued-id-adopted', [id, ...(parentId ? [parentId] : [])], async (talk) => {
      const issued = await this.store.issuedIdentifier(id);
      if (!issued) throw new CoreHostValidationError(`${id} was not issued by this Core`); // only this Core writes its own issued records, whatever basis the ID came from
      if (issued.status !== 'ISSUED') throw new CoreHostValidationError(`${id} was reserved but never taken into use`);
      if (issued.typeCode !== type) throw new CoreHostValidationError(`${id} was issued as ${issued.typeCode ?? 'no type'}, not ${type}`);
      const nodeAddress = this.address(input.nodeAddress, 'nodeAddress');
      const placed = await talk.placeIssued({ id, type, parentId, parentAddress: parentId ? this.address(input.parentAddress, 'parentAddress') : undefined, nodePeer: await this.placement(nodeAddress), nodeAddress });
      return { ...placed, address: nodeAddress ?? null };
    }, (result) => ({ type, parentId: parentId ?? null, address: result.address }), 'core.authority.adopt-issued');
  }
  /** Moves a node and everything below it under a new parent. Only a move under itself is refused. */
  topologyRehome(context: CoreHostRequestContext, input: { nodeId: string; nodeAddress?: string; newParentId: string; newParentAddress?: string; administratorOverride?: boolean }) {
    const nodeId = this.text(input.nodeId, 'nodeId'), newParentId = this.text(input.newParentId, 'newParentId');
    return this.conversation(context, 'core.topology.node-rehomed', [nodeId, newParentId], (talk) => talk.rehome({ nodeId, nodeAddress: this.address(input.nodeAddress, 'nodeAddress'), newParentId, newParentAddress: this.address(input.newParentAddress, 'newParentAddress'), administratorOverride: input.administratorOverride === true }), (result) => ({ changed: result.changed, administratorOverride: input.administratorOverride === true, oldParentListStale: result.changed ? result.oldParentListStale : false }));
  }
  /** Retires a node for good. Retiring takes more authority than suspending, so it has its own permission, held by nobody by default. */
  topologyRemove(context: CoreHostRequestContext, input: { nodeId: string; nodeAddress?: string; childrenParentId?: string; childrenParentAddress?: string }) {
    const nodeId = this.text(input.nodeId, 'nodeId');
    const childrenParentId = input.childrenParentId ? this.text(input.childrenParentId, 'childrenParentId') : undefined;
    return this.conversation(context, 'core.topology.node-removed', [nodeId, ...(childrenParentId ? [childrenParentId] : [])], (talk) => talk.remove({ nodeId, nodeAddress: this.address(input.nodeAddress, 'nodeAddress'), childrenParentId, childrenParentAddress: childrenParentId ? this.address(input.childrenParentAddress, 'childrenParentAddress') : undefined }), (result) => ({ parentId: result.parentId ?? null, childCount: result.childCount }), 'core.authority.retire');
  }
  /** Shortens a node's basis using an ancestor inside its own organization: the highest reachable one, or the named one. */
  topologyRollUp(context: CoreHostRequestContext, input: { nodeId: string; nodeAddress?: string; issuerId?: string }) {
    const nodeId = this.text(input.nodeId, 'nodeId');
    return this.conversation(context, 'core.topology.node-rolled-up', [nodeId], (talk) => talk.rollUp({ nodeId, nodeAddress: this.address(input.nodeAddress, 'nodeAddress'), issuerId: input.issuerId ? this.text(input.issuerId, 'issuerId') : undefined }), (result) => ({ issuerId: result.issuerId, previousBasis: result.previousBasis, basis: result.basis }));
  }
  /** A child whose parent was retired follows the chain up and points itself at the nearest live ancestor. */
  topologyRepairParent(context: CoreHostRequestContext, input: { nodeId: string; nodeAddress?: string }) {
    const nodeId = this.text(input.nodeId, 'nodeId');
    return this.conversation(context, 'core.topology.parent-repaired', [nodeId], (talk) => talk.repairParent(nodeId, this.address(input.nodeAddress, 'nodeAddress')), (result) => ({ changed: result.changed }));
  }
  /** Checks a node's list against its children's own pointers, dropping an entry only on the child's word. */
  topologyCheckChildren(context: CoreHostRequestContext, input: { nodeId: string; nodeAddress?: string }) {
    const nodeId = this.text(input.nodeId, 'nodeId');
    return this.conversation(context, 'core.topology.children-checked', [nodeId], (talk) => talk.checkChildren({ nodeId, nodeAddress: this.address(input.nodeAddress, 'nodeAddress') }), (result) => ({ kept: result.kept.length, dropped: result.dropped, unreachable: result.unreachable.length, unknown: result.unknown.length }));
  }
  /** An administrator says whether a node's list of children is complete. Until it is, the node is never treated as childless. */
  topologyMarkChildList(context: CoreHostRequestContext, input: { nodeId: string; nodeAddress?: string; complete: boolean }) {
    const nodeId = this.text(input.nodeId, 'nodeId');
    if (typeof input.complete !== 'boolean') throw new CoreHostValidationError('complete must be true or false');
    return this.conversation(context, 'core.topology.child-list-marked', [nodeId], (talk) => talk.markChildList({ nodeId, nodeAddress: this.address(input.nodeAddress, 'nodeAddress'), complete: input.complete }), () => ({ complete: input.complete }));
  }
  /**
   * Suspends a node, here or on another machine: its parent marks it and its own Core locks. One administrator may do
   * it, and it is allowed even on a locked Core: stopping is easy. The reason is required and kept with the record.
   */
  topologySuspend(context: CoreHostRequestContext, input: { nodeId: string; nodeAddress?: string; parentId?: string; parentAddress?: string; reason: string }) {
    const nodeId = this.text(input.nodeId, 'nodeId'), reason = this.text(input.reason, 'reason');
    const parentId = input.parentId === undefined || input.parentId === null || input.parentId === '' ? undefined : this.text(input.parentId, 'parentId');
    return this.conversation(context, 'core.topology.node-suspended', [nodeId], (talk) => talk.suspend({ nodeId, nodeAddress: this.address(input.nodeAddress, 'nodeAddress'), ...(parentId ? { parentId, parentAddress: this.address(input.parentAddress, 'parentAddress') } : {}), reason, ...(context.actorId ? { by: context.actorId } : {}) }), (result) => ({ reason, parentMarked: result.parentMarked, nodeLocked: result.nodeLocked, told: result.notice.told.length, unreachable: result.notice.unreachable.length, failed: result.notice.failed.length }), 'core.authority.suspend', true);
  }
  /** Resumes a suspended node. Restarting is harder than stopping, so it has its own permission, held by nobody by default. */
  topologyResume(context: CoreHostRequestContext, input: { nodeId: string; nodeAddress?: string; parentId?: string; parentAddress?: string }) {
    const nodeId = this.text(input.nodeId, 'nodeId');
    const parentId = input.parentId === undefined || input.parentId === null || input.parentId === '' ? undefined : this.text(input.parentId, 'parentId');
    return this.conversation(context, 'core.topology.node-resumed', [nodeId], (talk) => talk.resume({ nodeId, nodeAddress: this.address(input.nodeAddress, 'nodeAddress'), ...(parentId ? { parentId, parentAddress: this.address(input.parentAddress, 'parentAddress') } : {}) }), (result) => ({ parentCleared: result.parentCleared, nodeCleared: result.nodeCleared, ...('notice' in result && result.notice ? { told: result.notice.told.length, unreachable: result.notice.unreachable.length, failed: result.notice.failed.length } : {}) }), 'core.authority.resume', true);
  }

  /** Sets or clears an organization's allowed numbers of seats. The level above sets them: until signed orders exist, its own permission, held by nobody by default. */
  topologySeatLimits(context: CoreHostRequestContext, input: { nodeId: string; nodeAddress?: string; users?: number | null; machines?: number | null }) {
    const nodeId = this.text(input.nodeId, 'nodeId'), users = this.seatNumber(input.users, 'users'), machines = this.seatNumber(input.machines, 'machines');
    return this.conversation(context, 'core.topology.seat-limits-set', [nodeId], (talk) => talk.setSeatLimits({ nodeId, nodeAddress: this.address(input.nodeAddress, 'nodeAddress'), ...(users !== undefined ? { users } : {}), ...(machines !== undefined ? { machines } : {}) }), (seats) => ({ usersAllowed: seats.users.allowed ?? null, machinesAllowed: seats.machines.allowed ?? null }), 'core.authority.seats');
  }
  /** Counts an organization's seats again. A count is lowered only when everything below answered. */
  topologyRecountSeats(context: CoreHostRequestContext, input: { nodeId: string; nodeAddress?: string }) {
    const nodeId = this.text(input.nodeId, 'nodeId');
    return this.conversation(context, 'core.topology.seats-recounted', [nodeId], (talk) => talk.recountSeats({ nodeId, nodeAddress: this.address(input.nodeAddress, 'nodeAddress') }), (result) => ({ users: result.counted.users, machines: result.counted.machines, complete: result.complete }));
  }
  /** Retires a user or machine that cannot be reached, for good. Retiring takes more authority than suspending: its own permission, held by nobody by default. */
  topologyRetireAway(context: CoreHostRequestContext, input: { nodeId: string; nodeAddress?: string; parentId: string; parentAddress?: string; reason: string }) {
    const nodeId = this.text(input.nodeId, 'nodeId'), parentId = this.text(input.parentId, 'parentId'), reason = this.text(input.reason, 'reason');
    return this.conversation(context, 'core.topology.node-retired-away', [nodeId, parentId], (talk) => talk.retireAway({ nodeId, nodeAddress: this.address(input.nodeAddress, 'nodeAddress'), parentId, parentAddress: this.address(input.parentAddress, 'parentAddress'), reason, ...(context.actorId ? { by: context.actorId } : {}) }), () => ({ reason }), 'core.authority.retire');
  }

  private machineNodeId: string | undefined;
  /** What this Core's own machine node says about being shut down, or undefined. Read each time: never cached. */
  private async lockedBy(): Promise<Shutdown | undefined> {
    if (!this.localNodes) return undefined;
    this.machineNodeId ??= (await this.store.getHostStatistics()).installationId;
    return (await this.localNodes.describe(this.machineNodeId))?.shutdown;
  }

  private lastCheckIns: CheckInRun | undefined;
  private checkInIntervalSeconds = 0;
  /**
   * Every active node this Core holds checks in with its own parent, which stamps the time on that node's entry. The
   * tree view shows those times; nothing decides on them. A parent found retired sends the node up the chain to the
   * nearest live ancestor. Runs at start, on a timer and on request; the report is kept in memory only.
   */
  async runCheckIns(actorId: string | null = null): Promise<CheckInRun> {
    const checkedAt = new Date().toISOString(), intervalSeconds = this.checkInIntervalSeconds;
    if (!this.localNodes || !this.topology) return (this.lastCheckIns = { checkedAt, intervalSeconds, nodes: [], note: 'Core-to-Core conversations are not configured on this Core' });
    const talk = this.conversations(), address = this.ownAddress();
    const nodes: CheckInRun['nodes'] = [];
    for (const node of await this.localNodes.counters()) {
      if (node.status !== 'ACTIVE') continue;
      try {
        const result = await talk.checkIn({ nodeId: node.id, nodeAddress: address });
        if (result.state === 'RETIRED') continue;
        if (result.state === 'RETIRED_WHILE_AWAY') await this.core.recordAudit({ action: 'core.topology.node-retired-by-parent', actorId, subjectIds: [node.id, ...(result.parentId ? [result.parentId] : [])], evidence: { reason: result.retired.reason } });
        if ('locked' in result && result.locked) await this.core.recordAudit({ action: 'core.topology.node-locked', actorId, subjectIds: [node.id, result.shutdown.nodeId], evidence: { reason: result.shutdown.reason, via: 'PARENT' } });
        if ('unlocked' in result && result.unlocked) await this.core.recordAudit({ action: 'core.topology.node-unlocked', actorId, subjectIds: [node.id], evidence: { via: 'PARENT' } });
        if (result.state === 'PARENT_RETIRED' && result.newParentId) await this.core.recordAudit({ action: 'core.topology.parent-repaired', actorId, subjectIds: [node.id, result.newParentId], evidence: { retiredParentId: result.parentId, by: 'check-in' } });
        nodes.push({ nodeId: node.id, ...result });
      } catch (error) {
        nodes.push({ nodeId: node.id, state: 'FAILED', reason: error instanceof Error ? error.message : 'The check-in failed' });
      }
    }
    return (this.lastCheckIns = { checkedAt, intervalSeconds, nodes });
  }
  /** Checks in now and then on a timer the administrator sets. The timer never keeps the process alive and a failed round waits for the next. */
  startCheckIns(intervalMs: number) {
    if (!(intervalMs > 0)) return undefined;
    this.checkInIntervalSeconds = Math.round(intervalMs / 1000);
    this.runCheckIns().catch(() => undefined);
    const timer = setInterval(() => { this.runCheckIns().catch(() => undefined); }, intervalMs);
    timer.unref();
    return timer;
  }
  /** The last round's report, or null before the first one. */
  async topologyCheckInStatus(context: CoreHostRequestContext) { await this.requireRead(context, 'core.topology.read'); return this.lastCheckIns ?? null; }
  /** Checks in now and returns the report. */
  async topologyCheckIn(context: CoreHostRequestContext) { await this.requireAdministration(context, 'core.topology.write'); return this.runCheckIns(context.actorId); }

  private lastKeyLimitCheck: KeyLimitCheck | undefined;
  /**
   * Looks at every active node this Core holds against its organization's length limit, and fetches a ready basis
   * for any node whose counter has reached nine tenths of it, so the node switches at the limit without waiting.
   * A machine node uses maxLastSegmentLength (it issues ordinary IDs), falling back to maxSegmentLength; every other
   * node uses maxSegmentLength. A node past its limit with no ready basis keeps issuing and is reported as over the
   * limit. Runs on a timer and on request; the last report is kept in memory only and is rebuilt by the next run.
   */
  async runKeyLimitCheck(actorId: string | null = null): Promise<KeyLimitCheck> {
    const checkedAt = new Date().toISOString();
    if (!this.localNodes || !this.topology) return (this.lastKeyLimitCheck = { checkedAt, nodes: [], note: 'Core-to-Core conversations are not configured on this Core' });
    if (await this.lockedBy()) return (this.lastKeyLimitCheck = { checkedAt, nodes: [], note: 'This Core is shut down, so it fetches no new basis' });
    const talk = this.conversations(), address = this.ownAddress();
    const nodes: KeyLimitCheck['nodes'] = [];
    for (const node of await this.localNodes.counters()) {
      if (node.status !== 'ACTIVE') continue;
      const issued = node.issued.toString();
      try {
        const organization = node.type === 'ORGANIZATION' ? await this.localNodes.describe(node.id) : (await talk.walkUp(node.id, address)).chain.find((ancestor) => ancestor.type === 'ORGANIZATION');
        const limits = organization?.keyLimits;
        const length = node.type === 'MACHINE' ? (limits?.maxLastSegmentLength ?? limits?.maxSegmentLength) : limits?.maxSegmentLength;
        const notes = limitNotes(node.basis, limits);
        if (!length) { nodes.push({ nodeId: node.id, basis: node.basis, issued, state: 'NO_LIMIT', ...(notes.length ? { notes } : {}) }); continue; }
        const maxValue = BigInt(56) ** BigInt(length) - BigInt(1);
        const early = maxValue - (maxValue / BigInt(10) > BigInt(0) ? maxValue / BigInt(10) : BigInt(1));
        const base = { nodeId: node.id, basis: node.basis, issued, limitLength: length, maxValue: maxValue.toString(), ...(notes.length ? { notes } : {}) };
        if (node.nextBasis) { nodes.push({ ...base, state: 'READY', nextBasis: node.nextBasis, switchAt: node.switchAt?.toString() }); continue; }
        if (node.issued < early) { nodes.push({ ...base, state: 'OK' }); continue; }
        try {
          const prepared = await talk.prepareNextBasis({ nodeId: node.id, nodeAddress: address, switchAt: maxValue });
          await this.core.recordAudit({ action: 'core.topology.next-basis-prepared', actorId, subjectIds: [node.id, ...(prepared.issuerId ? [prepared.issuerId] : [])], evidence: { nextBasis: prepared.nextBasis ?? null, switchAt: prepared.switchAt ?? null } });
          const all = [...notes, ...('notes' in prepared && prepared.notes ? prepared.notes : []).map((note: string) => 'The ready basis: ' + note)];
          nodes.push({ ...base, state: 'READY', nextBasis: prepared.nextBasis, switchAt: prepared.switchAt, ...(all.length ? { notes: all } : {}) });
        } catch (error) {
          nodes.push({ ...base, state: node.issued > maxValue ? 'OVER_LIMIT' : 'NEEDS_BASIS', reason: error instanceof Error ? error.message : 'A ready basis could not be fetched' });
        }
      } catch (error) {
        nodes.push({ nodeId: node.id, basis: node.basis, issued, state: 'UNCHECKED', reason: error instanceof Error ? error.message : 'The check failed' });
      }
    }
    return (this.lastKeyLimitCheck = { checkedAt, nodes });
  }
  /** Runs the check on a timer. The timer never keeps the process alive and a failed run waits for the next. */
  startKeyLimitChecks(intervalMs: number) {
    if (!(intervalMs > 0)) return undefined;
    const timer = setInterval(() => { this.runKeyLimitCheck().catch(() => undefined); }, intervalMs);
    timer.unref();
    return timer;
  }
  /** The last check's report, or null before the first one. */
  async topologyKeyLimitStatus(context: CoreHostRequestContext) { await this.requireRead(context, 'core.topology.read'); return this.lastKeyLimitCheck ?? null; }
  /** Runs the check now and returns its report. */
  async topologyKeyLimitCheck(context: CoreHostRequestContext) { await this.requireAdministration(context, 'core.topology.write'); return this.runKeyLimitCheck(context.actorId); }

  /**
   * Sets, changes or clears an organization's optional key limits, on its organization node wherever it is held.
   * A preference, never needed for uniqueness. Leaving all three out, or sending null, clears them.
   */
  topologySetKeyLimits(context: CoreHostRequestContext, input: { nodeId: string; nodeAddress?: string; maxSegments?: number | null; maxSegmentLength?: number | null; maxLastSegmentLength?: number | null }) {
    const nodeId = this.text(input.nodeId, 'nodeId');
    const limits = this.keyLimits({ maxSegments: input.maxSegments, maxSegmentLength: input.maxSegmentLength, maxLastSegmentLength: input.maxLastSegmentLength });
    return this.conversation(context, 'core.topology.key-limits-set', [nodeId], (talk) => talk.setKeyLimits({ nodeId, nodeAddress: this.address(input.nodeAddress, 'nodeAddress'), limits }), (result) => ({ keyLimits: (result.keyLimits ?? null) as JsonObject | null }));
  }

  private async requireRead(context: CoreHostRequestContext, resource: string) {
    if (!(await this.authorization.canRead({ actorId: context.actorId, resource }))) throw new CoreHostAuthorizationError(`Core Host ${resource} access is not authorized`);
  }

  /**
   * Every change and every request to do work comes through here. A Core whose own machine node is suspended refuses
   * them, except the few that let it be resumed and let its children learn it is shut down. Reads still work.
   */
  private async requireAdministration(context: CoreHostRequestContext, resource: string, whileLocked = false) {
    if (!whileLocked) {
      const shutdown = await this.lockedBy();
      if (shutdown) throw new CoreHostLockedError(`This Core is shut down${shutdown.nodeId === this.machineNodeId ? '' : ` because ${shutdown.nodeId} is suspended`}: ${shutdown.reason}. It refuses changes and work until it is resumed, and stays readable`);
    }
    if (!(await this.authorization.canAdminister({ actorId: context.actorId, resource }))) throw new CoreHostAuthorizationError(`Core Host ${resource} administration is not authorized`);
  }
}
