import { requireMayHold, type CheckInAnswer, type ChildEntry, type KeyLimits, type NodeDescription, type NodeType } from './local-nodes.js';

/**
 * What one Core can do with a node it holds. `LocalNodes` implements this for the local machine;
 * a remote Core is reached through the same shape. Any call may fail when the machine is not reachable.
 */
export interface NodePeer {
  describe(id: string): Promise<NodeDescription | undefined>;
  accept(input: { id: string; type: NodeType; parentId?: string; parentAddress?: string }): Promise<NodeDescription>;
  children(id: string): Promise<ChildEntry[]>;
  issueChildId(id: string, child: { type: NodeType; address?: string }): Promise<{ value: string; childCount: number }>;
  issueBasis(id: string): Promise<{ value: string }>;
  setParent(id: string, parentId: string, parentAddress?: string): Promise<NodeDescription>;
  setBasis(id: string, basis: string): Promise<{ previousBasis: string; basis: string }>;
  addChildren(id: string, children: ChildEntry[]): Promise<{ childCount: number }>;
  removeChild(id: string, childId: string): Promise<{ removed: boolean; childCount: number }>;
  setChildListComplete(id: string, complete: boolean): Promise<{ childListComplete: boolean }>;
  setKeyLimits(id: string, limits: KeyLimits | null): Promise<NodeDescription>;
  setNextBasis(id: string, input: { basis: string; switchAt: string }): Promise<NodeDescription>;
  retire(id: string): Promise<{ parentId?: string; parentAddress?: string; children: ChildEntry[]; childListComplete: boolean }>;
  acceptRetired(input: { id: string; type: NodeType; replacementId: string; replacementAddress?: string }): Promise<NodeDescription>;
  checkIn(id: string, child: ChildEntry): Promise<CheckInAnswer>;
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

/**
 * One node in a walk down the tree. `lastSeenAt` is from its parent's entry: when it last checked in. `stopped` says
 * why the branch shows no further: its Core did not answer (UNREACHABLE) or did not know it (UNKNOWN), it is another
 * organization (ORGANIZATION, inside-an-organization view), it is retired (RETIRED), the walk reached its depth or size
 * limit (DEPTH, LIMIT), or the node was already shown higher up (CYCLE).
 */
export interface TreeNode {
  id: string;
  type?: NodeType;
  status?: 'ACTIVE' | 'RETIRED';
  address?: string;
  lastSeenAt?: string;
  childCount?: number;
  childListIncomplete?: true;
  /** In the global view, how many of an organization's children are not shown because they are inside it. */
  hiddenChildren?: number;
  stopped?: 'UNREACHABLE' | 'UNKNOWN' | 'ORGANIZATION' | 'RETIRED' | 'DEPTH' | 'LIMIT' | 'CYCLE';
  children: TreeNode[];
}

export interface Ancestry {
  /** Nearest first. Only nodes that answered. */
  chain: ReachedNode[];
  /** Set when the walk stopped because a node could not be reached, or did not exist. */
  stoppedAt?: { nodeId: string; reason: 'UNREACHABLE' | 'UNKNOWN' };
}

const segments = (basis: string) => basis.split('-').length;

/**
 * The part of a walk up that is inside the node's own organization: everything up to and including its nearest
 * ORGANIZATION ancestor. An organization node is its own organization, so nothing above it is inside. When the walk
 * found no organization (none above, or it stopped at an unreachable node first), everything it reached is inside.
 */
const insideOrganization = (node: NodeDescription, chain: ReachedNode[]) => {
  if (node.type === 'ORGANIZATION') return [];
  const at = chain.findIndex((ancestor) => ancestor.type === 'ORGANIZATION');
  return at < 0 ? chain : chain.slice(0, at + 1);
};

/**
 * The ancestors a roll-up may use. Inside the node's own organization, unless the node's basis has more segments
 * than that organization's segment limit: then any reachable ancestor, a parent organization or above. The
 * organization is the node itself when it is an organization node, otherwise its nearest organization ancestor.
 */
const organizationOf = (node: NodeDescription, chain: ReachedNode[]) => (node.type === 'ORGANIZATION' ? node : chain.find((ancestor) => ancestor.type === 'ORGANIZATION'));
const rollUpCandidates = (node: NodeDescription, chain: ReachedNode[]) => {
  const limit = organizationOf(node, chain)?.keyLimits?.maxSegments;
  return limit !== undefined && segments(node.basis) > limit ? chain : insideOrganization(node, chain);
};

/**
 * Where a basis breaks the organization's limits, in words. The segments already there may have come from above,
 * issued under a parent organization's rules; nothing inside the organization can change them, so this is a note,
 * never a refusal. The last segment of a basis is a value issued for a node, so maxSegmentLength applies to it too.
 */
export function limitNotes(basis: string, limits?: KeyLimits): string[] {
  if (!limits) return [];
  const parts = basis.split('-'), notes: string[] = [];
  if (limits.maxSegments !== undefined && parts.length > limits.maxSegments) notes.push(`The basis ${basis} has ${parts.length} segments, more than the organization's limit of ${limits.maxSegments}`);
  const long = limits.maxSegmentLength === undefined ? [] : parts.filter((part) => part.length > limits.maxSegmentLength!);
  if (long.length) notes.push(`The basis ${basis} has ${long.length === 1 ? 'a segment' : 'segments'} (${long.join(', ')}) longer than the organization's limit of ${limits.maxSegmentLength} characters, issued under the rules of the node that issued it`);
  return notes;
}

/**
 * Chooses the ancestor to issue a new basis. The new basis will be that ancestor's basis plus one value from its
 * counter, so the ancestors are ranked by what they would give: first one whose basis leaves room within the
 * organization's limits (the new basis would have no more segments than allowed, and no segment of the ancestor's
 * basis is longer than allowed), then the fewest segments, then the fewest characters. The value the ancestor will
 * add is not known until it is issued; any note about it is made afterwards.
 */
const chooseIssuer = (candidates: ReachedNode[], limits?: KeyLimits) => {
  const fits = (ancestor: ReachedNode) => (limits?.maxSegments === undefined || segments(ancestor.basis) + 1 <= limits.maxSegments)
    && (limits?.maxSegmentLength === undefined || ancestor.basis.split('-').every((part) => part.length <= limits.maxSegmentLength!));
  const rank = (ancestor: ReachedNode) => [fits(ancestor) ? 0 : 1, segments(ancestor.basis), ancestor.basis.length] as const;
  return candidates.reduce((best, ancestor) => {
    const [a, b] = [rank(ancestor), rank(best)];
    return a[0] < b[0] || (a[0] === b[0] && (a[1] < b[1] || (a[1] === b[1] && a[2] < b[2]))) ? ancestor : best;
  });
};

/**
 * An entry on one node's list leaves out the address when the child is on the same Core as that node. When the
 * entries move to a node on another Core, the address they were relative to is written in.
 */
const relocate = (entries: ChildEntry[], fromAddress?: string): ChildEntry[] => entries.map((child) => (child.address || !fromAddress ? child : { ...child, address: fromAddress }));

/**
 * Operations that involve several machines, built from the single-node operations.
 *
 * Every procedure orders its steps so that a failure part-way leaves a list of children with an entry too many
 * and never one too few: a child is added to its new parent before it is taken off its old one. The child's own
 * pointer remains the truth. Nothing here is cached: each call asks again.
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

  /**
   * Walks down from a node by asking each Core in turn for the node's list of children. Two views: `organization`
   * shows everything below the starting node and stops at any other organization; `global` shows only organizations,
   * stopping at each one and counting what is inside it. What it shows is what the lists say, with each node's last
   * check-in; it is never the basis of a decision. A Core that does not answer ends that branch, and nothing is guessed.
   */
  async walkDown(input: { nodeId: string; nodeAddress?: string; view?: 'organization' | 'global'; maxDepth?: number; maxNodes?: number }): Promise<TreeNode> {
    const view = input.view ?? 'organization';
    const maxDepth = Math.min(Math.max(input.maxDepth ?? 12, 0), 50), maxNodes = Math.min(Math.max(input.maxNodes ?? 1000, 1), 5000);
    const seen = new Set<string>();
    let count = 0;
    const visit = async (id: string, address: string | undefined, depth: number, entry?: ChildEntry): Promise<TreeNode> => {
      count += 1;
      const base: TreeNode = { id, ...(entry?.type ? { type: entry.type } : {}), ...(address ? { address } : {}), ...(entry?.lastSeenAt ? { lastSeenAt: entry.lastSeenAt } : {}), children: [] };
      if (seen.has(id)) return { ...base, stopped: 'CYCLE' };
      seen.add(id);
      const node = await this.describeNode(id, address);
      if (typeof node === 'string') return { ...base, stopped: node };
      const shown: TreeNode = { ...base, type: node.type, status: node.status, childCount: node.childCount, ...(node.childListIncomplete ? { childListIncomplete: true as const } : {}) };
      if (node.status !== 'ACTIVE') return { ...shown, stopped: 'RETIRED' };
      if (depth > 0 && node.type === 'ORGANIZATION' && view === 'organization') return { ...shown, stopped: 'ORGANIZATION' };
      if (!node.childCount) return shown;
      if (depth >= maxDepth) return { ...shown, stopped: 'DEPTH' };
      let entries: ChildEntry[];
      try { entries = await (await this.mustPeer(id, 'The node', address)).children(id); } catch { return { ...shown, stopped: 'UNREACHABLE' }; }
      let hidden = 0;
      if (view === 'global' && node.type === 'ORGANIZATION') { hidden = entries.filter((child) => child.type !== 'ORGANIZATION').length; entries = entries.filter((child) => child.type === 'ORGANIZATION'); }
      for (const child of entries) {
        if (count >= maxNodes) return { ...shown, ...(hidden ? { hiddenChildren: hidden } : {}), stopped: 'LIMIT' };
        shown.children.push(await visit(child.childId, child.address ?? address, depth + 1, child));
      }
      return { ...shown, ...(hidden ? { hiddenChildren: hidden } : {}) };
    };
    return visit(input.nodeId, input.nodeAddress, 0);
  }

