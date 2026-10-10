import type { CoreHostAuthorization } from './types.js';

/** Local-first starter policy. Production adapters replace this with Core policy evaluation. */
export class LocalCoreHostAuthorization implements CoreHostAuthorization {
  constructor(private readonly administratorIds: ReadonlySet<string> = new Set()) {}
  async canRead(input: { actorId: string | null }) { return input.actorId !== null && this.administratorIds.has(input.actorId); }
  async canAdminister(input: { actorId: string | null }) { return input.actorId !== null && this.administratorIds.has(input.actorId); }
}

/**
 * Transitional application authentication.  A client secret proves which
 * registered application is calling; it never substitutes for a human user
 * in command and audit payloads.  Policy evaluation remains in Foundation.
 */
export class FoundationPolicyAuthorization implements CoreHostAuthorization {
  private readonly clients = new Map<string, string>();
  constructor(private readonly policyUrl: string, private readonly policyKey: string, clients: Array<{ applicationKey: string; secret: string }>) {
    for (const client of clients) if (client.applicationKey && client.secret) this.clients.set(client.applicationKey, client.secret);
  }
  private async evaluate(actorId: string | null, resource: string) {
    if (!actorId || !this.clients.has(actorId)) return false;
    const response = await fetch(`${this.policyUrl}/v1/access/policy/evaluate`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-sema-access-policy-key': this.policyKey },
      body: JSON.stringify({ applicationKey: actorId, operation: resource }),
    });
    if (!response.ok) return false;
    const value = await response.json() as { allowed?: boolean };
    return value.allowed === true;
  }
  async canRead(input: { actorId: string | null; resource: string }) { return this.evaluate(input.actorId, input.resource); }
  async canAdminister(input: { actorId: string | null; resource: string }) { return this.evaluate(input.actorId, input.resource); }
}
