import type { NodeDescription, NodeType } from './local-nodes.js';

/**
 * What one Core can do with a node it holds. `LocalNodes` implements this for the local machine;
 * a remote Core is reached through the same shape. Any call may fail when the machine is not reachable.
 */
export interface NodePeer {
  describe(id: string): Promise<NodeDescription | undefined>;
  accept(input: { id: string; type: NodeType; parentId?: string; parentAddress?: string }): Promise<NodeDescription>;
  issueChildId(id: string): Promise<{ value: string; childCount: number }>;
  issueBasis(id: string): Promise<{ value: string }>;
  setParent(id: string, parentId: string, parentAddress?: string): Promise<NodeDescription>;
  setBasis(id: string, basis: string): Promise<{ previousBasis: string; basis: string }>;
  adjustChildCount(id: string, delta: number): Promise<{ childCount: number }>;
  retire(id: string): Promise<{ parentId?: string; parentAddress?: string; childCount: number }>;
  acceptRetired(input: { id: string; type: NodeType; replacementId: string; replacementAddress?: string }): Promise<NodeDescription>;
}

/**
 * Finds the Core that holds a node. The address is the one stored beside the pointer that led here, or
 * given by the caller for the node it starts from. Returns undefined when that machine cannot be reached right now.
 */
export interface PeerDirectory {
  find(nodeId: string, address?: string): Promise<NodePeer | undefined>;
}

/** A directory that can also reach the Core at a given address without knowing any node there yet. */
export interface AddressedPeers extends PeerDirectory {
  at(address: string): Promise<NodePeer | undefined>;
}

/** A node that answered, with the address it was reached at. */
export type ReachedNode = NodeDescription & { address?: string };

export interface Ancestry {
  /** Nearest first. Only nodes that answered. */
  chain: ReachedNode[];
  /** Set when the walk stopped because a node could not be reached, or did not exist. */
  stoppedAt?: { nodeId: string; reason: 'UNREACHABLE' | 'UNKNOWN' };
}

const segments = (basis: string) => basis.split('-').length;

/**
 * Operations that involve several machines, built from the single-node operations.
 *
 * Every procedure orders its steps so that a failure part-way leaves a child count too high and never
 * too low, because a count that is too high is the safe direction. Nothing here is cached: each call asks again.
 */
export class Conversations {
  constructor(private readonly directory: PeerDirectory) {}

  private async peer(nodeId: string, address?: string) {
    let peer: NodePeer | undefined;
    try { peer = await this.directory.find(nodeId, address); } catch { peer = undefined; }
    return peer;
  }
  private async describeNode(nodeId: string, address?: string): Promise<NodeDescription | 'UNREACHABLE' | 'UNKNOWN'> {
    const peer = await this.peer(nodeId, address);
    if (!peer) return 'UNREACHABLE';
    try { return (await peer.describe(nodeId)) ?? 'UNKNOWN'; } catch { return 'UNREACHABLE'; }
  }
  private async mustPeer(nodeId: string, what: string, address?: string) {
    const peer = await this.peer(nodeId, address);
    if (!peer) throw new Error(`${what} is not reachable: ${nodeId}`);
    return peer;
  }

  /** Walks up from a node by asking each parent in turn, at the address stored beside each pointer. */
  async walkUp(nodeId: string, address?: string): Promise<Ancestry> {
    const chain: ReachedNode[] = [];
    const seen = new Set<string>([nodeId]);
    const start = await this.describeNode(nodeId, address);
    if (typeof start === 'string') return { chain, stoppedAt: { nodeId, reason: start } };
    for (let next: { id?: string; address?: string } = { id: start.parentId, address: start.parentAddress }; next.id; ) {
      if (seen.has(next.id)) throw new Error('Cycle in parent pointers');
      seen.add(next.id);
      const parent = await this.describeNode(next.id, next.address);
      if (typeof parent === 'string') return { chain, stoppedAt: { nodeId: next.id, reason: parent } };
      chain.push({ ...parent, ...(next.address ? { address: next.address } : {}) });
      next = { id: parent.parentId, address: parent.parentAddress };
    }
    return { chain };
  }

