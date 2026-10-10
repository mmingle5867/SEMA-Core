import type { CoreHostSettings } from './types.js';

export const DEFAULT_CORE_HOST_SETTINGS: CoreHostSettings = {
  maxReservationSize: 100,
  auditRetentionDays: 3650,
  eventRetentionDays: 3650,
  capabilityAutoFallback: true,
  documentationEnabled: true,
};
