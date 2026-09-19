import type { SemaCore } from '../core/sema-core.js';
import type { CoreHostAuthorization, CoreHostDocumentation, CoreHostRequestContext, CoreHostSettings, CoreHostStore, VersionedCoreHostSettings } from './types.js';
import { DEFAULT_CORE_HOST_SETTINGS } from './default-settings.js';

const settingsKeys = Object.keys(DEFAULT_CORE_HOST_SETTINGS) as Array<keyof CoreHostSettings>;

function validateSettings(input: Partial<CoreHostSettings>, current: CoreHostSettings): CoreHostSettings {
  const values = { ...current, ...input };
  for (const key of ['maxReservationSize', 'auditRetentionDays', 'eventRetentionDays'] as const) {
    if (!Number.isSafeInteger(values[key]) || values[key] < 1) throw new Error(`${key} must be a positive integer`);
  }
  if (values.maxReservationSize > 100_000) throw new Error('maxReservationSize cannot exceed 100000');
  return values;
}

/** Installation backend: settings, operational statistics, docs, and Core runtime access. */
export class SemaCoreHost {
  constructor(
    private readonly core: SemaCore,
    private readonly store: CoreHostStore,
    private readonly authorization: CoreHostAuthorization,
    private readonly version = '0.2.0',
  ) {}

  async initialize(context: CoreHostRequestContext = { actorId: null }) {
    const state = await this.core.initialize();
    let settings = await this.store.getHostSettings();
    if (!settings) {
      settings = { installationId: state.installationId, revision: 1, updatedAt: new Date(), updatedById: context.actorId, values: { ...DEFAULT_CORE_HOST_SETTINGS, maxReservationSize: this.core.getMaxReservationSize() } };
      await this.store.saveHostSettings(settings);
    }
    this.core.setMaxReservationSize(settings.values.maxReservationSize);
    return { state, settings };
  }

  async health(context: CoreHostRequestContext) {
    await this.requireRead(context, 'health');
    const statistics = await this.store.getHostStatistics();
    return { status: statistics.status, installationId: statistics.installationId, version: this.version, capturedAt: statistics.capturedAt };
  }

  async getSettings(context: CoreHostRequestContext) {
    await this.requireRead(context, 'settings');
    const settings = await this.store.getHostSettings();
    if (!settings) throw new Error('Core Host is not initialized');
    return settings;
  }

  async updateSettings(context: CoreHostRequestContext, patch: Partial<CoreHostSettings>) {
    await this.requireAdministration(context, 'settings');
    const current = await this.getSettings(context);
    const values = validateSettings(patch, current.values);
    const next: VersionedCoreHostSettings = { ...current, values, revision: current.revision + 1, updatedAt: new Date(), updatedById: context.actorId };
    this.core.setMaxReservationSize(values.maxReservationSize);
    const saved = await this.store.saveHostSettings(next);
    await this.core.recordAudit({ action: 'core-host.settings.updated', actorId: context.actorId, evidence: { changedKeys: settingsKeys.filter((key) => current.values[key] !== values[key]), revision: saved.revision } });
    return saved;
  }

  async statistics(context: CoreHostRequestContext) { await this.requireRead(context, 'statistics'); return this.store.getHostStatistics(); }
  async capabilities(context: CoreHostRequestContext) { await this.requireRead(context, 'capabilities'); return this.store.getCapabilitiesForHost(); }

  async reserveIdentifiers(context: CoreHostRequestContext, input: { count: number; typeCode?: string; metadata?: import('../core/types.js').JsonObject }) {
    await this.requireAdministration(context, 'identifiers');
    return this.core.reserveIdentifiers(input.count, input.typeCode, input.metadata ?? {});
  }

  async consumeReservedIdentifier(context: CoreHostRequestContext, input: { reservationId: string; id: string; metadata?: import('../core/types.js').JsonObject }) {
    await this.requireAdministration(context, 'identifiers');
    return this.core.consumeReservedIdentifier(input.id, input.reservationId, input.metadata ?? {});
  }

  async documentation(context: CoreHostRequestContext): Promise<CoreHostDocumentation> {
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

  private async requireRead(context: CoreHostRequestContext, resource: Parameters<CoreHostAuthorization['canRead']>[0]['resource']) {
    if (!(await this.authorization.canRead({ actorId: context.actorId, resource }))) throw new Error(`Core Host ${resource} access is not authorized`);
  }

  private async requireAdministration(context: CoreHostRequestContext, resource: 'settings' | 'identifiers') {
    if (!(await this.authorization.canAdminister({ actorId: context.actorId, resource }))) throw new Error(`Core Host ${resource} administration is not authorized`);
  }
}
