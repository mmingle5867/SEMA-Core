import { SEMA_CORE_VERSION } from '../version.js';
/** Machine-readable package description for SeloDoc and capability discovery tooling. */
export function getCoreDocumentation() {
    return {
        packageName: '@selo/sema-core', version: SEMA_CORE_VERSION,
        summary: 'Portable SEMA Core rules plus a local-first Core Host backend.',
        coreResponsibilities: ['identity and ID reservation', 'commands', 'executions', 'results', 'events', 'audit', 'policy', 'capability discovery and resolution'],
        hostResponsibilities: ['installation settings', 'health', 'operational statistics', 'HTTP API', 'self-documentation'],
        excludedResponsibilities: ['application UI', 'VectorForge artwork workflows', 'graphics transforms', 'listing workflows', 'pricing logic'],
    };
}
//# sourceMappingURL=documentation.js.map