  /** The nearest live ancestor, for a child whose parent was retired. Retired nodes keep their own pointer. */
  async nearestLiveAncestor(nodeId: string, address?: string) {
    const { chain, stoppedAt } = await this.walkUp(nodeId, address);
    return { ancestor: chain.find((node) => node.status === 'ACTIVE'), stoppedAt };
  }

  /**
   * A child follows the chain past a retired parent and fixes its own pointer, adding itself to its new parent's
   * list first. This is how a node that replaced a lost one learns its children. Does nothing when the parent is
   * live or cannot be reached.
   */
  async repairParent(nodeId: string, address?: string) {
    const node = await this.describeNode(nodeId, address);
    if (typeof node === 'string' || !node.parentId) return { changed: false as const };
    const parent = await this.describeNode(node.parentId, node.parentAddress);
    if (typeof parent === 'string' || parent.status === 'ACTIVE') return { changed: false as const };
    const { ancestor } = await this.nearestLiveAncestor(nodeId, address);
    if (!ancestor) return { changed: false as const };
    await (await this.mustPeer(ancestor.id, 'The ancestor', ancestor.address)).addChildren(ancestor.id, [{ childId: nodeId, type: node.type, ...(address ? { address } : {}) }]);
    await (await this.mustPeer(nodeId, 'Node', address)).setParent(nodeId, ancestor.id, ancestor.address);
    return { changed: true as const, parentId: ancestor.id };
  }

