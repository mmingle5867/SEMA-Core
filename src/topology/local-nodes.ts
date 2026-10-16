import { encodeBase56 } from '../identity/base56.js';

/**
 * Nodes held by THIS Core: its own machine node and the user nodes placed on this machine.
 * Every other node lives on another machine and is reached by asking its Core.
 *
 * A record holds an ID, a type, a parent pointer (the parent's permanent ID), a basis with the counter that
 * issues values from it, a status, and a list of the node's direct children. Operations that involve several
 * machines are conversations between Cores built from the single-node operations below.
 */
/**
 * What a node is. Only the types Core's own rules treat differently are listed here:
 * ORGANIZATION is a company or a division of one, with its own keyholders and its own seat limits; GROUP groups
 * people (department, team); SITE groups machines (site, building, network); USER is a person and MACHINE is a
 * PC or device, and each of those two takes a seat. Finer detail (laptop, printer, sales department, room) is a
 * description kept by Foundation Access. Set once when the node is recorded and never changed: a different type
 * is a new node with a new ID.
 */
export const NODE_TYPES = ['ORGANIZATION', 'GROUP', 'SITE', 'USER', 'MACHINE'] as const;
export type NodeType = (typeof NODE_TYPES)[number];
export const isNodeType = (value: unknown): value is NodeType => NODE_TYPES.includes(value as NodeType);
const TYPE_LIST = 'ORGANIZATION, GROUP, SITE, USER or MACHINE';

/**
 * Which types may sit directly under which. A GROUP and a SITE are kept apart because the parent means different
 * things on each side: on the people side it gives a person their permissions, on the physical side it gives a
 * machine its ceiling. A user or a machine has no children in the tree.
 */
export const MAY_HOLD: Readonly<Record<NodeType, readonly NodeType[]>> = {
  ORGANIZATION: ['ORGANIZATION', 'GROUP', 'SITE', 'USER'],
  GROUP: ['GROUP', 'USER'],
  SITE: ['SITE', 'MACHINE'],
  USER: [],
  MACHINE: [],
};
export function mayHold(parent: NodeType, child: NodeType) { return MAY_HOLD[parent].includes(child); }
const a = (type: NodeType, capital = false) => `${type === 'ORGANIZATION' ? (capital ? 'An' : 'an') : (capital ? 'A' : 'a')} ${type}`;
export function requireMayHold(parent: { id: string; type: NodeType }, child: { childId?: string; type: NodeType }) {
  if (mayHold(parent.type, child.type)) return;
  const allowed = MAY_HOLD[parent.type];
  throw new Error(`${a(child.type, true)} cannot sit under ${a(parent.type)}${child.childId ? ` (${child.childId} under ${parent.id})` : ''}. ${allowed.length ? `${a(parent.type, true)} may hold ${allowed.join(', ')}` : `${a(parent.type, true)} has no children in the tree`}`);
}

/**
 * One direct child, as its parent believes it to be. The child's own pointer is the truth: when the two
 * disagree, the pointer wins. A list may hold too many entries, never too few.
 */
export interface ChildEntry {
  childId: string;
  type: NodeType;
  /** Where to reach the child's Core. Left out means the same Core as the parent. */
  address?: string;
  /** When the child last checked in with this parent. Empty until it has. Never the basis of a decision. */
  lastSeenAt?: string;
}

/** What a parent answers a child that checks in. A retired parent stamps nothing and names its own parent, so the child can follow the chain. */
export type CheckInAnswer =
  | { status: 'ACTIVE'; lastSeenAt: string; added: boolean }
  | { status: 'RETIRED'; parentId?: string; parentAddress?: string };

/**
 * Optional limits an organization sets on the IDs issued inside it: a preference, never needed for uniqueness. They
 * exist to keep IDs short, which matters little on one machine but a great deal between machines: IDs travel with
 * every transaction, several in each message, so every extra character is sent again and again.
 * `maxSegments` is how many hyphen segments a basis may have before a roll-up may go outside the organization.
 * `maxSegmentLength` is how many characters a value issued for a node (a child or a new basis) should have, and
 * `maxLastSegmentLength` the same for values issued as ordinary IDs, the last segment, which may be longer.
 * Only an organization node holds them. Nothing set means no limit.
 */
