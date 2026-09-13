/**
 * Final SEMA KeyID syntax. The hyphen is a required identity separator.
 * Type codes are human-readable metadata and never part of a KeyID.
 */
export declare const SEMA_BASE56_ALPHABET = "234567890ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz";
export interface SemaKeyIdParts {
    installationId: string;
    localId: string;
    localValue: bigint;
}
export declare function encodeBase56(value: bigint): string;
export declare function decodeBase56(value: string): bigint;
export declare function parseInstallationId(value: string): string;
export declare function formatKeyId(input: {
    installationId: string;
    localValue: bigint;
}): string;
export declare function parseKeyId(value: string): SemaKeyIdParts;
export declare function normalizeTypeCode(value: string): string;
//# sourceMappingURL=base56.d.ts.map