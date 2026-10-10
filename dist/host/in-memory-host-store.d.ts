import { InMemorySemaCoreStore } from '../stores/in-memory-store.js';
import type { CoreHostStatistics, CoreHostStore, VersionedCoreHostSettings } from './types.js';
/** Reference host store for local development and host tests. */
export declare class InMemorySemaCoreHostStore extends InMemorySemaCoreStore implements CoreHostStore {
    private hostSettings;
    getHostSettings(): Promise<VersionedCoreHostSettings | null>;
    saveHostSettings(settings: VersionedCoreHostSettings): Promise<VersionedCoreHostSettings>;
    getHostStatistics(): Promise<CoreHostStatistics>;
    getCapabilitiesForHost(): Promise<import("../core/types.js").CoreCapability[]>;
}
export { DEFAULT_CORE_HOST_SETTINGS } from './default-settings.js';
//# sourceMappingURL=in-memory-host-store.d.ts.map