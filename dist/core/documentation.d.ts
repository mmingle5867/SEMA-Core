export interface CoreDocumentationManifest {
    packageName: '@selo/sema-core';
    version: string;
    summary: string;
    coreResponsibilities: string[];
    hostResponsibilities: string[];
    excludedResponsibilities: string[];
}
/** Machine-readable package description for SeloDoc and capability discovery tooling. */
export declare function getCoreDocumentation(): CoreDocumentationManifest;
//# sourceMappingURL=documentation.d.ts.map