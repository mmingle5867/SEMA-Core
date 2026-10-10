import { SEMA_CORE_VERSION } from '../version.js';
import { CoreHostAuthorizationError, CoreHostValidationError } from './errors.js';
import { DEFAULT_CORE_HOST_SETTINGS } from './in-memory-host-store.js';
const settingsKeys = Object.keys(DEFAULT_CORE_HOST_SETTINGS);
const settingsKeySet = new Set(settingsKeys);
/**
 * Accepts only known settings of the right type. The known keys and their types come from
 * DEFAULT_CORE_HOST_SETTINGS, so adding a setting there makes it updatable here automatically.
 */
function validateSettings(input, current) {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
        throw new CoreHostValidationError('Settings update must be a JSON object');
    }
    const patch = input;
    const unknownKeys = Object.keys(patch).filter((key) => !settingsKeySet.has(key));
    if (unknownKeys.length)
        throw new CoreHostValidationError(`Unknown Core Host setting: ${unknownKeys.join(', ')}`);
    for (const key of settingsKeys) {
        if (!Object.hasOwn(patch, key))
            continue;
        const expected = typeof DEFAULT_CORE_HOST_SETTINGS[key];
        if (typeof patch[key] !== expected)
            throw new CoreHostValidationError(`${key} must be a ${expected}`);
    }
    const values = { ...current, ...patch };
    for (const key of ['maxReservationSize', 'auditRetentionDays', 'eventRetentionDays']) {
        if (!Number.isSafeInteger(values[key]) || values[key] < 1)
            throw new CoreHostValidationError(`${key} must be a positive integer`);
    }
    if (values.maxReservationSize > 100_000)
        throw new CoreHostValidationError('maxReservationSize cannot exceed 100000');
    return values;
}
/** Installation backend: settings, operational statistics, docs, and Core runtime access. */
export class SemaCoreHost {
    core;
    store;
    authorization;
    version;
    constructor(core, store, authorization, version = SEMA_CORE_VERSION) {
        this.core = core;
        this.store = store;
        this.authorization = authorization;
        this.version = version;
    }
    async initialize(context = { actorId: null }) {
        const state = await this.core.initialize();
        let settings = await this.store.getHostSettings();
        if (!settings) {
            settings = { installationId: state.installationId, revision: 1, updatedAt: new Date(), updatedById: context.actorId, values: { ...DEFAULT_CORE_HOST_SETTINGS, maxReservationSize: this.core.getMaxReservationSize() } };
            await this.store.saveHostSettings(settings);
        }
        this.core.setMaxReservationSize(settings.values.maxReservationSize);
        return { state, settings };
    }
    async health(context) {
        await this.requireRead(context, 'health');
        const statistics = await this.store.getHostStatistics();
        return { status: statistics.status, installationId: statistics.installationId, version: this.version, capturedAt: statistics.capturedAt };
    }
    async getSettings(context) {
        await this.requireRead(context, 'settings');
        const settings = await this.store.getHostSettings();
        if (!settings)
            throw new Error('Core Host is not initialized');
        return settings;
    }
    async updateSettings(context, patch) {
        const allowed = await this.authorization.canAdminister({ actorId: context.actorId, resource: 'settings' });
        if (!allowed)
            throw new CoreHostAuthorizationError('Core Host settings administration is not authorized');
        const current = await this.getSettings(context);
        const values = validateSettings(patch, current.values);
        const next = { ...current, values, revision: current.revision + 1, updatedAt: new Date(), updatedById: context.actorId };
        // Persist first: the running Core limit must never get ahead of what is stored.
        const saved = await this.store.saveHostSettings(next);
        this.core.setMaxReservationSize(saved.values.maxReservationSize);
        await this.core.recordAudit({ action: 'core-host.settings.updated', actorId: context.actorId, evidence: { changedKeys: settingsKeys.filter((key) => current.values[key] !== values[key]), revision: saved.revision } });
        return saved;
    }
    async statistics(context) { await this.requireRead(context, 'statistics'); return this.store.getHostStatistics(); }
    async capabilities(context) { await this.requireRead(context, 'capabilities'); return this.store.getCapabilitiesForHost(); }
    async documentation(context) {
        await this.requireRead(context, 'documentation');
        return {
            packageName: '@selo/sema-core', version: this.version,
            summary: 'Local-first Core Host for settings, statistics, health, and documented access to SEMA Core runtime services.',
            endpoints: [
                { method: 'GET', path: '/v1/core/health', purpose: 'Read Core availability and installation identity.' },
                { method: 'GET', path: '/v1/core/settings', purpose: 'Read installation-level Core settings.' },
                { method: 'PUT', path: '/v1/core/settings', purpose: 'Update authorized installation-level Core settings.' },
                { method: 'GET', path: '/v1/core/statistics', purpose: 'Read operational totals without application business data.' },
                { method: 'GET', path: '/v1/core/capabilities', purpose: 'List installed capability records.' },
                { method: 'GET', path: '/v1/core/documentation', purpose: 'Read machine-readable backend documentation.' },
            ],
            settings: [
                { key: 'maxReservationSize', description: 'Maximum IDs granted by one reservation request.' },
                { key: 'auditRetentionDays', description: 'Configured retention period for audit records.' },
                { key: 'eventRetentionDays', description: 'Configured retention period for event records.' },
                { key: 'capabilityAutoFallback', description: 'Whether policy may select an approved fallback capability.' },
                { key: 'documentationEnabled', description: 'Whether host documentation endpoint is available.' },
            ],
            statisticGroups: ['identity reservations and issuance', 'commands', 'executions', 'results', 'events', 'audit', 'capabilities'],
        };
    }
    async requireRead(context, resource) {
        if (!(await this.authorization.canRead({ actorId: context.actorId, resource })))
            throw new CoreHostAuthorizationError(`Core Host ${resource} access is not authorized`);
    }
}
//# sourceMappingURL=sema-core-host.js.map