export interface KeyLimits {
  maxSegments?: number;
  maxSegmentLength?: number;
  maxLastSegmentLength?: number;
}
const KEY_LIMIT_RANGES: Record<keyof KeyLimits, [number, number]> = { maxSegments: [2, 64], maxSegmentLength: [1, 12], maxLastSegmentLength: [1, 20] };
/** Checks a set of limits and drops any left out. Throws on anything that is not a whole number in range. */
export function checkKeyLimits(input: unknown): KeyLimits {
  if (input === null || input === undefined) return {};
  if (typeof input !== 'object' || Array.isArray(input)) throw new Error('Key limits must be an object');
  const limits: KeyLimits = {};
  for (const [name, value] of Object.entries(input as Record<string, unknown>)) {
    if (!(name in KEY_LIMIT_RANGES)) throw new Error(`Unknown key limit: ${name}. The limits are maxSegments, maxSegmentLength and maxLastSegmentLength`);
    if (value === null || value === undefined) continue;
    const [low, high] = KEY_LIMIT_RANGES[name as keyof KeyLimits];
    if (!Number.isInteger(value) || (value as number) < low || (value as number) > high) throw new Error(`${name} must be a whole number from ${low} to ${high}`);
    limits[name as keyof KeyLimits] = value as number;
  }
  if (limits.maxSegmentLength !== undefined && limits.maxLastSegmentLength !== undefined && limits.maxLastSegmentLength < limits.maxSegmentLength) throw new Error('maxLastSegmentLength must be at least maxSegmentLength: the last segment may be longer, never shorter');
  return limits;
}
const hasLimits = (limits?: KeyLimits) => Boolean(limits && Object.keys(limits).length);

export interface LocalNode {
  id: string;
  type: NodeType;
  /** Set only on an organization node, and only when the organization chose limits. */
  keyLimits?: KeyLimits;
  parentId?: string;
  /** Where to reach the parent's Core, kept as a stable name. Set whenever the pointer is set. */
  parentAddress?: string;
  basis: string;
  /** How many values have been issued from the current basis. Never goes backwards while the basis stands. */
  issued: bigint;
  /**
   * A basis fetched early from an ancestor, ready to take over. When the counter would pass `switchAt`, the node
   * switches to it in the same step that issues the next value, so a node that issues many values never waits.
   * Both are set together, or neither.
   */
  nextBasis?: string;
  switchAt?: bigint;
  /**
   * False when the list of children may be missing some, as on a node that replaced a lost one. Such a node is
   * never treated as childless until an administrator says its list is complete.
   */
  childListComplete: boolean;
  status: 'ACTIVE' | 'RETIRED';
}

export interface LocalNodeStore {
  get(id: string): Promise<LocalNode | undefined>;
  /** Every node held here. The table is small: one machine node plus the users placed on this machine. */
  list(): Promise<LocalNode[]>;
  insert(node: LocalNode): Promise<void>;
  /**
   * Reads a node, applies the change and writes it back as one step. A database store locks the row. A change
   * may also add children, which are written in the same step, so an issued child is never left off the list.
   */
  mutate<T>(id: string, change: (node: LocalNode) => { node: LocalNode; result: T; addChildren?: ChildEntry[] }): Promise<T>;
  children(id: string): Promise<ChildEntry[]>;
  /** How many children each node held here has, by node ID. */
  countChildren(): Promise<Map<string, number>>;
  /** Adds children, or updates entries already there. Only an active node may gain children. */
  addChildren(id: string, entries: ChildEntry[]): Promise<void>;
  /** Takes one child off a node's list. Says whether it was there. */
  removeChild(id: string, childId: string): Promise<boolean>;
  /**
   * Stamps the time a child checked in on its entry. A child missing from the list is added: its own pointer says this
   * is its parent, and the list may hold too many entries, never too few. Only an active node may gain children.
   */
  checkIn(id: string, child: ChildEntry, at: Date): Promise<{ added: boolean }>;
}