  /** The nearest live ancestor, for a child whose parent was retired. Retired nodes keep their own pointer. */
  async nearestLiveAncestor(nodeId: string, address?: string) {
    const { chain, stoppedAt } = await this.walkUp(nodeId, address);
    return { ancestor: chain.find((node) => node.status === 'ACTIVE'), stoppedAt };
  }

  /**
   * A child follows the chain past a retired parent and fixes its own pointer. Does nothing when the
   * parent is live or cannot be reached.
   */
  async repairParent(nodeId: string, address?: string) {
    const node = await this.describeNode(nodeId, address);
    if (typeof node === 'string' || !node.parentId) return { changed: false as const };
    const parent = await this.describeNode(node.parentId, node.parentAddress);
    if (typeof parent === 'string' || parent.status === 'ACTIVE') return { changed: false as const };
    const { ancestor } = await this.nearestLiveAncestor(nodeId, address);
    if (!ancestor) return { changed: false as const };
    await (await this.mustPeer(nodeId, 'Node', address)).setParent(nodeId, ancestor.id, ancestor.address);
    return { changed: true as const, parentId: ancestor.id };
  }

  /**
   * Creates a node: the parent's Core issues the ID and counts the child, and the new node's own Core
   * records it. Also covers installing a machine and adding a user, where the issuer is an organization node.
   * If recording fails the ID is simply left unused, and the parent takes the child back off its count.
   */
  async createNode(input: { parentId: string; parentAddress?: string; type: NodeType; newNodePeer: NodePeer }) {
    const parent = await this.mustPeer(input.parentId, 'The issuing parent', input.parentAddress);
    const issued = await parent.issueChildId(input.parentId);
    try {
      return await input.newNodePeer.accept({ id: issued.value, type: input.type, parentId: input.parentId, parentAddress: input.parentAddress });
    } catch (error) {
      await parent.adjustChildCount(input.parentId, -1).catch(() => undefined);
      throw error;
    }
  }

  /** Inserts a new node between a node and its parent. */
  async insertAbove(input: { childId: string; childAddress?: string; type: NodeType; newNodePeer: NodePeer; newNodeAddress?: string }) {
    const child = await this.describeNode(input.childId, input.childAddress);
    if (typeof child === 'string') throw new Error(`The node is not reachable: ${input.childId}`);
    if (!child.parentId) throw new Error('A top node has no parent to insert under');
    const parentId = child.parentId;
    const parent = await this.mustPeer(parentId, 'The parent', child.parentAddress);
    const issued = await parent.issueChildId(parentId);            // parent's count +1
    await input.newNodePeer.accept({ id: issued.value, type: input.type, parentId, parentAddress: child.parentAddress });
    await input.newNodePeer.adjustChildCount(issued.value, 1);      // the new node now has one child
    await (await this.mustPeer(input.childId, 'The node', input.childAddress)).setParent(input.childId, issued.value, input.newNodeAddress);
    await parent.adjustChildCount(parentId, -1);                    // the parent gave up the child; last, so a failure leaves it high
    return { id: issued.value, parentId };
  }

  /**
   * Adds a parent above a top node, so the tree can grow from the ground up. The top node has no parent to
   * issue the new node's ID, so another node issues it: the one named, or the one with the shortest basis
   * among the top node itself and the nodes offered in `alsoConsider`. A shorter basis keeps the new ID short,
   * and any counter gives a unique value, so the choice of issuer never affects uniqueness.
   * The value is the issuer's basis plus its next number, and is not the issuer's child, so its count is unchanged.
   * If a later step fails the value is simply left unused, or the new node is left counting a child it does not have.
   */
  async addParentAbove(input: { nodeId: string; nodeAddress?: string; type: NodeType; newNodePeer: NodePeer; newNodeAddress?: string; issuerId?: string; issuerAddress?: string; alsoConsider?: Array<{ id: string; basis: string; address?: string }> }) {
    const top = await this.describeNode(input.nodeId, input.nodeAddress);
    if (typeof top === 'string') throw new Error(`The node is not reachable: ${input.nodeId}`);
    if (top.status !== 'ACTIVE') throw new Error(`Node is retired: ${input.nodeId}`);
    if (top.parentId) throw new Error('This node already has a parent. Use insert-above to put a node between them');
    const candidates = [{ id: top.id, basis: top.basis, address: input.nodeAddress }, ...(input.alsoConsider ?? [])];
    const issuer = input.issuerId
      ? { id: input.issuerId, address: input.issuerAddress }
      : candidates.reduce((best, candidate) => (segments(candidate.basis) < segments(best.basis) || (segments(candidate.basis) === segments(best.basis) && candidate.basis.length < best.basis.length) ? candidate : best));
    const fresh = await (await this.mustPeer(issuer.id, 'The issuer', issuer.address)).issueBasis(issuer.id);
    await input.newNodePeer.accept({ id: fresh.value, type: input.type });
    await input.newNodePeer.adjustChildCount(fresh.value, 1);       // counted before the pointer moves, so a failure leaves it high
    await (await this.mustPeer(input.nodeId, 'The node', input.nodeAddress)).setParent(input.nodeId, fresh.value, input.newNodeAddress);
    return { id: fresh.value, childId: input.nodeId, issuerId: issuer.id };
  }

