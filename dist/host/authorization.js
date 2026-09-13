/** Local-first starter policy. Production adapters replace this with Core policy evaluation. */
export class LocalCoreHostAuthorization {
    administratorIds;
    constructor(administratorIds = new Set()) {
        this.administratorIds = administratorIds;
    }
    async canRead() { return true; }
    async canAdminister(input) { return input.actorId === null || this.administratorIds.has(input.actorId); }
}
//# sourceMappingURL=authorization.js.map