export class InMemoryLocalNodeStore implements LocalNodeStore {
  readonly nodes = new Map<string, LocalNode>();
  readonly lists = new Map<string, Map<string, ChildEntry>>();
  async get(id: string) { const node = this.nodes.get(id); return node ? structuredClone(node) : undefined; }
  async list() { return [...this.nodes.values()].map((node) => structuredClone(node)); }
  async insert(node: LocalNode) {
    if (this.nodes.has(node.id)) throw new Error(`Node already exists: ${node.id}`);
    this.nodes.set(node.id, structuredClone(node));
    this.lists.set(node.id, new Map());
  }
  async mutate<T>(id: string, change: (node: LocalNode) => { node: LocalNode; result: T; addChildren?: ChildEntry[] }) {
    const current = this.nodes.get(id);
    if (!current) throw new Error(`Node does not exist on this Core: ${id}`);
    const { node, result, addChildren } = change(structuredClone(current));
    this.nodes.set(id, structuredClone(node));
    for (const entry of addChildren ?? []) this.lists.get(id)!.set(entry.childId, { ...entry });
    return result;
  }
  async children(id: string) { return [...(this.lists.get(id)?.values() ?? [])].map((entry) => ({ ...entry })); }
  async countChildren() { return new Map([...this.lists].map(([id, list]) => [id, list.size])); }
  async addChildren(id: string, entries: ChildEntry[]) {
    const node = this.nodes.get(id);
    if (!node) throw new Error(`Node does not exist on this Core: ${id}`);
    if (node.status !== 'ACTIVE') throw new Error(`Node is retired: ${id}`);
    for (const entry of entries) this.lists.get(id)!.set(entry.childId, { ...entry });
  }
  async removeChild(id: string, childId: string) {
    if (!this.nodes.has(id)) throw new Error(`Node does not exist on this Core: ${id}`);
    return this.lists.get(id)!.delete(childId);
  }
  async checkIn(id: string, child: ChildEntry, at: Date) {
    const node = this.nodes.get(id);
    if (!node) throw new Error(`Node does not exist on this Core: ${id}`);
    if (node.status !== 'ACTIVE') throw new Error(`Node is retired: ${id}`);
    const list = this.lists.get(id)!, current = list.get(child.childId);
    list.set(child.childId, { ...(current ?? child), lastSeenAt: at.toISOString() });
    return { added: !current };
  }
}

/** What any other Core may learn about a node by asking. The child count is the length of its list. */
export interface NodeDescription {
  id: string;
  type: NodeType;
  parentId?: string;
  parentAddress?: string;
  basis: string;
  childCount: number;
  /** Present, and true, only when the list of children may be missing some. */
  childListIncomplete?: true;
  /** Present only on an organization node that has chosen limits. Read by a roll-up walking up through it. */
  keyLimits?: KeyLimits;
  /** A basis fetched early and ready to take over, and the counter value after which it does. */
  nextBasis?: string;
  switchAt?: string;
  status: 'ACTIVE' | 'RETIRED';
}

const segments = (basis: string) => basis.split('-').length;

/**
 * Takes `count` values from a node's counter. When a ready basis is waiting and the counter would pass `switchAt`,
 * the node switches to it first and the values come from the new basis, counter restarted. What was left under the
 * old basis is simply never used. With no ready basis the node keeps issuing: a limit is a preference.
 */
