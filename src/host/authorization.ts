import type { CoreHostAuthorization } from './types.js';

/** Local-first starter policy. Production adapters replace this with Core policy evaluation. */
export class LocalCoreHostAuthorization implements CoreHostAuthorization {
  constructor(private readonly administratorIds: ReadonlySet<string> = new Set()) {}
  async canRead() { return true; }
  async canAdminister(input: { actorId: string | null }) { return input.actorId === null || this.administratorIds.has(input.actorId); }
}
