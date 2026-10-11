import type { NodeDescription } from './local-nodes.js';

/**
 * What one Core can do with a node it holds. `LocalNodes` implements this for the local machine;
 * a remote Core is reached through the same shape. Any call may fail when the machine is not reachable.
 */
export interface NodePeer {
  describe(id: string): Promise<NodeDescription | undefined>;
  accept(input: { id: string; parentId?: string }): Promise<NodeDescription>;
  issueChildId(id: string): Promise<{ value: string; childCount: number }>;
  issueBasis(id: string): Promise<{ value: string }>;
  setParent(id: string, parentId: string): Promise<NodeDescription>;
  setBasis(id: string, basis: string): Promise<{ previousBasis: string; basis: string }>;
  adjustChildCount(id: string, delta: number): Promise<{ childCount: number }>;
  retire(id: string): Promise<{ parentId?: string; childCount: number }>;
}

/** Finds the Core that holds a node. Returns undefined when that machine cannot be reached right now. */
export interface PeerDirectory {
  find(nodeId: string): Promise<NodePeer | undefined>;
}

export interface Ancestry {
  /** Nearest first. Only nodes that answered. */
  chain: NodeDescription[];
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

  private async peer(nodeId: string) {
    let peer: NodePeer | undefined;
    try { peer = await this.directory.find(nodeId); } catch { peer = undefined; }
    return peer;
  }
  private async describeNode(nodeId: string): Promise<NodeDescription | 'UNREACHABLE' | 'UNKNOWN'> {
    const peer = await this.peer(nodeId);
    if (!peer) return 'UNREACHABLE';
    try { return (await peer.describe(nodeId)) ?? 'UNKNOWN'; } catch { return 'UNREACHABLE'; }
  }
  private async mustPeer(nodeId: string, what: string) {
    const peer = await this.peer(nodeId);
    if (!peer) throw new Error(`${what} is not reachable: ${nodeId}`);
    return peer;
  }

  /** Walks up from a node by asking each parent in turn. */
  async walkUp(nodeId: string): Promise<Ancestry> {
    const chain: NodeDescription[] = [];
    const seen = new Set<string>([nodeId]);
    const start = await this.describeNode(nodeId);
    if (typeof start === 'string') return { chain, stoppedAt: { nodeId, reason: start } };
    for (let parentId = start.parentId; parentId; ) {
      if (seen.has(parentId)) throw new Error('Cycle in parent pointers');
      seen.add(parentId);
      const parent = await this.describeNode(parentId);
      if (typeof parent === 'string') return { chain, stoppedAt: { nodeId: parentId, reason: parent } };
      chain.push(parent);
      parentId = parent.parentId;
    }
    return { chain };
  }

  /** The nearest live ancestor, for a child whose parent was retired. Retired nodes keep their own pointer. */
  async nearestLiveAncestor(nodeId: string) {
    const { chain, stoppedAt } = await this.walkUp(nodeId);
    return { ancestor: chain.find((node) => node.status === 'ACTIVE'), stoppedAt };
  }

  /**
   * A child follows the chain past a retired parent and fixes its own pointer. Does nothing when the
   * parent is live or cannot be reached.
   */
  async repairParent(nodeId: string) {
    const node = await this.describeNode(nodeId);
    if (typeof node === 'string' || !node.parentId) return { changed: false as const };
    const parent = await this.describeNode(node.parentId);
    if (typeof parent === 'string' || parent.status === 'ACTIVE') return { changed: false as const };
    const { ancestor } = await this.nearestLiveAncestor(nodeId);
    if (!ancestor) return { changed: false as const };
    await (await this.mustPeer(nodeId, 'Node')).setParent(nodeId, ancestor.id);
    return { changed: true as const, parentId: ancestor.id };
  }

  /**
   * Creates a node: the parent's Core issues the ID and counts the child, and the new node's own Core
   * records it. Also covers installing a machine and adding a user, where the issuer is an organization node.
   */
  async createNode(input: { parentId: string; newNodePeer: NodePeer }) {
    const parent = await this.mustPeer(input.parentId, 'The issuing parent');
    const issued = await parent.issueChildId(input.parentId);
    try {
      return await input.newNodePeer.accept({ id: issued.value, parentId: input.parentId });
    } catch (error) {
      // The ID is spent and never reused. Take the child back off the count if we can; if not, it stays too high.
      await parent.adjustChildCount(input.parentId, -1).catch(() => undefined);
      throw error;
    }
  }

