export interface CoreDocumentationManifest {
  packageName: '@selo/sema-core';
  version: string;
  summary: string;
  coreResponsibilities: string[];
  hostResponsibilities: string[];
  excludedResponsibilities: string[];
}

/** Machine-readable package description for SeloDoc and capability discovery tooling. */
export function getCoreDocumentation(): CoreDocumentationManifest {
  return {
    packageName: '@selo/sema-core', version: '0.2.0',
    summary: 'Portable SEMA Core rules plus a local-first Core Host backend.',
    coreResponsibilities: ['identity and ID reservation', 'commands', 'executions', 'results', 'events', 'audit', 'policy', 'capability discovery and resolution'],
    hostResponsibilities: ['installation settings', 'health', 'operational statistics', 'HTTP API', 'self-documentation'],
    excludedResponsibilities: ['application UI', 'VectorForge artwork workflows', 'graphics transforms', 'listing workflows', 'pricing logic'],
  };
}
