import type { CheckInAnswer, ChildEntry, KeyLimits, NodeDescription, NodeType, SeatView, Shutdown, Suspension } from './local-nodes.js';
import type { AddressedPeers, NodePeer } from './conversations.js';

export interface PeerCredentials { applicationKey: string; secret: string }

/**
 * Talks to another Core over HTTP using the node routes. Authentication is the shared application
 * credential for now; per-node signed requests replace it later without changing the shape of this class.
 */
export class HttpNodePeer implements NodePeer {
  constructor(private readonly baseUrl: string, private readonly credentials: PeerCredentials, private readonly timeoutMs = 10_000) {}

  private async call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${this.baseUrl.replace(/\/$/, '')}/v1/core/topology/nodes${path}`, {
      method,
      headers: { 'x-sema-application-key': this.credentials.applicationKey, 'x-sema-application-secret': this.credentials.secret, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const payload = await response.json().catch(() => null) as T | { error?: { message?: string } } | null;
    if (!response.ok) throw new Error((payload && typeof payload === 'object' && 'error' in payload ? payload.error?.message : undefined) ?? `Core request failed (${response.status})`);
    return payload as T;
  }

  async describe(id: string) { return (await this.call<NodeDescription | null>('GET', `?id=${encodeURIComponent(id)}`)) ?? undefined; }
  accept(input: { id: string; type: NodeType; parentId?: string; parentAddress?: string }) { return this.call<NodeDescription>('POST', '/accept', input); }
  async children(id: string) { return this.call<ChildEntry[]>('GET', `/children?id=${encodeURIComponent(id)}`); }
  issueChildId(id: string, child: { type: NodeType; address?: string }) { return this.call<{ value: string; childCount: number }>('POST', '/issue-child', { nodeId: id, ...child }); }
  issueBasis(id: string) { return this.call<{ value: string }>('POST', '/issue-basis', { nodeId: id }); }
  setParent(id: string, parentId: string, parentAddress?: string) { return this.call<NodeDescription>('POST', '/set-parent', { nodeId: id, parentId, parentAddress }); }
  setBasis(id: string, basis: string) { return this.call<{ previousBasis: string; basis: string }>('POST', '/set-basis', { nodeId: id, basis }); }
  addChildren(id: string, children: ChildEntry[]) { return this.call<{ childCount: number }>('POST', '/add-children', { nodeId: id, children }); }
  removeChild(id: string, childId: string) { return this.call<{ removed: boolean; childCount: number }>('POST', '/remove-child', { nodeId: id, childId }); }
  setChildListComplete(id: string, complete: boolean) { return this.call<{ childListComplete: boolean }>('POST', '/child-list-complete', { nodeId: id, complete }); }
  setKeyLimits(id: string, limits: KeyLimits | null) { return this.call<NodeDescription>('POST', '/key-limits', { nodeId: id, limits }); }
  setNextBasis(id: string, input: { basis: string; switchAt: string }) { return this.call<NodeDescription>('POST', '/next-basis', { nodeId: id, ...input }); }
  retire(id: string) { return this.call<{ parentId?: string; parentAddress?: string; children: ChildEntry[]; childListComplete: boolean }>('POST', '/retire', { nodeId: id }); }
  acceptRetired(input: { id: string; type: NodeType; replacementId: string; replacementAddress?: string }) { return this.call<NodeDescription>('POST', '/accept-retired', input); }
  checkIn(id: string, child: ChildEntry) { return this.call<CheckInAnswer>('POST', '/check-in', { nodeId: id, childId: child.childId, type: child.type, ...(child.address ? { address: child.address } : {}) }); }
  setShutdown(id: string, shutdown: Shutdown | null) { return this.call<NodeDescription>('POST', '/shutdown', { nodeId: id, shutdown }); }
  markChild(id: string, child: { childId: string; type?: NodeType; address?: string }, suspension: Suspension | null) { return this.call<{ marked: boolean }>('POST', '/mark-child', { nodeId: id, ...child, suspension }); }
  retireChild(id: string, child: { childId: string; type?: NodeType; address?: string }, retired: Suspension) { return this.call<{ retired: true; childCount: number }>('POST', '/retire-child', { nodeId: id, ...child, retired }); }
  changeSeats(id: string, change: { users?: number; machines?: number }) { return this.call<SeatView>('POST', '/seat-change', { nodeId: id, ...change }); }
  setSeatLimits(id: string, limits: { users?: number | null; machines?: number | null }) { return this.call<SeatView>('POST', '/seat-limits', { nodeId: id, ...limits }); }
  setSeatsUsed(id: string, counted: { users: number; machines: number }, complete: boolean) { return this.call<SeatView>('POST', '/seat-count', { nodeId: id, ...counted, complete }); }
}

/**
 * A Core that has no identity yet, reached only to give it one. It answers a single request, join, which
 * records the node another Core issued for it. The join code was set on that machine before its first start.
 * It holds no nodes yet: asked about a node, it says it has none while it is still waiting, and every other
 * question is an error.
 */
export function joiningPeer(baseUrl: string, joinCode: string, timeoutMs = 10_000): NodePeer {
  const notYet = async (): Promise<never> => { throw new Error('A Core that has not joined yet holds no nodes'); };
  return {
    async accept(input) {
      if (input.type !== 'MACHINE') throw new Error('A joining Core is recorded as a MACHINE node');
      if (!input.parentId) throw new Error('A joining Core needs the parent that issued its ID');
      const response = await fetch(`${baseUrl.replace(/\/$/, '')}/v1/core/join`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: input.id, parentId: input.parentId, parentAddress: input.parentAddress, joinCode }), signal: AbortSignal.timeout(timeoutMs) });
      const payload = await response.json().catch(() => null) as NodeDescription | { error?: { message?: string } } | null;
      if (!response.ok) throw new Error((payload && typeof payload === 'object' && 'error' in payload ? payload.error?.message : undefined) ?? `The new Core refused to join (${response.status})`);
      return payload as NodeDescription;
    },
    // A Core still waiting to be joined plainly holds no node. Once it has joined, this peer cannot ask it anything.
    async describe() {
      const response = await fetch(`${baseUrl.replace(/\/$/, '')}/v1/core/health`, { signal: AbortSignal.timeout(timeoutMs) });
      const payload = await response.json().catch(() => null) as { status?: string } | null;
      if (response.ok && payload?.status === 'NOT_JOINED') return undefined;
      throw new Error('The Core at this address has joined a system; ask it through the node routes');
    },
    setKeyLimits: notYet, setNextBasis: notYet, children: notYet, issueChildId: notYet, issueBasis: notYet, setParent: notYet, setBasis: notYet, addChildren: notYet, removeChild: notYet, setChildListComplete: notYet, retire: notYet, acceptRetired: notYet, checkIn: notYet, setShutdown: notYet, markChild: notYet, retireChild: notYet, changeSeats: notYet, setSeatLimits: notYet, setSeatsUsed: notYet,
  };
}

/**
 * Finds a node's Core by the address stored beside the pointer that led to it. A node held on this
 * machine is answered locally. Nothing is cached, so a rehome or a moved machine never leaves stale entries here.
 */
export class HttpPeerDirectory implements AddressedPeers {
  constructor(private readonly options: { credentials: PeerCredentials; local?: { address: string; peer: NodePeer } }) {}
  async find(nodeId: string, address?: string) {
    if (!address) return this.options.local?.peer;
    if (this.options.local && address === this.options.local.address) return this.options.local.peer;
    const peer = new HttpNodePeer(address, this.options.credentials);
    // Reachable means it answers right now. A machine that is down or refuses us is simply not found.
    try { await peer.describe(nodeId); } catch { return undefined; }
    return peer;
  }
  /** The Core at an address, or undefined when it does not answer now. Used to place a new node on a named machine. */
  async at(address: string) {
    if (this.options.local && address === this.options.local.address) return this.options.local.peer;
    const peer = new HttpNodePeer(address, this.options.credentials);
    try { await peer.describe('probe'); } catch { return undefined; }
    return peer;
  }
}