export function advance(node: LocalNode, count = 1): { node: LocalNode; basis: string; first: bigint } {
  if (node.nextBasis && node.switchAt !== undefined && node.issued + BigInt(count) > node.switchAt) {
    const { nextBasis, switchAt: _done, ...rest } = node;
    return { node: { ...rest, basis: nextBasis, issued: BigInt(count) }, basis: nextBasis, first: BigInt(1) };
  }
  return { node: { ...node, issued: node.issued + BigInt(count) }, basis: node.basis, first: node.issued + BigInt(1) };
}
const validId = (id: string) => Boolean(id) && id.split('-').every(Boolean);
const entry = (child: { childId: string; type: NodeType; address?: string }): ChildEntry => {
  if (!validId(child.childId)) throw new Error('A child ID must be hyphen-separated non-empty segments');
  if (!isNodeType(child.type)) throw new Error(`A node type must be ${TYPE_LIST}`);
  return { childId: child.childId, type: child.type, ...(child.address ? { address: child.address } : {}) };
};

export class LocalNodes {
  constructor(private readonly store: LocalNodeStore) {}

  /** Records a node on this machine from an ID that another Core, or the central authority, issued. */
  async accept(input: { id: string; type: NodeType; parentId?: string; parentAddress?: string }) {
    if (!validId(input.id)) throw new Error('A node ID must be hyphen-separated non-empty segments');
    if (!isNodeType(input.type)) throw new Error(`A node type must be ${TYPE_LIST}`);
    if (input.parentId !== undefined && input.parentId === input.id) throw new Error('A node cannot be its own parent');
    const node: LocalNode = { id: input.id, type: input.type, ...(input.parentId ? { parentId: input.parentId } : {}), ...(input.parentId && input.parentAddress ? { parentAddress: input.parentAddress } : {}), basis: input.id, issued: BigInt(0), childListComplete: true, status: 'ACTIVE' };
    await this.store.insert(node);
    return this.describeNode(node, 0);
  }

  /**
   * Records a lost node's old ID on this machine as retired, with its pointer naming the node that replaced it.
   * The old ID is not reissued: this is only the record a child follows to find the replacement. A retired
   * node issues nothing, so the old basis stays closed. Refused when the ID is already recorded here,
   * because a node this Core still holds is not lost.
   */
  async acceptRetired(input: { id: string; type: NodeType; replacementId: string; replacementAddress?: string }) {
    if (!validId(input.id)) throw new Error('A node ID must be hyphen-separated non-empty segments');
    if (!isNodeType(input.type)) throw new Error(`A node type must be ${TYPE_LIST}`);
    if (!input.replacementId || input.replacementId === input.id) throw new Error('A lost node needs a different node as its replacement');
    const node: LocalNode = { id: input.id, type: input.type, parentId: input.replacementId, ...(input.replacementAddress ? { parentAddress: input.replacementAddress } : {}), basis: input.id, issued: BigInt(0), childListComplete: true, status: 'RETIRED' };
    await this.store.insert(node);
    return this.describeNode(node, 0);
  }

  async list() {
    const counts = await this.store.countChildren();
    return (await this.store.list()).map((node) => this.describeNode(node, counts.get(node.id) ?? 0));
  }

  /**
   * The nodes held here as this machine's own administrator sees them: each with the next ID it would issue,
   * which is its basis plus the next number from its counter. A retired node issues nothing, so it has none.
   * The value is a reading, not a promise: on the machine's own node it moves with every ID Core issues.
   */
  async listWithNextId() {
    const counts = await this.store.countChildren();
    return (await this.store.list()).map((node) => ({ ...this.describeNode(node, counts.get(node.id) ?? 0), ...(node.status === 'ACTIVE' ? { nextId: ((next) => `${next.basis}-${encodeBase56(next.first)}`)(advance(node)) } : {}) }));
  }

  async describe(id: string) {
    const node = await this.store.get(id);
    return node ? this.describeNode(node, (await this.store.children(id)).length) : undefined;
  }

  /** The node's direct children, as it believes them to be. */
  async children(id: string) {
    if (!(await this.store.get(id))) throw new Error(`Node does not exist on this Core: ${id}`);
    return this.store.children(id);
  }

