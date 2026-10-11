import type { NodeDescription } from './local-nodes.js';
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
  accept(input: { id: string; parentId?: string; parentAddress?: string }) { return this.call<NodeDescription>('POST', '/accept', input); }
  issueChildId(id: string) { return this.call<{ value: string; childCount: number }>('POST', '/issue-child', { nodeId: id }); }
  issueBasis(id: string) { return this.call<{ value: string }>('POST', '/issue-basis', { nodeId: id }); }
  setParent(id: string, parentId: string, parentAddress?: string) { return this.call<NodeDescription>('POST', '/set-parent', { nodeId: id, parentId, parentAddress }); }
  setBasis(id: string, basis: string) { return this.call<{ previousBasis: string; basis: string }>('POST', '/set-basis', { nodeId: id, basis }); }
  adjustChildCount(id: string, delta: number) { return this.call<{ childCount: number }>('POST', '/child-count', { nodeId: id, delta }); }
  retire(id: string) { return this.call<{ parentId?: string; childCount: number }>('POST', '/retire', { nodeId: id }); }
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