  /**
   * Creates a node: the parent's Core issues the ID and puts the child on its list, and the new node's own Core
   * records it. Also covers installing a machine and adding a user, where the issuer is an organization node.
   * If recording fails, the ID is left unused. The entry is taken off the parent's list only when the new node's
   * Core says plainly that it does not hold the node; if that cannot be known, the entry stays, one too many.
   */
  async createNode(input: { parentId: string; parentAddress?: string; type: NodeType; newNodePeer: NodePeer; newNodeAddress?: string }) {
    const parent = await this.mustPeer(input.parentId, 'The issuing parent', input.parentAddress);
    const issued = await parent.issueChildId(input.parentId, { type: input.type, ...(input.newNodeAddress ? { address: input.newNodeAddress } : {}) });
    try {
      return await input.newNodePeer.accept({ id: issued.value, type: input.type, parentId: input.parentId, parentAddress: input.parentAddress });
    } catch (error) {
      let held: boolean | undefined;
      try { held = Boolean(await input.newNodePeer.describe(issued.value)); } catch { held = undefined; }
      if (held === false) await parent.removeChild(input.parentId, issued.value).catch(() => undefined);
      throw error;
    }
  }

  /**
   * Makes an ID that was already issued, and never used as a node, into a node. Nothing is issued: the ID keeps the
   * value it was given. The caller has checked that the ID was issued and what it was issued for. With a parent, the
   * parent lists the node first, so a failure leaves one entry too many; without one, the node is a top node.
   */
  async placeIssued(input: { id: string; type: NodeType; parentId?: string; parentAddress?: string; nodePeer: NodePeer; nodeAddress?: string }) {
    if (input.parentId === input.id) throw new Error('A node cannot be its own parent');
    if (await input.nodePeer.describe(input.id)) throw new Error(`${input.id} is already a node`);
    const parent = input.parentId ? await this.mustPeer(input.parentId, 'The parent', input.parentAddress) : undefined;
    if (parent && input.parentId) await parent.addChildren(input.parentId, [{ childId: input.id, type: input.type, ...(input.nodeAddress ? { address: input.nodeAddress } : {}) }]);
    try {
      return await input.nodePeer.accept({ id: input.id, type: input.type, parentId: input.parentId, parentAddress: input.parentAddress });
    } catch (error) {
      let held: boolean | undefined;
      try { held = Boolean(await input.nodePeer.describe(input.id)); } catch { held = undefined; }
      if (parent && input.parentId && held === false) await parent.removeChild(input.parentId, input.id).catch(() => undefined);
      throw error;
    }
  }

