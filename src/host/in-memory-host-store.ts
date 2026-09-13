import type { CoreLifecycleStatus } from '../core/types.js';
import { InMemorySemaCoreStore } from '../stores/in-memory-store.js';
import type { CoreHostSettings, CoreHostStatistics, CoreHostStore, VersionedCoreHostSettings } from './types.js';

const emptyLifecycleCounts = (): Record<CoreLifecycleStatus, number> => ({ PENDING: 0, RUNNING: 0, WAITING: 0, CANCELLED: 0, FAILED: 0, SUCCESS: 0 });

/** Reference host store for local development and host tests. */
export class InMemorySemaCoreHostStore extends InMemorySemaCoreStore implements CoreHostStore {
  private hostSettings: VersionedCoreHostSettings | null = null;

  async getHostSettings() { return this.hostSettings ? structuredClone(this.hostSettings) : null; }
  async saveHostSettings(settings: VersionedCoreHostSettings) { this.hostSettings = structuredClone(settings); return structuredClone(settings); }

  async getHostStatistics(): Promise<CoreHostStatistics> {
    if (!this.state) throw new Error('SEMA Core is not initialized');
    const commands = emptyLifecycleCounts();
    const executions = emptyLifecycleCounts();
    for (const command of this.commands.values()) commands[command.status] += 1;
    for (const execution of this.executions.values()) executions[execution.status] += 1;
    let reserved = 0; let issued = 0;
    for (const identifier of this.identifiers.values()) identifier.status === 'RESERVED' ? reserved += 1 : issued += 1;
    let active = 0; let inactive = 0; let deprecated = 0;
    for (const capability of this.capabilities.values()) {
      if (capability.status === 'ACTIVE') active += 1;
      else if (capability.status === 'INACTIVE') inactive += 1;
      else deprecated += 1;
    }
    return {
      installationId: this.state.installationId, status: this.state.status, nextLocalId: this.state.nextLocalId,
      identifiers: { reserved, issued, reservations: this.reservations.size }, commands, executions,
      results: this.results.length, events: this.events.length, auditEntries: this.audits.length,
      capabilities: { active, inactive, deprecated }, capturedAt: new Date(),
    };
  }

  async getCapabilitiesForHost() { return [...this.capabilities.values()].sort((a, b) => a.displayName.localeCompare(b.displayName)); }
}

export const DEFAULT_CORE_HOST_SETTINGS: CoreHostSettings = {
  maxReservationSize: 100, auditRetentionDays: 3650, eventRetentionDays: 3650,
  capabilityAutoFallback: true, documentationEnabled: true,
};