  /**
   * Issues the ID for a new child from this node's basis and puts it on the list in the same step, before the
   * child's own Core has accepted it. If the child is never recorded, the entry is one too many, never one too few.
   */
  async issueChildId(id: string, child: { type: NodeType; address?: string }) {
    if (!isNodeType(child.type)) throw new Error(`A node type must be ${TYPE_LIST}`);
    const value = await this.store.mutate(id, (node) => {
      this.requireActive(node);
      requireMayHold(node, child);
      const next = advance(node);
      const childId = `${next.basis}-${encodeBase56(next.first)}`;
      return { node: next.node, result: childId, addChildren: [entry({ childId, type: child.type, address: child.address })] };
    });
    return { value, childCount: (await this.store.children(id)).length };
  }

  /** Issues a fresh value that another node will adopt as its basis. It is not a child, so the list is unchanged. */
  issueBasis(id: string) {
    return this.store.mutate(id, (node) => {
      this.requireActive(node);
      const next = advance(node);
      return { node: next.node, result: { value: `${next.basis}-${encodeBase56(next.first)}` } };
    });
  }

  async setParent(id: string, parentId: string, parentAddress?: string) {
    const moved = await this.store.mutate(id, (node) => {
      this.requireActive(node);
      if (parentId === id) throw new Error('A node cannot be its own parent');
      const { parentAddress: _old, ...rest } = node;
      const next: LocalNode = { ...rest, parentId, ...(parentAddress ? { parentAddress } : {}) };
      return { node: next, result: next };
    });
    return this.describeNode(moved, (await this.store.children(id)).length);
  }

  /** Adopts a shorter basis issued by a reachable ancestor. Only the basis and its counter change. */
  setBasis(id: string, basis: string) {
    return this.store.mutate(id, (node) => {
      this.requireActive(node);
      if (segments(basis) >= segments(node.basis)) throw new Error('A roll-up must make the basis shorter');
      if (!basis.split('-').every(Boolean)) throw new Error('A basis must be hyphen-separated non-empty segments');
      const { nextBasis: _ready, switchAt: _at, ...rest } = node; // a ready basis was for the old one
      return { node: { ...rest, basis, issued: BigInt(0) }, result: { previousBasis: node.basis, basis } };
    });
  }

  /**
   * Keeps a basis fetched early, ready to take over when the counter would pass `switchAt`. A node holds one ready
   * basis at most: if it already has one, that one stays and the new value is simply never used.
   */
  async setNextBasis(id: string, input: { basis: string; switchAt: bigint | string | number }) {
    if (!validId(input.basis)) throw new Error('A basis must be hyphen-separated non-empty segments');
    let switchAt: bigint;
    try { switchAt = BigInt(input.switchAt); } catch { throw new Error('switchAt must be a whole number'); }
    if (switchAt < BigInt(1)) throw new Error('switchAt must be a whole number of at least 1');
    const changed = await this.store.mutate(id, (node) => {
      this.requireActive(node);
      if (input.basis === node.basis || input.basis.startsWith(`${node.basis}-`) || input.basis === id) throw new Error('A ready basis must be issued by an ancestor, not by the node itself');
      const next: LocalNode = node.nextBasis ? node : { ...node, nextBasis: input.basis, switchAt };
      return { node: next, result: next };
    });
    return this.describeNode(changed, (await this.store.children(id)).length);
  }

  /** The counters of the nodes held here, for the check that fetches a ready basis before a limit is reached. */
  async counters() {
    return (await this.store.list()).map((node) => ({ id: node.id, type: node.type, status: node.status, basis: node.basis, issued: node.issued, ...(node.nextBasis ? { nextBasis: node.nextBasis, switchAt: node.switchAt } : {}) }));
  }

  /**
   * Adds children to a node's list, or updates entries already there. Only an active node gains children, and only
   * of a type it may hold. Every way a node gets a parent passes through here or through issueChildId, so this is
   * where the rule of which types sit under which is kept.
   */
  async addChildren(id: string, children: Array<{ childId: string; type: NodeType; address?: string }>) {
    const entries = children.map(entry);
    if (entries.some((child) => child.childId === id)) throw new Error('A node cannot be its own child');
    const parent = await this.store.get(id);
    if (!parent) throw new Error(`Node does not exist on this Core: ${id}`);
    this.requireActive(parent);
    for (const child of entries) requireMayHold(parent, child);
    await this.store.addChildren(id, entries);
    return { childCount: (await this.store.children(id)).length };
  }