  /** Inserts a new node between a node and its parent. */
  async insertAbove(input: { childId: string; childAddress?: string; type: NodeType; newNodePeer: NodePeer; newNodeAddress?: string }) {
    const child = await this.describeNode(input.childId, input.childAddress);
    if (typeof child === 'string') throw new Error(`The node is not reachable: ${input.childId}`);
    if (!child.parentId) throw new Error('A top node has no parent to insert under');
    requireMayHold({ id: 'the new node', type: input.type }, { childId: input.childId, type: child.type }); // checked before anything is issued
    const parentId = child.parentId;
    const parent = await this.mustPeer(parentId, 'The parent', child.parentAddress);
    const issued = await parent.issueChildId(parentId, { type: input.type, ...(input.newNodeAddress ? { address: input.newNodeAddress } : {}) });
    await input.newNodePeer.accept({ id: issued.value, type: input.type, parentId, parentAddress: child.parentAddress });
    await input.newNodePeer.addChildren(issued.value, [{ childId: input.childId, type: child.type, ...(input.childAddress ? { address: input.childAddress } : {}) }]);
    await (await this.mustPeer(input.childId, 'The node', input.childAddress)).setParent(input.childId, issued.value, input.newNodeAddress);
    await parent.removeChild(parentId, input.childId);              // the parent gave up the child; last, so a failure leaves one too many
    return { id: issued.value, parentId };
  }