  /**
   * Records that a node was lost and names the node that replaced it. The replacement already exists: it was
   * created like any other node, with a new ID that is its new basis. This adds the lost node's children to
   * the replacement's count, records the lost ID as retired on the replacement's Core with its pointer naming
   * the replacement, and takes the lost node off its old parent's count.
   *
   * Nobody holds a list of the lost node's children, so they are not contacted. Each one finds its parent
   * retired when it next connects and follows the pointer to the replacement (see repairParent). For that the
   * retired record must be at the address the children already hold.
   *
   * The child count is entered by a person, because the lost node's own record is gone. It must not be too low.
   * Steps are ordered so a failure leaves a count too high: the replacement is counted up first, and the old
   * parent is counted down last. If the old parent cannot be reached its count stays one too high.
   */
  async replaceLost(input: { lostId: string; type: NodeType; replacementId: string; replacementAddress?: string; childCount: number; lostParentId?: string; lostParentAddress?: string }) {
    if (!Number.isSafeInteger(input.childCount) || input.childCount < 0) throw new Error('childCount must be a whole number, zero or more');
    if (input.replacementId === input.lostId) throw new Error('A lost node needs a different node as its replacement');
    if (input.lostParentId === input.lostId) throw new Error('A node cannot be its own parent');
    const replacement = await this.describeNode(input.replacementId, input.replacementAddress);
    if (typeof replacement === 'string') throw new Error(`The replacement is not reachable: ${input.replacementId}`);
    if (replacement.status !== 'ACTIVE') throw new Error(`Node is retired: ${input.replacementId}`);
    const holder = await this.mustPeer(input.replacementId, 'The replacement', input.replacementAddress);
    if (await holder.describe(input.lostId)) throw new Error(`Node ${input.lostId} is still recorded on the replacement's Core, so it is not lost. Use remove instead`);
    if (input.childCount) await holder.adjustChildCount(input.replacementId, input.childCount);
    await holder.acceptRetired({ id: input.lostId, type: input.type, replacementId: input.replacementId, replacementAddress: input.replacementAddress });
    let oldParentCountStale = false;
    if (input.lostParentId) {
      const parent = await this.peer(input.lostParentId, input.lostParentAddress);
      if (parent) { try { await parent.adjustChildCount(input.lostParentId, -1); } catch { oldParentCountStale = true; } } else oldParentCountStale = true;
    }
    return { lostId: input.lostId, replacementId: input.replacementId, childCount: input.childCount, oldParentCountStale };
  }

  /**
   * Moves a node, and its subtree, under a new parent. Only moving a node under itself is refused:
   * a cycle needs an operator to move a node under its own descendant, and walking up to prove otherwise
   * would let an offline machine block a legitimate move. If a cycle ever formed, walking up reports it.
   * If the old parent cannot be reached the move is refused, unless an administrator overrides, in which
   * case the old parent's count stays too high until it returns.
   */
  async rehome(input: { nodeId: string; nodeAddress?: string; newParentId: string; newParentAddress?: string; administratorOverride?: boolean }) {
    if (input.newParentId === input.nodeId) throw new Error('A node cannot be its own parent');
    const node = await this.describeNode(input.nodeId, input.nodeAddress);
    if (typeof node === 'string') throw new Error(`The node is not reachable: ${input.nodeId}`);
    if (node.parentId === input.newParentId) return { changed: false as const };
    const newParent = await this.mustPeer(input.newParentId, 'The new parent', input.newParentAddress);
    const oldParent = node.parentId ? await this.peer(node.parentId, node.parentAddress) : undefined;
    if (node.parentId && !oldParent && !input.administratorOverride) throw new Error(`The old parent is not reachable: ${node.parentId}. An administrator can override.`);
    await newParent.adjustChildCount(input.newParentId, 1);
    await (await this.mustPeer(input.nodeId, 'The node', input.nodeAddress)).setParent(input.nodeId, input.newParentId, input.newParentAddress);
    let oldParentCountStale = false;
    if (node.parentId) {
      if (oldParent) { try { await oldParent.adjustChildCount(node.parentId, -1); } catch { oldParentCountStale = true; } } else oldParentCountStale = true;
    }
    return { changed: true as const, oldParentCountStale };
  }