  /**
   * A child checks in with this node, its parent: the time is stamped on the child's entry. A child missing from the
   * list is added, if it is a type this node may hold. A retired node stamps nothing and answers with its own pointer,
   * so the child can follow the chain to the nearest live ancestor.
   */
  async checkIn(id: string, child: { childId: string; type: NodeType; address?: string }): Promise<CheckInAnswer> {
    const checked = entry(child);
    if (checked.childId === id) throw new Error('A node cannot be its own child');
    const parent = await this.store.get(id);
    if (!parent) throw new Error(`Node does not exist on this Core: ${id}`);
    if (parent.status !== 'ACTIVE') return { status: 'RETIRED', ...(parent.parentId ? { parentId: parent.parentId } : {}), ...(parent.parentAddress ? { parentAddress: parent.parentAddress } : {}) };
    requireMayHold(parent, checked);
    const at = new Date();
    const { added } = await this.store.checkIn(id, checked, at);
    return { status: 'ACTIVE', lastSeenAt: at.toISOString(), added };
  }

  /** Takes one child off a node's list. */
  async removeChild(id: string, childId: string) {
    const removed = await this.store.removeChild(id, childId);
    return { removed, childCount: (await this.store.children(id)).length };
  }

  /** Says whether the node's list of children is known to be complete. */
  setChildListComplete(id: string, complete: boolean) {
    if (typeof complete !== 'boolean') throw new Error('complete must be true or false');
    return this.store.mutate(id, (node) => ({ node: { ...node, childListComplete: complete }, result: { childListComplete: complete } }));
  }

  /** Sets, changes or clears an organization's key limits. Only an active organization node holds them. Null or nothing clears them. */
  async setKeyLimits(id: string, input: KeyLimits | null) {
    const limits = checkKeyLimits(input);
    const changed = await this.store.mutate(id, (node) => {
      this.requireActive(node);
      if (node.type !== 'ORGANIZATION') throw new Error(`Key limits must be set on an organization node, and ${id} is ${a(node.type)}`);
      const { keyLimits: _old, ...rest } = node;
      const next: LocalNode = hasLimits(limits) ? { ...rest, keyLimits: limits } : rest;
      return { node: next, result: next };
    });
    return this.describeNode(changed, (await this.store.children(id)).length);
  }

  /**
   * Retires a node. The record, its own pointer and its list of children stay as they were, so a child that
   * was offline can follow the chain upward. The list is returned so the caller can give the children to the parent.
   */
  async retire(id: string) {
    const node = await this.store.mutate(id, (current) => {
      this.requireActive(current);
      return { node: { ...current, status: 'RETIRED' as const }, result: current };
    });
    return { ...(node.parentId ? { parentId: node.parentId } : {}), ...(node.parentAddress ? { parentAddress: node.parentAddress } : {}), children: await this.store.children(id), childListComplete: node.childListComplete };
  }

  private requireActive(node: LocalNode) { if (node.status !== 'ACTIVE') throw new Error(`Node is retired: ${node.id}`); }
  private describeNode(node: LocalNode, childCount: number): NodeDescription {
    return { id: node.id, type: node.type, ...(node.parentId ? { parentId: node.parentId } : {}), ...(node.parentAddress ? { parentAddress: node.parentAddress } : {}), basis: node.basis, childCount, ...(node.childListComplete ? {} : { childListIncomplete: true as const }), ...(hasLimits(node.keyLimits) ? { keyLimits: { ...node.keyLimits } } : {}), ...(node.nextBasis && node.switchAt !== undefined ? { nextBasis: node.nextBasis, switchAt: node.switchAt.toString() } : {}), status: node.status };
  }
}