  /**
   * Adds a parent above a top node, so the tree can grow from the ground up. The top node has no parent to
   * issue the new node's ID, so another node issues it: the one named, or the one with the shortest basis
   * among the top node itself and the nodes offered in `alsoConsider`. A shorter basis keeps the new ID short,
   * and any counter gives a unique value, so the choice of issuer never affects uniqueness.
   * The value is the issuer's basis plus its next number, and is not the issuer's child, so its list is unchanged.
   * The new node lists the top node as its child before the top node points to it.
   */
  async addParentAbove(input: { nodeId: string; nodeAddress?: string; type: NodeType; newNodePeer: NodePeer; newNodeAddress?: string; issuerId?: string; issuerAddress?: string; alsoConsider?: Array<{ id: string; basis: string; address?: string }> }) {
    const top = await this.describeNode(input.nodeId, input.nodeAddress);
    if (typeof top === 'string') throw new Error(`The node is not reachable: ${input.nodeId}`);
    if (top.status !== 'ACTIVE') throw new Error(`Node is retired: ${input.nodeId}`);
    if (top.parentId) throw new Error('This node already has a parent. Use insert-above to put a node between them');
    requireMayHold({ id: 'the new parent', type: input.type }, { childId: input.nodeId, type: top.type }); // checked before anything is issued
    const candidates = [{ id: top.id, basis: top.basis, address: input.nodeAddress }, ...(input.alsoConsider ?? [])];
    const issuer = input.issuerId
      ? { id: input.issuerId, address: input.issuerAddress }
      : candidates.reduce((best, candidate) => (segments(candidate.basis) < segments(best.basis) || (segments(candidate.basis) === segments(best.basis) && candidate.basis.length < best.basis.length) ? candidate : best));
    const fresh = await (await this.mustPeer(issuer.id, 'The issuer', issuer.address)).issueBasis(issuer.id);
    await input.newNodePeer.accept({ id: fresh.value, type: input.type });
    await input.newNodePeer.addChildren(fresh.value, [{ childId: input.nodeId, type: top.type, ...(input.nodeAddress ? { address: input.nodeAddress } : {}) }]);
    await (await this.mustPeer(input.nodeId, 'The node', input.nodeAddress)).setParent(input.nodeId, fresh.value, input.newNodeAddress);
    return { id: fresh.value, childId: input.nodeId, issuerId: issuer.id };
  }

  /**
   * Records that a node was lost and names the node that replaced it. The replacement already exists: it was
   * created like any other node, with a new ID that is its new basis. This marks the replacement's list of
   * children as possibly incomplete, records the lost ID as retired on the replacement's Core with its pointer
   * naming the replacement, and takes the lost node off its old parent's list.
   *
   * The lost node's own list is gone with it, so its children are not contacted. Each one finds its parent
   * retired when it next connects, follows the pointer to the replacement and adds itself to the replacement's
   * list (see repairParent). For that the retired record must be at the address the children already hold.
   * Until an administrator says the list is complete, the replacement is never treated as childless.
   * If the old parent cannot be reached, its list keeps the lost node, one entry too many.
   */
  async replaceLost(input: { lostId: string; type: NodeType; replacementId: string; replacementAddress?: string; lostParentId?: string; lostParentAddress?: string }) {
    if (input.replacementId === input.lostId) throw new Error('A lost node needs a different node as its replacement');
    if (input.lostParentId === input.lostId) throw new Error('A node cannot be its own parent');
    const replacement = await this.describeNode(input.replacementId, input.replacementAddress);
    if (typeof replacement === 'string') throw new Error(`The replacement is not reachable: ${input.replacementId}`);
    if (replacement.status !== 'ACTIVE') throw new Error(`Node is retired: ${input.replacementId}`);
    const holder = await this.mustPeer(input.replacementId, 'The replacement', input.replacementAddress);
    if (await holder.describe(input.lostId)) throw new Error(`Node ${input.lostId} is still recorded on the replacement's Core, so it is not lost. Use remove instead`);
    await holder.setChildListComplete(input.replacementId, false);
    await holder.acceptRetired({ id: input.lostId, type: input.type, replacementId: input.replacementId, replacementAddress: input.replacementAddress });
    let oldParentListStale = false;
    if (input.lostParentId) {
      const parent = await this.peer(input.lostParentId, input.lostParentAddress);
      if (parent) { try { await parent.removeChild(input.lostParentId, input.lostId); } catch { oldParentListStale = true; } } else oldParentListStale = true;
    }
    return { lostId: input.lostId, replacementId: input.replacementId, oldParentListStale };
  }

