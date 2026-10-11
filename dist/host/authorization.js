/** Local-first starter policy. Production adapters replace this with Core policy evaluation. */
export class LocalCoreHostAuthorization {
    administratorIds;
    constructor(administratorIds = new Set()) {
        this.administratorIds = administratorIds;
    }
    async canRead(input) { return input.actorId !== null && this.administratorIds.has(input.actorId); }
    async canAdminister(input) { return input.actorId !== null && this.administratorIds.has(input.actorId); }
}
/**
 * Transitional application authentication.  A client secret proves which
 * registered application is calling; it never substitutes for a human user
 * in command and audit payloads.  Policy evaluation remains in Foundation.
 */
export class FoundationPolicyAuthorization {
    policyUrl;
    policyKey;
    clients = new Map();
    constructor(policyUrl, policyKey, clients) {
        this.policyUrl = policyUrl;
        this.policyKey = policyKey;
        for (const client of clients)
            if (client.applicationKey && client.secret)
                this.clients.set(client.applicationKey, client.secret);
    }
    async evaluate(actorId, resource) {
        if (!actorId || !this.clients.has(actorId))
            return false;
        const response = await fetch(`${this.policyUrl}/v1/access/policy/evaluate`, {
            method: 'POST', headers: { 'content-type': 'application/json', 'x-sema-access-policy-key': this.policyKey },
            body: JSON.stringify({ applicationKey: actorId, operation: resource }),
        });
        if (!response.ok)
            return false;
        const value = await response.json();
        return value.allowed === true;
    }
    async canRead(input) { return this.evaluate(input.actorId, input.resource); }
    async canAdminister(input) { return this.evaluate(input.actorId, input.resource); }
}
//# sourceMappingURL=authorization.js.map