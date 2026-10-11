import { encodeBase56 } from '../identity/base56.js';

/**
 * Node topology owned by Core.
 *
 * A node has a permanent ID, one parent pointer holding the parent's permanent ID, and one current
 * basis that is used only to issue new values. The pointer is the only record of the tree.
 * Roll-up, insertion, rehoming and removal change pointers and bases, never an issued ID.
 */
export interface TopologyNode {
  id: string;
  parentId?: string;
  basis: string;
  status: 'ACTIVE' | 'RETIRED';
}

export interface TopologyStore {
  getNode(id: string): Promise<TopologyNode | undefined>;
  putNode(node: TopologyNode): Promise<void>;
  childrenOf(parentId: string): Promise<TopologyNode[]>;
  /** Returns the next value for a basis, starting at 1, and advances the counter. The counter never goes backwards. */
  nextValue(basis: string): Promise<bigint>;
  /** Records which node holds an issued value. A value has exactly one holder. */
  recordHolder(value: string, holderId: string): Promise<void>;
  /** Runs several steps as one unit. A database store rolls everything back if any step throws. */
  transaction<T>(work: (store: TopologyStore) => Promise<T>): Promise<T>;
}

export class InMemoryTopologyStore implements TopologyStore {
  readonly nodes = new Map<string, TopologyNode>();
  readonly counters = new Map<string, bigint>();
  readonly holders = new Map<string, string>();
  async getNode(id: string) { const node = this.nodes.get(id); return node ? { ...node } : undefined; }
  async putNode(node: TopologyNode) { this.nodes.set(node.id, { ...node }); }
  async childrenOf(parentId: string) { return [...this.nodes.values()].filter((node) => node.parentId === parentId).map((node) => ({ ...node })); }
  async nextValue(basis: string) { const next = (this.counters.get(basis) ?? BigInt(0)) + BigInt(1); this.counters.set(basis, next); return next; }
  async recordHolder(value: string, holderId: string) {
    if (this.holders.has(value)) throw new Error(`Value ${value} already has a holder`);
    this.holders.set(value, holderId);
  }
  /** Snapshot and restore, so a failed step leaves nothing behind just as a database rollback would. */
  async transaction<T>(work: (store: TopologyStore) => Promise<T>): Promise<T> {
    const snapshot = { nodes: new Map(this.nodes), counters: new Map(this.counters), holders: new Map(this.holders) };
    try { return await work(this); } catch (error) {
      this.nodes.clear(); snapshot.nodes.forEach((value, key) => this.nodes.set(key, value));
      this.counters.clear(); snapshot.counters.forEach((value, key) => this.counters.set(key, value));
      this.holders.clear(); snapshot.holders.forEach((value, key) => this.holders.set(key, value));
      throw error;
    }
  }
}

export class SemaTopology {
  constructor(private readonly store: TopologyStore) {}

  /** Every operation is one transaction, so a refusal or a crash leaves the tree exactly as it was. */
  private run<T>(work: (tx: TopologyStore) => Promise<T>) { return this.store.transaction(work); }

  private async require(tx: TopologyStore, id: string) {
    const node = await tx.getNode(id);
    if (!node) throw new Error(`Node does not exist: ${id}`);
    return node;
  }
  private async requireActive(tx: TopologyStore, id: string) {
    const node = await this.require(tx, id);
    if (node.status !== 'ACTIVE') throw new Error(`Node is retired: ${id}`);
    return node;
  }
  /** Issues the next value from the issuer's current basis. The holder is the value itself unless one is named. */
  private async issueFrom(tx: TopologyStore, issuer: TopologyNode, holderId?: string) {
    const value = `${issuer.basis}-${encodeBase56(await tx.nextValue(issuer.basis))}`;
    await tx.recordHolder(value, holderId ?? value);
    return value;
  }
  private async chain(tx: TopologyStore, nodeId: string) {
    const ancestors: TopologyNode[] = [];
    const seen = new Set<string>([nodeId]);
    for (let cursor = await this.require(tx, nodeId); cursor.parentId; ) {
      if (seen.has(cursor.parentId)) throw new Error('Cycle in parent pointers');
      seen.add(cursor.parentId);
      cursor = await this.require(tx, cursor.parentId);
      ancestors.push(cursor);
    }
    return ancestors;
  }

