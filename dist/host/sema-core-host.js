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
        await this.requireAdministration(context, 'settings');
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
    async reserveIdentifiers(context, input) {
        await this.requireAdministration(context, 'identifiers');
        return this.core.reserveIdentifiers(input.count, input.typeCode, input.metadata ?? {});
    }
    async consumeReservedIdentifier(context, input) {
        await this.requireAdministration(context, 'identifiers');
        return this.core.consumeReservedIdentifier(input.id, input.reservationId, input.metadata ?? {});
    }
    /** Core runtime records live in the Core database, never in an application's database. */
    async createCommand(context, input) {
        await this.requireAdministration(context, 'runtime');
        return this.core.createCommand(input);
    }
    async startExecution(context, input) {
        await this.requireAdministration(context, 'runtime');
        return this.core.startExecution(input);
    }
    async completeExecution(context, input) {
        await this.requireAdministration(context, 'runtime');
        return this.core.completeExecution(input);
    }
    async recordEvent(context, input) {
        await this.requireAdministration(context, 'runtime');
        return this.core.recordEvent(input);
    }
    async recordAudit(context, input) {
        await this.requireAdministration(context, 'runtime');
        return this.core.recordAudit(input);
    }
    async registerCapability(context, input) {
        await this.requireAdministration(context, 'runtime');
        return this.core.registerCapability(input);
    }
    async discoverCapabilities(context, query = '') {
        await this.requireRead(context, 'capabilities');
        return this.core.discoverCapabilities(query);
    }
    async authorizeInvocation(context, input) {
        await this.requireAdministration(context, 'runtime');
        return this.core.authorizeInvocation(input);
    }
    async resolveCapability(context, input) {
        await this.requireAdministration(context, 'runtime');
        return this.core.resolveCapability(input);
    }
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
                { method: 'POST', path: '/v1/core/identifiers/reservations', purpose: 'Reserve permanent identifiers for authorized local application work.' },
                { method: 'POST', path: '/v1/core/identifiers/consume', purpose: 'Record use of a previously reserved identifier.' },
                { method: 'POST', path: '/v1/core/runtime/commands', purpose: 'Create a Core command in the shared Core database.' },
                { method: 'POST', path: '/v1/core/runtime/executions', purpose: 'Start a Core execution in the shared Core database.' },
                { method: 'POST', path: '/v1/core/runtime/executions/complete', purpose: 'Complete a Core execution and optionally record its result.' },
                { method: 'POST', path: '/v1/core/runtime/events', purpose: 'Record a Core event in the shared Core database.' },
                { method: 'POST', path: '/v1/core/runtime/audits', purpose: 'Record a Core audit entry in the shared Core database.' },
                { method: 'POST', path: '/v1/core/runtime/capabilities', purpose: 'Register or update a Core capability.' },
                { method: 'GET', path: '/v1/core/runtime/capabilities', purpose: 'Discover active Core capabilities.' },
                { method: 'POST', path: '/v1/core/runtime/capabilities/authorize', purpose: 'Authorize a Core capability invocation.' },
                { method: 'POST', path: '/v1/core/runtime/capabilities/resolve', purpose: 'Resolve an authorized Core capability.' },
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
    async requireAdministration(context, resource) {
        if (!(await this.authorization.canAdminister({ actorId: context.actorId, resource })))
            throw new Error(`Core Host ${resource} administration is not authorized`);
    }
}
//# sourceMappingURL=sema-core-host.js.map