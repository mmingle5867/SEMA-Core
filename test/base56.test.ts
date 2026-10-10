import assert from 'node:assert/strict';
import {
  InMemorySemaCoreStore, SEMA_BASE56_ALPHABET, SemaCore, decodeBase56, encodeBase56, formatKeyId,
  normalizeTypeCode, parseInstallationId, parseKeyId,
} from '../src/index.js';

// Alphabet: 56 distinct symbols, no look-alikes. '2' is the zero digit, so the first LocalID (1) is '3'.
assert.equal(SEMA_BASE56_ALPHABET.length, 56);
assert.equal(new Set(SEMA_BASE56_ALPHABET).size, 56);
for (const ambiguous of ['1', 'I', 'O', 'i', 'l', 'o']) assert.ok(!SEMA_BASE56_ALPHABET.includes(ambiguous), `alphabet must not contain ${ambiguous}`);
assert.equal(encodeBase56(BigInt(0)), '2');
assert.equal(encodeBase56(BigInt(1)), '3');
assert.equal(encodeBase56(BigInt(55)), 'z');
assert.equal(encodeBase56(BigInt(56)), '32');

// Round trip for every small value, and for values with no upper length limit.
for (let value = 0; value <= 5000; value += 1) assert.equal(decodeBase56(encodeBase56(BigInt(value))), BigInt(value));
const huge = (BigInt(56) ** BigInt(50)) + BigInt(12345);
assert.equal(encodeBase56(huge).length, 51);
assert.equal(decodeBase56(encodeBase56(huge)), huge);

// Base56 values are never negative, never empty, never non-canonical.
assert.throws(() => encodeBase56(BigInt(-1)), /negative/);
assert.throws(() => decodeBase56(''), /empty/);
assert.throws(() => decodeBase56('1'), /Invalid SEMA Base56 character/);
assert.throws(() => decodeBase56('A B'), /Invalid SEMA Base56 character/);
assert.throws(() => decodeBase56('23'), /canonical/);

// LocalID zero is reserved everywhere it can appear.
assert.throws(() => formatKeyId({ installationId: '3', localValue: BigInt(0) }), /reserved/);
assert.throws(() => parseKeyId('3-2'), /reserved/);
assert.throws(() => parseInstallationId('2'), /cannot be zero/);
assert.throws(() => parseInstallationId('3-2'), /cannot be zero/);
assert.throws(() => parseKeyId('2-3'), /cannot be zero/);
assert.throws(() => new SemaCore(new InMemorySemaCoreStore(), { installationId: '2', maxReservationSize: 5 }), /cannot be zero/);

// KeyID shape: hyphen-delimited path, shortest-form segments, last segment is the LocalID.
assert.equal(parseInstallationId('3-A'), '3-A');
assert.equal(parseInstallationId(' 3-A '), '3-A');
assert.deepEqual(parseKeyId(' b-A-3-3 '), { installationId: 'b-A-3', localId: '3', localValue: BigInt(1) });
assert.throws(() => parseKeyId('3'), /InstallationID and LocalID/);
assert.throws(() => parseKeyId('3--5'), /InstallationID and LocalID/);
assert.throws(() => parseKeyId('-3'), /InstallationID and LocalID/);
assert.throws(() => parseInstallationId(''), /non-empty/);

// Type codes are readable metadata, never part of a KeyID.
assert.equal(normalizeTypeCode(' art '), 'ART');
assert.throws(() => normalizeTypeCode('1ART'), /TypeCode/);
assert.throws(() => normalizeTypeCode(''), /TypeCode/);
assert.throws(() => normalizeTypeCode('A'.repeat(33)), /TypeCode/);

console.log('SEMA Base56 tests passed.');