  /**
   * Moves a node, and its subtree, under a new parent. Only moving a node under itself is refused:
   * a cycle needs an operator to move a node under its own descendant, and walking up to prove otherwise
   * would let an offline machine block a legitimate move. If a cycle ever formed, walking up reports it.
   * If the old parent cannot be reached the move is refused, unless an administrator overrides, in which
   * case the old parent's list keeps the node, one entry too many, until it returns.
   */
  async rehome(input: { nodeId: string; nodeAddress?: string; newParentId: string; newParentAddress?: string; administratorOverride?: boolean }) {
    if (input.newParentId === input.nodeId) throw new Error('A node cannot be its own parent');
    const node = await this.describeNode(input.nodeId, input.nodeAddress);
    if (typeof node === 'string') throw new Error(`The node is not reachable: ${input.nodeId}`);
    if (node.parentId === input.newParentId) return { changed: false as const };
    const newParent = await this.mustPeer(input.newParentId, 'The new parent', input.newParentAddress);
    const oldParent = node.parentId ? await this.peer(node.parentId, node.parentAddress) : undefined;
    if (node.parentId && !oldParent && !input.administratorOverride) throw new Error(`The old parent is not reachable: ${node.parentId}. An administrator can override.`);
    await newParent.addChildren(input.newParentId, [{ childId: input.nodeId, type: node.type, ...(input.nodeAddress ? { address: input.nodeAddress } : {}) }]);
    await (await this.mustPeer(input.nodeId, 'The node', input.nodeAddress)).setParent(input.nodeId, input.newParentId, input.newParentAddress);
    let oldParentListStale = false;
    if (node.parentId) {
      if (oldParent) { try { await oldParent.removeChild(node.parentId, input.nodeId); } catch { oldParentListStale = true; } } else oldParentListStale = true;
    }
    return { changed: true as const, oldParentListStale };
  }

  /**
   * Retires a node. Its children go on its parent's list, and the node comes off it, in that order. Their
   * pointers are not rewritten: the retired node keeps its own pointer and each child follows it later (see
   * repairParent). If the node's list may be incomplete, so may the parent's be afterwards. The top of an
   * organization has no parent, so the caller must say which node takes its children. A node is childless only
   * when its list is empty and known to be complete.
   */
  async remove(input: { nodeId: string; nodeAddress?: string; childrenParentId?: string; childrenParentAddress?: string }) {
    const node = await this.describeNode(input.nodeId, input.nodeAddress);
    if (typeof node === 'string') throw new Error(`The node is not reachable: ${input.nodeId}`);
    if (node.status !== 'ACTIVE') throw new Error(`Node is retired: ${input.nodeId}`);
    const nodePeer = await this.mustPeer(input.nodeId, 'The node', input.nodeAddress);
    const children = relocate(await nodePeer.children(input.nodeId), input.nodeAddress);
    const incomplete = node.childListIncomplete === true;
    if (node.parentId) {
      const parent = await this.mustPeer(node.parentId, 'The parent', node.parentAddress);
      const toParent = children.filter((child) => child.childId !== node.parentId);  // a node never lists itself
      if (toParent.length) await parent.addChildren(node.parentId, toParent);
      if (incomplete) await parent.setChildListComplete(node.parentId, false);
      await nodePeer.retire(input.nodeId);
      await parent.removeChild(node.parentId, input.nodeId);
      return { parentId: node.parentId, childCount: children.length };
    }
    if (!children.length && !incomplete) {
      await nodePeer.retire(input.nodeId);
      return { parentId: undefined, childCount: 0 };
    }
    if (!input.childrenParentId) throw new Error(incomplete && !children.length ? 'This node has no parent and its list of children may be incomplete. Name childrenParentId to say which node takes any children it has' : 'This node has no parent. Name childrenParentId to say which node takes its children');
    if (input.childrenParentId === input.nodeId) throw new Error('Children cannot be given to the node being removed');
    const inheritor = await this.mustPeer(input.childrenParentId, 'The node taking the children', input.childrenParentAddress);
    const toInheritor = children.filter((child) => child.childId !== input.childrenParentId);  // the heir may be one of the children; it never lists itself
    if (toInheritor.length) await inheritor.addChildren(input.childrenParentId, toInheritor);
    if (incomplete) await inheritor.setChildListComplete(input.childrenParentId, false);
    await nodePeer.setParent(input.nodeId, input.childrenParentId, input.childrenParentAddress); // so its children can follow the chain
    await nodePeer.retire(input.nodeId);
    return { parentId: input.childrenParentId, childCount: children.length };
  }

