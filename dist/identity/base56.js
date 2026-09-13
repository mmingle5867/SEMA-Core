/**
 * Final SEMA KeyID syntax. The hyphen is a required identity separator.
 * Type codes are human-readable metadata and never part of a KeyID.
 */
export const SEMA_BASE56_ALPHABET = '234567890ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz';
const ZERO = BigInt(0);
const ONE = BigInt(1);
const BASE = BigInt(SEMA_BASE56_ALPHABET.length);
function assertSegment(value, label) {
    if (!value)
        throw new Error(`${label} cannot be empty`);
    for (const character of value) {
        if (!SEMA_BASE56_ALPHABET.includes(character))
            throw new Error(`Invalid SEMA Base56 character: ${character}`);
    }
    if (value.length > 1 && value.startsWith(SEMA_BASE56_ALPHABET[0])) {
        throw new Error(`${label} is not in shortest canonical Base56 form`);
    }
}
export function encodeBase56(value) {
    if (value < ZERO)
        throw new Error('SEMA Base56 values cannot be negative');
    if (value === ZERO)
        return SEMA_BASE56_ALPHABET[0];
    let remaining = value;
    let encoded = '';
    while (remaining > ZERO) {
        encoded = SEMA_BASE56_ALPHABET[Number(remaining % BASE)] + encoded;
        remaining /= BASE;
    }
    return encoded;
}
export function decodeBase56(value) {
    assertSegment(value, 'SEMA Base56 value');
    return [...value].reduce((total, character) => (total * BASE) + BigInt(SEMA_BASE56_ALPHABET.indexOf(character)), ZERO);
}
export function parseInstallationId(value) {
    const installationId = value.trim();
    const segments = installationId.split('-');
    if (!installationId || segments.some((segment) => !segment))
        throw new Error('InstallationID must contain non-empty hyphen-delimited segments');
    for (const segment of segments)
        assertSegment(segment, 'SEMA InstallationID segment');
    return installationId;
}
export function formatKeyId(input) {
    if (input.localValue < ONE)
        throw new Error('SEMA LocalID zero is reserved');
    return `${parseInstallationId(input.installationId)}-${encodeBase56(input.localValue)}`;
}
export function parseKeyId(value) {
    const segments = value.trim().split('-');
    if (segments.length < 2 || segments.some((segment) => !segment))
        throw new Error('A KeyID must contain an InstallationID and LocalID');
    const localId = segments.at(-1);
    const localValue = decodeBase56(localId);
    if (localValue === ZERO)
        throw new Error('SEMA LocalID zero is reserved');
    return { installationId: parseInstallationId(segments.slice(0, -1).join('-')), localId, localValue };
}
export function normalizeTypeCode(value) {
    const typeCode = value.trim().toUpperCase();
    if (!/^[A-Z][A-Z0-9_-]{0,31}$/.test(typeCode))
        throw new Error('TypeCode must be 1-32 readable uppercase letters, digits, underscores, or hyphens');
    return typeCode;
}
//# sourceMappingURL=base56.js.map