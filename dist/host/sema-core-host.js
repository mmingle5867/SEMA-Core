import { SEMA_CORE_VERSION } from '../version.js';
import { CoreHostAuthorizationError, CoreHostValidationError } from './errors.js';
import { DEFAULT_CORE_HOST_SETTINGS } from './default-settings.js';
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
        await this.requireRead(context, 'core.health.read');
        const statistics = await this.store.getHostStatistics();
        return { status: statistics.status, installationId: statistics.installationId, version: this.version, capturedAt: statistics.capturedAt };
    }
    async getSettings(context) {
        await this.requireRead(context, 'core.settings.read');
        const settings = await this.store.getHostSettings();
        if (!settings)
            throw new Error('Core Host is not initialized');
        return settings;
    }
    async updateSettings(context, patch) {
        await this.requireAdministration(context, 'core.settings.write');
        const current = await this.getSettings(context);
        const values = validateSettings(patch, current.values);
        const next = { ...current, values, revision: current.revision + 1, updatedAt: new Date(), updatedById: context.actorId };
        // Persist first: the running Core limit must never get ahead of what is stored.
        const saved = await this.store.saveHostSettings(next);
        this.core.setMaxReservationSize(saved.values.maxReservationSize);
        await this.core.recordAudit({ action: 'core-host.settings.updated', actorId: context.actorId, evidence: { changedKeys: settingsKeys.filter((key) => current.values[key] !== values[key]), revision: saved.revision } });
        return saved;
    }
    async statistics(context) { await this.requireRead(context, 'core.statistics.read'); return this.store.getHostStatistics(); }
    async capabilities(context) { await this.requireRead(context, 'core.capabilities.read'); return this.store.getCapabilitiesForHost(); }
    async reserveIdentifiers(context, input) {
        await this.requireAdministration(context, 'core.identifiers.reserve');
        return this.core.reserveIdentifiers(input.count, input.typeCode, input.metadata ?? {});
    }
    async consumeReservedIdentifier(context, input) {
        await this.requireAdministration(context, 'core.identifiers.consume');
        return this.core.consumeReservedIdentifier(input.id, input.reservationId, input.metadata ?? {});
    }
    /** Core runtime records live in the Core database, never in an application's database. */
    async createCommand(context, input) {
        await this.requireAdministration(context, 'core.commands.create');
        return this.core.createCommand(input);
    }
    async updateCommandStatus(context, input) { await this.requireAdministration(context, 'core.commands.update'); return this.core.updateCommandStatus(input); }
    async getCommand(context, commandId) { await this.requireRead(context, 'core.commands.read'); return this.core.getCommand(commandId); }
    async listCommands(context, input) { await this.requireRead(context, 'core.commands.read'); return this.core.listCommands(input); }
    async startExecution(context, input) {
        await this.requireAdministration(context, 'core.executions.start');
        return this.core.startExecution(input);
    }
    async completeExecution(context, input) {
        await this.requireAdministration(context, 'core.executions.complete');
        return this.core.completeExecution(input);
    }
    async recordEvent(context, input) {
        await this.requireAdministration(context, 'core.events.record');
        return this.core.recordEvent(input);
    }
    async recordAudit(context, input) {
        await this.requireAdministration(context, 'core.audits.record');
        return this.core.recordAudit(input);
    }
    async registerCapability(context, input) {
        await this.requireAdministration(context, 'core.capabilities.register');
        return this.core.registerCapability(input);
    }
    async discoverCapabilities(context, query = '') {
        await this.requireRead(context, 'core.capabilities.read');
        return this.core.discoverCapabilities(query);
    }
    async authorizeInvocation(context, input) {
        await this.requireAdministration(context, 'core.capabilities.authorize');
        return this.core.authorizeInvocation(input);
    }
    async resolveCapability(context, input) {
        await this.requireAdministration(context, 'core.capabilities.resolve');
        return this.core.resolveCapability(input);
    }
    async documentation(context) {
        await this.requireRead(context, 'core.documentation.read');
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
                { method: 'POST', path: '/v1/core/runtime/commands/status', purpose: 'Update the lifecycle status of a shared Core command.' },
                { method: 'GET', path: '/v1/core/runtime/commands', purpose: 'Read one Core command or a bounded, filtered Core command list.' },
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
            throw new CoreHostAuthorizationError(`Core Host ${resource} access is not authorized`);
    }
    async requireAdministration(context, resource) {
        if (!(await this.authorization.canAdminister({ actorId: context.actorId, resource })))
            throw new CoreHostAuthorizationError(`Core Host ${resource} administration is not authorized`);
    }
}
//# sourceMappingURL=sema-core-host.js.map