  /**
   * Checks a node's list against its children's own pointers. An entry is dropped only on the child's word: when
   * the child answers and names a different parent, or says it is retired. A child that cannot be reached, or whose
   * Core does not know it, keeps its entry.
   */
  async checkChildren(input: { nodeId: string; nodeAddress?: string }) {
    const parent = await this.mustPeer(input.nodeId, 'The node', input.nodeAddress);
    const kept: string[] = [], dropped: string[] = [], unreachable: string[] = [], unknown: string[] = [];
    for (const child of await parent.children(input.nodeId)) {
      const answer = await this.describeNode(child.childId, child.address ?? input.nodeAddress);
      if (answer === 'UNREACHABLE') { unreachable.push(child.childId); continue; }
      if (answer === 'UNKNOWN') { unknown.push(child.childId); continue; }
      if (answer.parentId !== input.nodeId || answer.status === 'RETIRED') { await parent.removeChild(input.nodeId, child.childId); dropped.push(child.childId); continue; }
      kept.push(child.childId);
    }
    return { kept, dropped, unreachable, unknown };
  }

  /**
   * A node checks in with its own parent, which stamps the time on the node's entry in its list, adding the entry if
   * it was missing. A parent that is retired answers with its own pointer, and the node then follows the chain to the
   * nearest live ancestor (repairParent). The time is what the tree view shows; it is never the basis of a decision.
   * `nodeAddress` is where the node's own Core is reached; the entry leaves it out when parent and node share a Core.
   */
  async checkIn(input: { nodeId: string; nodeAddress?: string }) {
    const node = await this.describeNode(input.nodeId, input.nodeAddress);
    if (typeof node === 'string') throw new Error(`The node is not reachable: ${input.nodeId}`);
    if (node.status !== 'ACTIVE') return { state: 'RETIRED' as const };
    if (!node.parentId) return { state: 'TOP' as const };
    const parentId = node.parentId;
    const parent = await this.peer(parentId, node.parentAddress);
    if (!parent) return { state: 'UNREACHABLE' as const, parentId };
    const sameCore = !node.parentAddress || node.parentAddress === input.nodeAddress;
    const answer = await parent.checkIn(parentId, { childId: input.nodeId, type: node.type, ...(!sameCore && input.nodeAddress ? { address: input.nodeAddress } : {}) });
    if (answer.status === 'RETIRED') {
      const repaired = await this.repairParent(input.nodeId, input.nodeAddress);
      return { state: 'PARENT_RETIRED' as const, parentId, ...(repaired.changed ? { newParentId: repaired.parentId } : {}) };
    }
    return { state: 'CHECKED_IN' as const, parentId, lastSeenAt: answer.lastSeenAt, ...(answer.added ? { addedToList: true as const } : {}) };
  }

  /** Sets, changes or clears an organization's key limits, on its organization node's own Core. */
  async setKeyLimits(input: { nodeId: string; nodeAddress?: string; limits: KeyLimits | null }) {
    return (await this.mustPeer(input.nodeId, 'The organization node', input.nodeAddress)).setKeyLimits(input.nodeId, input.limits);
  }

