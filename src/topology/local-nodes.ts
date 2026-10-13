import { encodeBase56 } from '../identity/base56.js';

/**
 * Nodes held by THIS Core: its own machine node and the user nodes placed on this machine.
 * Every other node lives on another machine and is reached by asking its Core.
 *
 * A record holds an ID, a type, a parent pointer (the parent's permanent ID), a basis with the counter that
 * issues values from it, a count of direct children, and a status. Nothing else is stored.
 * Operations that involve several machines are conversations between Cores built from the
 * single-node operations below.
 */
/**
 * What a node is. Only the types Core's own rules treat differently are listed here:
 * ORGANIZATION is a company, with its own keyholders and its own seat limits; GROUP is a grouping inside
 * one (department, site, network); USER is a person and MACHINE is a PC or device, and each of those two
 * takes a seat. Finer detail (laptop, printer, sales department) is a description kept by Foundation Access.
 * Set once when the node is recorded and never changed: a different type is a new node with a new ID.
 */
export const NODE_TYPES = ['ORGANIZATION', 'GROUP', 'USER', 'MACHINE'] as const;
export type NodeType = (typeof NODE_TYPES)[number];
export const isNodeType = (value: unknown): value is NodeType => NODE_TYPES.includes(value as NodeType);

export interface LocalNode {
  id: string;
  type: NodeType;
  parentId?: string;
  /** Where to reach the parent's Core, kept as a stable name. Set whenever the pointer is set. */
  parentAddress?: string;
  basis: string;
  /** How many values have been issued from the current basis. Never goes backwards while the basis stands. */
  issued: bigint;
  /** Number of direct children. A parent keeps no list of them. Errs high, never low. */
  childCount: number;
  status: 'ACTIVE' | 'RETIRED';
}

export interface LocalNodeStore {
  get(id: string): Promise<LocalNode | undefined>;
  /** Every node held here. The table is small: one machine node plus the users placed on this machine. */
  list(): Promise<LocalNode[]>;
  insert(node: LocalNode): Promise<void>;
  /** Reads a node, applies the change and writes it back as one step. A database store locks the row. */
  mutate<T>(id: string, change: (node: LocalNode) => { node: LocalNode; result: T }): Promise<T>;
}

export class InMemoryLocalNodeStore implements LocalNodeStore {
  readonly nodes = new Map<string, LocalNode>();
  async get(id: string) { const node = this.nodes.get(id); return node ? { ...node } : undefined; }
  async list() { return [...this.nodes.values()].map((node) => ({ ...node })); }
  async insert(node: LocalNode) {
    if (this.nodes.has(node.id)) throw new Error(`Node already exists: ${node.id}`);
    this.nodes.set(node.id, { ...node });
  }
  async mutate<T>(id: string, change: (node: LocalNode) => { node: LocalNode; result: T }) {
    const current = this.nodes.get(id);
    if (!current) throw new Error(`Node does not exist on this Core: ${id}`);
    const { node, result } = change({ ...current });
    this.nodes.set(id, { ...node });
    return result;
  }
}

/** What any other Core may learn about a node by asking. */
export type NodeDescription = Pick<LocalNode, 'id' | 'type' | 'parentId' | 'parentAddress' | 'basis' | 'childCount' | 'status'>;

const segments = (basis: string) => basis.split('-').length;

export class LocalNodes {
  constructor(private readonly store: LocalNodeStore) {}

  /** Records a node on this machine from an ID that another Core, or the central authority, issued. */
  async accept(input: { id: string; type: NodeType; parentId?: string; parentAddress?: string }) {
    if (!input.id || input.id.split('-').some((part) => !part)) throw new Error('A node ID must be hyphen-separated non-empty segments');
    if (!isNodeType(input.type)) throw new Error('A node type must be ORGANIZATION, GROUP, USER or MACHINE');
    if (input.parentId !== undefined && input.parentId === input.id) throw new Error('A node cannot be its own parent');
    const node: LocalNode = { id: input.id, type: input.type, ...(input.parentId ? { parentId: input.parentId } : {}), ...(input.parentId && input.parentAddress ? { parentAddress: input.parentAddress } : {}), basis: input.id, issued: BigInt(0), childCount: 0, status: 'ACTIVE' };
    await this.store.insert(node);
    return this.describeNode(node);
  }

