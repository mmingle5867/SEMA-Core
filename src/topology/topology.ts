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
  getNode(id: string): TopologyNode | undefined;
  putNode(node: TopologyNode): void;
  childrenOf(parentId: string): TopologyNode[];
  /** Returns the next value for a basis, starting at 1, and advances the counter. The counter never goes backwards. */
  nextValue(basis: string): bigint;
  /** Records which node holds an issued value. A value has exactly one holder. */
  recordHolder(value: string, holderId: string): void;
}

export class InMemoryTopologyStore implements TopologyStore {
  readonly nodes = new Map<string, TopologyNode>();
  readonly counters = new Map<string, bigint>();
  readonly holders = new Map<string, string>();
  getNode(id: string) { return this.nodes.get(id); }
  putNode(node: TopologyNode) { this.nodes.set(node.id, { ...node }); }
  childrenOf(parentId: string) { return [...this.nodes.values()].filter((node) => node.parentId === parentId); }
  nextValue(basis: string) { const next = (this.counters.get(basis) ?? BigInt(0)) + BigInt(1); this.counters.set(basis, next); return next; }
  recordHolder(value: string, holderId: string) {
    if (this.holders.has(value)) throw new Error(`Value ${value} already has a holder`);
    this.holders.set(value, holderId);
  }
}

export class SemaTopology {
  constructor(private readonly store: TopologyStore, private readonly now: () => string = () => new Date().toISOString()) {}

  private require(id: string) {
    const node = this.store.getNode(id);
    if (!node) throw new Error(`Node does not exist: ${id}`);
    return node;
  }
  private requireActive(id: string) {
    const node = this.require(id);
    if (node.status !== 'ACTIVE') throw new Error(`Node is retired: ${id}`);
    return node;
  }
  /** Issues the next value from the issuer's current basis. The holder is the value itself unless one is named. */
  private issueFrom(issuer: TopologyNode, holderId?: string) {
    const value = `${issuer.basis}-${encodeBase56(this.store.nextValue(issuer.basis))}`;
    this.store.recordHolder(value, holderId ?? value);
    return value;
  }

  /** Registers a top-level node whose ID was allocated by the central authority. */
  registerTopNode(id: string) {
    if (this.store.getNode(id)) throw new Error(`Node already exists: ${id}`);
    this.store.recordHolder(id, id);
    const node: TopologyNode = { id, basis: id, status: 'ACTIVE' };
    this.store.putNode(node);
    return node;
  }

  /** The parent issues the new node's ID from its current basis. The node's first basis is its own ID. */
  createNode(input: { parentId: string }) {
    const parent = this.requireActive(input.parentId);
    const id = this.issueFrom(parent);
    const node: TopologyNode = { id, parentId: parent.id, basis: id, status: 'ACTIVE' };
    this.store.putNode(node);
    return node;
  }

  /** Inserts a new node N between P (the parent of c) and c. Only two pointers are involved. */
  insertAbove(input: { childId: string }) {
    const child = this.requireActive(input.childId);
    if (!child.parentId) throw new Error('A top node has no parent to insert under');
    const created = this.createNode({ parentId: child.parentId });
    this.store.putNode({ ...child, parentId: created.id });
    return created;
  }

  /** Moves a node, and its whole subtree, under a new parent. */
  rehome(input: { nodeId: string; parentId: string }) {
    const node = this.requireActive(input.nodeId);
    const parent = this.requireActive(input.parentId);
    for (let cursor: TopologyNode | undefined = parent; cursor; cursor = cursor.parentId ? this.store.getNode(cursor.parentId) : undefined) {
      if (cursor.id === node.id) throw new Error('A node cannot be rehomed under itself or its own descendant');
    }
    this.store.putNode({ ...node, parentId: parent.id });
  }

  /**
   * Retires a node and gives its children to its parent. A top node has no parent, so the caller
   * must name where its children go. The retired node keeps its record and its own pointer, so a
   * child that was offline can follow the chain to the nearest live ancestor.
   */
  remove(input: { nodeId: string; childrenParentId?: string }) {
    const node = this.requireActive(input.nodeId);
    const children = this.store.childrenOf(node.id).filter((child) => child.status === 'ACTIVE');
    const inheritor = node.parentId ?? input.childrenParentId;
    if (children.length && !inheritor) throw new Error('This node has no parent. Name childrenParentId to say where its children go');
    if (inheritor) {
      const target = this.requireActive(inheritor);
      if (target.id === node.id) throw new Error('Children cannot be given to the node being removed');
    }
    for (const child of children) this.store.putNode({ ...child, parentId: inheritor });
    this.store.putNode({ ...node, status: 'RETIRED' });
    return { repointed: children.map((child) => child.id), parentId: inheritor };
  }

  /** The chain of ancestors, nearest first, following retired nodes to the live ones. */
  ancestors(nodeId: string) {
    const chain: TopologyNode[] = [];
    const seen = new Set<string>([nodeId]);
    for (let cursor = this.require(nodeId); cursor.parentId; ) {
      if (seen.has(cursor.parentId)) throw new Error('Cycle in parent pointers');
      seen.add(cursor.parentId);
      cursor = this.require(cursor.parentId);
      chain.push(cursor);
    }
    return chain;
  }

  /** The nearest live ancestor, used by a child that was offline while its parent was removed. */
  nearestLiveAncestor(nodeId: string) {
    return this.ancestors(nodeId).find((ancestor) => ancestor.status === 'ACTIVE');
  }

  /**
   * Shortens the prefix a node uses to issue new IDs. A reachable ancestor issues a fresh value from
   * its own counter, and that value becomes the node's basis. Nothing else changes: the node's ID,
   * its pointer and every issued ID stay as they are.
   *
   * The issuer must be reachable at this moment, which means a roll-up can never reach higher than one
   * level below the highest reachable node and never takes a number from an unreachable parent.
   */
  rollUp(input: { nodeId: string; issuerId: string; isReachable: (nodeId: string) => boolean }) {
    const node = this.requireActive(input.nodeId);
    const issuer = this.requireActive(input.issuerId);
    if (!this.ancestors(node.id).some((ancestor) => ancestor.id === issuer.id)) throw new Error('The issuer must be an ancestor of the node');
    if (!input.isReachable(issuer.id)) throw new Error('The issuer is not reachable, so it cannot issue a new basis');
    if (issuer.basis.split('-').length + 1 >= node.basis.split('-').length) throw new Error('A roll-up must make the basis shorter');
    const basis = this.issueFrom(issuer, node.id);
    this.store.putNode({ ...node, basis });
    return { previousBasis: node.basis, basis };
  }
}