  async getNode(id: string) { return this.store.getNode(id); }
  async childrenOf(id: string) { return this.store.childrenOf(id); }
  /** The chain of ancestors, nearest first, including retired ones. */
  ancestors(nodeId: string) { return this.run((tx) => this.chain(tx, nodeId)); }
  /** The nearest live ancestor, used by a child that was offline while its parent was removed. */
  nearestLiveAncestor(nodeId: string) { return this.run(async (tx) => (await this.chain(tx, nodeId)).find((ancestor) => ancestor.status === 'ACTIVE')); }

  /** Registers a top-level node whose ID was allocated by the central authority. */
  registerTopNode(id: string) {
    return this.run(async (tx) => {
      if (await tx.getNode(id)) throw new Error(`Node already exists: ${id}`);
      await tx.recordHolder(id, id);
      const node: TopologyNode = { id, basis: id, status: 'ACTIVE' };
      await tx.putNode(node);
      return node;
    });
  }

  /** The parent issues the new node's ID from its current basis. The node's first basis is its own ID. */
  createNode(input: { parentId: string }) { return this.run((tx) => this.create(tx, input.parentId)); }
  private async create(tx: TopologyStore, parentId: string) {
    const parent = await this.requireActive(tx, parentId);
    const id = await this.issueFrom(tx, parent);
    const node: TopologyNode = { id, parentId: parent.id, basis: id, status: 'ACTIVE' };
    await tx.putNode(node);
    return node;
  }

  /** Inserts a new node N between P (the parent of c) and c. Only two pointers are involved. */
  insertAbove(input: { childId: string }) {
    return this.run(async (tx) => {
      const child = await this.requireActive(tx, input.childId);
      if (!child.parentId) throw new Error('A top node has no parent to insert under');
      const created = await this.create(tx, child.parentId);
      await tx.putNode({ ...child, parentId: created.id });
      return created;
    });
  }

  /** Moves a node, and its whole subtree, under a new parent. */
  rehome(input: { nodeId: string; parentId: string }) {
    return this.run(async (tx) => {
      const node = await this.requireActive(tx, input.nodeId);
      const parent = await this.requireActive(tx, input.parentId);
      if (parent.id === node.id || (await this.chain(tx, parent.id)).some((ancestor) => ancestor.id === node.id)) throw new Error('A node cannot be rehomed under itself or its own descendant');
      await tx.putNode({ ...node, parentId: parent.id });
      return { ...node, parentId: parent.id };
    });
  }

  /**
   * Retires a node and gives its children to its parent. A top node has no parent, so the caller
   * must name where its children go. The retired node keeps its record and its own pointer, so a
   * child that was offline can follow the chain to the nearest live ancestor.
   */
  remove(input: { nodeId: string; childrenParentId?: string }) {
    return this.run(async (tx) => {
      const node = await this.requireActive(tx, input.nodeId);
      const children = (await tx.childrenOf(node.id)).filter((child) => child.status === 'ACTIVE');
      const inheritor = node.parentId ?? input.childrenParentId;
      if (children.length && !inheritor) throw new Error('This node has no parent. Name childrenParentId to say where its children go');
      if (inheritor) {
        const target = await this.requireActive(tx, inheritor);
        if (target.id === node.id) throw new Error('Children cannot be given to the node being removed');
      }
      for (const child of children) await tx.putNode({ ...child, parentId: inheritor });
      await tx.putNode({ ...node, status: 'RETIRED' });
      return { repointed: children.map((child) => child.id), parentId: inheritor };
    });
  }

  /**
   * Shortens the prefix a node uses to issue new IDs. A reachable ancestor issues a fresh value from
   * its own counter, and that value becomes the node's basis. Nothing else changes: the node's ID,
   * its pointer and every issued ID stay as they are.
   *
   * The issuer must be reachable at this moment, which means a roll-up can never reach higher than one
   * level below the highest reachable node and never takes a number from an unreachable parent.
   */
  rollUp(input: { nodeId: string; issuerId: string; isReachable: (nodeId: string) => boolean | Promise<boolean> }) {
    return this.run(async (tx) => {
      const node = await this.requireActive(tx, input.nodeId);
      const issuer = await this.requireActive(tx, input.issuerId);
      if (!(await this.chain(tx, node.id)).some((ancestor) => ancestor.id === issuer.id)) throw new Error('The issuer must be an ancestor of the node');
      if (!(await input.isReachable(issuer.id))) throw new Error('The issuer is not reachable, so it cannot issue a new basis');
      if (issuer.basis.split('-').length + 1 >= node.basis.split('-').length) throw new Error('A roll-up must make the basis shorter');
      const basis = await this.issueFrom(tx, issuer, node.id);
      await tx.putNode({ ...node, basis });
      return { previousBasis: node.basis, basis };
    });
  }
}