  /**
   * Fetches a basis early and keeps it ready on the node, to take over when its counter would pass `switchAt`. The
   * issuer is chosen as for a roll-up: an ancestor inside the node's organization, the highest reachable one, or
   * outside it when the basis is over the organization's segment limit. Unlike a roll-up the new basis need not be
   * shorter: it renews the counter, it does not shorten the ID. A node that already has one keeps it.
   */
  async prepareNextBasis(input: { nodeId: string; nodeAddress?: string; switchAt: bigint }) {
    const node = await this.describeNode(input.nodeId, input.nodeAddress);
    if (typeof node === 'string') throw new Error(`The node is not reachable: ${input.nodeId}`);
    if (node.status !== 'ACTIVE') throw new Error(`Node is retired: ${input.nodeId}`);
    if (node.nextBasis) return { issuerId: undefined, nextBasis: node.nextBasis, switchAt: node.switchAt, alreadyReady: true as const };
    const { chain } = await this.walkUp(input.nodeId, input.nodeAddress);
    const candidates = rollUpCandidates(node, chain).filter((ancestor) => ancestor.status === 'ACTIVE');
    if (!candidates.length) throw new Error('No reachable ancestor inside the node\'s organization can issue a ready basis');
    const limits = organizationOf(node, chain)?.keyLimits;
    const issuer = chooseIssuer(candidates, limits);
    const fresh = await (await this.mustPeer(issuer.id, 'The issuer', issuer.address)).issueBasis(issuer.id);
    const after = await (await this.mustPeer(input.nodeId, 'The node', input.nodeAddress)).setNextBasis(input.nodeId, { basis: fresh.value, switchAt: input.switchAt.toString() });
    const notes = after.nextBasis === fresh.value ? limitNotes(fresh.value, limits) : [];
    return { issuerId: issuer.id, nextBasis: after.nextBasis, switchAt: after.switchAt, alreadyReady: false as const, ...(notes.length ? { notes } : {}) };
  }

  /** An administrator says whether a node's list of children is complete. */
  async markChildList(input: { nodeId: string; nodeAddress?: string; complete: boolean }) {
    return (await this.mustPeer(input.nodeId, 'The node', input.nodeAddress)).setChildListComplete(input.nodeId, input.complete);
  }

  /**
   * Shortens the node's basis. The issuer is a reachable ancestor inside the node's own organization: its nearest
   * ORGANIZATION ancestor or a node between that and the node. By default it is the one with the shortest basis,
   * the highest the walk reached inside the organization. Nodes above a break in the chain are never used, so a
   * number is never taken from an unreachable parent. Going outside the organization is allowed only when the
   * node's basis has more segments than that organization's segment limit (maxSegments); with no limit set, a
   * roll-up never leaves the organization. An organization node has nothing above it inside itself, so it rolls up
   * only when it is over its own limit. A node with no organization above it may use any reachable ancestor.
   */
  async rollUp(input: { nodeId: string; nodeAddress?: string; issuerId?: string }) {
    const node = await this.describeNode(input.nodeId, input.nodeAddress);
    if (typeof node === 'string') throw new Error(`The node is not reachable: ${input.nodeId}`);
    const { chain } = await this.walkUp(input.nodeId, input.nodeAddress);
    const candidates = rollUpCandidates(node, chain).filter((ancestor) => ancestor.status === 'ACTIVE');
    if (!candidates.length) throw new Error(node.type === 'ORGANIZATION'
      ? 'An organization node has no ancestor inside its own organization to issue a new basis. It may go to a parent organization only when its basis has more segments than its own segment limit (maxSegments)'
      : 'No reachable ancestor inside the node\'s organization can issue a new basis');
    const limits = organizationOf(node, chain)?.keyLimits;
    const shorter = candidates.filter((ancestor) => segments(ancestor.basis) + 1 < segments(node.basis));
    const issuer = input.issuerId
      ? candidates.find((ancestor) => ancestor.id === input.issuerId)
      : (shorter.length ? chooseIssuer(shorter, limits) : candidates[0]);
    if (!issuer) throw new Error("The issuer must be a reachable ancestor inside the node's own organization, unless its basis is over the organization's segment limit (maxSegments)");
    if (segments(issuer.basis) + 1 >= segments(node.basis)) throw new Error('A roll-up must make the basis shorter');
    const fresh = await (await this.mustPeer(issuer.id, 'The issuer', issuer.address)).issueBasis(issuer.id);
    const set = await (await this.mustPeer(input.nodeId, 'The node', input.nodeAddress)).setBasis(input.nodeId, fresh.value);
    const notes = limitNotes(set.basis, limits);
    return { issuerId: issuer.id, ...set, ...(notes.length ? { notes } : {}) };
  }
}