  /** Inserts a new node between a node and its parent. */
  async insertAbove(input: { childId: string; newNodePeer: NodePeer }) {
    const child = await this.describeNode(input.childId);
    if (typeof child === 'string') throw new Error(`The node is not reachable: ${input.childId}`);
    if (!child.parentId) throw new Error('A top node has no parent to insert under');
    const parentId = child.parentId;
    const parent = await this.mustPeer(parentId, 'The parent');
    const issued = await parent.issueChildId(parentId);            // parent's count +1
    await input.newNodePeer.accept({ id: issued.value, parentId });
    await input.newNodePeer.adjustChildCount(issued.value, 1);      // the new node now has one child
    await (await this.mustPeer(input.childId, 'The node')).setParent(input.childId, issued.value);
    await parent.adjustChildCount(parentId, -1);                    // the parent gave up the child; last, so a failure leaves it high
    return { id: issued.value, parentId };
  }

  /**
   * Moves a node, and its subtree, under a new parent. The cycle check walks up from the new parent.
   * If the old parent cannot be reached the move is refused, unless an administrator overrides, in which
   * case the old parent's count stays too high until it returns.
   */
  async rehome(input: { nodeId: string; newParentId: string; administratorOverride?: boolean }) {
    if (input.newParentId === input.nodeId) throw new Error('A node cannot be rehomed under itself or its own descendant');
    const node = await this.describeNode(input.nodeId);
    if (typeof node === 'string') throw new Error(`The node is not reachable: ${input.nodeId}`);
    if (node.parentId === input.newParentId) return { changed: false as const };
    const above = await this.walkUp(input.newParentId);
    if (above.stoppedAt) throw new Error(`Cannot prove the move makes no cycle: ${above.stoppedAt.nodeId} is ${above.stoppedAt.reason === 'UNREACHABLE' ? 'not reachable' : 'unknown'}`);
    if (above.chain.some((ancestor) => ancestor.id === input.nodeId)) throw new Error('A node cannot be rehomed under itself or its own descendant');
    const newParent = await this.mustPeer(input.newParentId, 'The new parent');
    const oldParent = node.parentId ? await this.peer(node.parentId) : undefined;
    if (node.parentId && !oldParent && !input.administratorOverride) throw new Error(`The old parent is not reachable: ${node.parentId}. An administrator can override.`);
    await newParent.adjustChildCount(input.newParentId, 1);
    await (await this.mustPeer(input.nodeId, 'The node')).setParent(input.nodeId, input.newParentId);
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
  async remove(input: { nodeId: string; childrenParentId?: string }) {
    const node = await this.describeNode(input.nodeId);
    if (typeof node === 'string') throw new Error(`The node is not reachable: ${input.nodeId}`);
    if (node.status !== 'ACTIVE') throw new Error(`Node is retired: ${input.nodeId}`);
    const nodePeer = await this.mustPeer(input.nodeId, 'The node');
    if (node.parentId) {
      const parent = await this.mustPeer(node.parentId, 'The parent');
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
    const inheritor = await this.mustPeer(input.childrenParentId, 'The node taking the children');
    await inheritor.adjustChildCount(input.childrenParentId, node.childCount);
    await nodePeer.setParent(input.nodeId, input.childrenParentId); // so its children can follow the chain
    const retired = await nodePeer.retire(input.nodeId);
    return { parentId: input.childrenParentId, childCount: retired.childCount };
  }

  /**
   * Shortens the node's basis. The issuer is a reachable ancestor, by default the highest one reached by
   * walking up, which gives the shortest basis the rule allows: one level below the highest reachable node.
   * Nodes above a break in the chain are never used, so a number is never taken from an unreachable parent.
   */
  async rollUp(input: { nodeId: string; issuerId?: string }) {
    const node = await this.describeNode(input.nodeId);
    if (typeof node === 'string') throw new Error(`The node is not reachable: ${input.nodeId}`);
    const { chain } = await this.walkUp(input.nodeId);
    const candidates = chain.filter((ancestor) => ancestor.status === 'ACTIVE');
    if (!candidates.length) throw new Error('No reachable ancestor can issue a new basis');
    const issuer = input.issuerId
      ? candidates.find((ancestor) => ancestor.id === input.issuerId)
      : candidates.reduce((best, ancestor) => (segments(ancestor.basis) < segments(best.basis) ? ancestor : best));
    if (!issuer) throw new Error('The issuer must be a reachable ancestor of the node');
    if (segments(issuer.basis) + 1 >= segments(node.basis)) throw new Error('A roll-up must make the basis shorter');
    const fresh = await (await this.mustPeer(issuer.id, 'The issuer')).issueBasis(issuer.id);
    return { issuerId: issuer.id, ...(await (await this.mustPeer(input.nodeId, 'The node')).setBasis(input.nodeId, fresh.value)) };
  }
}
