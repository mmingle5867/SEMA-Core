import { DEFAULT_CORE_HOST_SETTINGS } from './default-settings.js';
const settingsKeys = Object.keys(DEFAULT_CORE_HOST_SETTINGS);
function validateSettings(input, current) {
    const values = { ...current, ...input };
    for (const key of ['maxReservationSize', 'auditRetentionDays', 'eventRetentionDays']) {
        if (!Number.isSafeInteger(values[key]) || values[key] < 1)
            throw new Error(`${key} must be a positive integer`);
    }
    if (values.maxReservationSize > 100_000)
        throw new Error('maxReservationSize cannot exceed 100000');
    return values;
}
/** Installation backend: settings, operational statistics, docs, and Core runtime access. */
export class SemaCoreHost {
    core;
    store;
    authorization;
    version;
    constructor(core, store, authorization, version = '0.2.0') {
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
            throw new Error('Core Host settings administration is not authorized');
        const current = await this.getSettings(context);
        const values = validateSettings(patch, current.values);
        const next = { ...current, values, revision: current.revision + 1, updatedAt: new Date(), updatedById: context.actorId };
        this.core.setMaxReservationSize(values.maxReservationSize);
        const saved = await this.store.saveHostSettings(next);
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
            throw new Error(`Core Host ${resource} access is not authorized`);
    }
}
//# sourceMappingURL=sema-core-host.js.map