  /**
   * Records a lost node's old ID on this machine as retired, with its pointer naming the node that replaced it.
   * The old ID is not reissued: this is only the record a child follows to find the replacement. A retired
   * node issues nothing, so the old basis stays closed. Refused when the ID is already recorded here,
   * because a node this Core still holds is not lost.
   */
  async acceptRetired(input: { id: string; type: NodeType; replacementId: string; replacementAddress?: string }) {
    if (!input.id || input.id.split('-').some((part) => !part)) throw new Error('A node ID must be hyphen-separated non-empty segments');
    if (!isNodeType(input.type)) throw new Error('A node type must be ORGANIZATION, GROUP, USER or MACHINE');
    if (!input.replacementId || input.replacementId === input.id) throw new Error('A lost node needs a different node as its replacement');
    const node: LocalNode = { id: input.id, type: input.type, parentId: input.replacementId, ...(input.replacementAddress ? { parentAddress: input.replacementAddress } : {}), basis: input.id, issued: BigInt(0), childCount: 0, status: 'RETIRED' };
    await this.store.insert(node);
    return this.describeNode(node);
  }

  async list() { return (await this.store.list()).map((node) => this.describeNode(node)); }

  /**
   * The nodes held here as this machine's own administrator sees them: each with the next ID it would issue,
   * which is its basis plus the next number from its counter. A retired node issues nothing, so it has none.
   * The value is a reading, not a promise: on the machine's own node it moves with every ID Core issues.
   */
  async listWithNextId() {
    return (await this.store.list()).map((node) => ({ ...this.describeNode(node), ...(node.status === 'ACTIVE' ? { nextId: `${node.basis}-${encodeBase56(node.issued + BigInt(1))}` } : {}) }));
  }

  async describe(id: string) {
    const node = await this.store.get(id);
    return node ? this.describeNode(node) : undefined;
  }

  /** Issues the ID for a new child from this node's basis and counts the child. The child's own Core then accepts it. */
  issueChildId(id: string) {
    return this.store.mutate(id, (node) => {
      this.requireActive(node);
      const issued = node.issued + BigInt(1);
      return { node: { ...node, issued, childCount: node.childCount + 1 }, result: { value: `${node.basis}-${encodeBase56(issued)}`, childCount: node.childCount + 1 } };
    });
  }

  /** Issues a fresh value that another node will adopt as its basis. It is not a child, so the count is unchanged. */
  issueBasis(id: string) {
    return this.store.mutate(id, (node) => {
      this.requireActive(node);
      const issued = node.issued + BigInt(1);
      return { node: { ...node, issued }, result: { value: `${node.basis}-${encodeBase56(issued)}` } };
    });
  }

  setParent(id: string, parentId: string, parentAddress?: string) {
    return this.store.mutate(id, (node) => {
      this.requireActive(node);
      if (parentId === id) throw new Error('A node cannot be its own parent');
      const { parentAddress: _old, ...rest } = node;
      const moved: LocalNode = { ...rest, parentId, ...(parentAddress ? { parentAddress } : {}) };
      return { node: moved, result: this.describeNode(moved) };
    });
  }

  /** Adopts a shorter basis issued by a reachable ancestor. Only the basis and its counter change. */
  setBasis(id: string, basis: string) {
    return this.store.mutate(id, (node) => {
      this.requireActive(node);
      if (segments(basis) >= segments(node.basis)) throw new Error('A roll-up must make the basis shorter');
      if (!basis.split('-').every(Boolean)) throw new Error('A basis must be hyphen-separated non-empty segments');
      return { node: { ...node, basis, issued: BigInt(0) }, result: { previousBasis: node.basis, basis } };
    });
  }

  /** Moves the child count by a signed amount. It can never go below zero. */
  adjustChildCount(id: string, delta: number) {
    if (!Number.isSafeInteger(delta)) throw new Error('delta must be a whole number');
    return this.store.mutate(id, (node) => {
      const childCount = node.childCount + delta;
      if (childCount < 0) throw new Error('A child count cannot go below zero');
      return { node: { ...node, childCount }, result: { childCount } };
    });
  }

  /**
   * Retires a node. The record and its own pointer stay, so a child that was offline can follow the
   * chain upward. The child count is returned and cleared so the caller can add it to the parent's.
   */
  retire(id: string) {
    return this.store.mutate(id, (node) => {
      this.requireActive(node);
      return { node: { ...node, status: 'RETIRED' as const, childCount: 0 }, result: { parentId: node.parentId, ...(node.parentAddress ? { parentAddress: node.parentAddress } : {}), childCount: node.childCount } };
    });
  }

  private requireActive(node: LocalNode) { if (node.status !== 'ACTIVE') throw new Error(`Node is retired: ${node.id}`); }
  private describeNode(node: LocalNode): NodeDescription { return { id: node.id, type: node.type, ...(node.parentId ? { parentId: node.parentId } : {}), ...(node.parentAddress ? { parentAddress: node.parentAddress } : {}), basis: node.basis, childCount: node.childCount, status: node.status }; }
}