  /**
   * Retires a node. Its child count moves to its parent, less the removed node itself. Its children's pointers
   * are not rewritten: the retired node keeps its own pointer and each child follows it later (see repairParent).
   * The top of an organization has no parent, so the caller must say which node takes its children.
   */
  async remove(input: { nodeId: string; nodeAddress?: string; childrenParentId?: string; childrenParentAddress?: string }) {
    const node = await this.describeNode(input.nodeId, input.nodeAddress);
    if (typeof node === 'string') throw new Error(`The node is not reachable: ${input.nodeId}`);
    if (node.status !== 'ACTIVE') throw new Error(`Node is retired: ${input.nodeId}`);
    const nodePeer = await this.mustPeer(input.nodeId, 'The node', input.nodeAddress);
    if (node.parentId) {
      const parent = await this.mustPeer(node.parentId, 'The parent', node.parentAddress);
      const retired = await nodePeer.retire(input.nodeId);
      await parent.adjustChildCount(node.parentId, retired.childCount - 1);
      return { parentId: node.parentId, childCount: retired.childCount };
    }
    if (node.childCount === 0) {
      const retired = await nodePeer.retire(input.nodeId);
      return { parentId: undefined, childCount: retired.childCount };
    }
    if (!input.childrenParentId) throw new Error('This node has no parent. Name childrenParentId to say which node takes its children');
    if (input.childrenParentId === input.nodeId) throw new Error('Children cannot be given to the node being removed');
    const inheritor = await this.mustPeer(input.childrenParentId, 'The node taking the children', input.childrenParentAddress);
    await inheritor.adjustChildCount(input.childrenParentId, node.childCount);
    await nodePeer.setParent(input.nodeId, input.childrenParentId, input.childrenParentAddress); // so its children can follow the chain
    const retired = await nodePeer.retire(input.nodeId);
    return { parentId: input.childrenParentId, childCount: retired.childCount };
  }

  /**
   * Shortens the node's basis. The issuer is a reachable ancestor, by default the one with the shortest basis,
   * which is the highest the walk reached: one level below the highest reachable node. Nodes above a break in
   * the chain are never used, so a number is never taken from an unreachable parent.
   */
  async rollUp(input: { nodeId: string; nodeAddress?: string; issuerId?: string }) {
    const node = await this.describeNode(input.nodeId, input.nodeAddress);
    if (typeof node === 'string') throw new Error(`The node is not reachable: ${input.nodeId}`);
    const { chain } = await this.walkUp(input.nodeId, input.nodeAddress);
    const candidates = chain.filter((ancestor) => ancestor.status === 'ACTIVE');
    if (!candidates.length) throw new Error('No reachable ancestor can issue a new basis');
    const issuer = input.issuerId
      ? candidates.find((ancestor) => ancestor.id === input.issuerId)
      : candidates.reduce((best, ancestor) => (segments(ancestor.basis) < segments(best.basis) ? ancestor : best));
    if (!issuer) throw new Error('The issuer must be a reachable ancestor of the node');
    if (segments(issuer.basis) + 1 >= segments(node.basis)) throw new Error('A roll-up must make the basis shorter');
    const fresh = await (await this.mustPeer(issuer.id, 'The issuer', issuer.address)).issueBasis(issuer.id);
    return { issuerId: issuer.id, ...(await (await this.mustPeer(input.nodeId, 'The node', input.nodeAddress)).setBasis(input.nodeId, fresh.value)) };
  }
}
