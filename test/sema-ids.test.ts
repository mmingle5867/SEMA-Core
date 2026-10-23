import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeBase56, decodeBase56, parseKeyId, SEMA_BASE56_ALPHABET } from '../src/index.js';
// @ts-expect-error a plain JavaScript file for outside applications, without type declarations
import { ALPHABET, createIssuer, decode, encode, fileCounter, isSemaId } from '../tools/sema-ids.mjs';

// The file outside applications copy in (D-177) must write IDs exactly as Core does.
assert.equal(ALPHABET, SEMA_BASE56_ALPHABET);
for (const value of [1n, 2n, 55n, 56n, 57n, 3135n, 3136n, 175615n, 9_999_999_999n]) {
  assert.equal(encode(value), encodeBase56(value), `writes ${value} as Core does`);
  assert.equal(decode(encode(value)), decodeBase56(encodeBase56(value)));
}
assert.equal(encode(1n), '3', 'the value 1 is written 3');
assert.throws(() => decode('23'), /no leading zero digit/);
assert.deepEqual(['3', '3-0tQ', '3-9rJ-3'].map(isSemaId), [true, true, true]);
assert.deepEqual(['', '3-', '3--4', '3-2', 'I-3', '3-0tQ-l'].map(isSemaId), [false, false, false, false, false, false], 'no empty, zero or foreign segments (I and l are not in the alphabet)');

// Issuing from a basis: one counter per installation, saved before each ID is handed out.
const folder = mkdtempSync(join(tmpdir(), 'sema-ids-'));
try {
  const file = join(folder, 'counter.txt');
  const ids = createIssuer({ basis: '3-0uA', counter: fileCounter(file) });
  assert.deepEqual([ids.next(), ids.next(), ids.next()], ['3-0uA-3', '3-0uA-4', '3-0uA-5']);
  assert.equal(readFileSync(file, 'utf8').trim(), '3', 'the counter is on disk');
  const again = createIssuer({ basis: '3-0uA', counter: fileCounter(file) });
  assert.equal(again.next(), '3-0uA-6', 'a restart carries on, never reusing');
  assert.deepEqual(parseKeyId('3-0uA-6'), { installationId: '3-0uA', localId: '6', localValue: 4n }, 'Core reads it as an ID issued under the basis');
  // The counter is saved before the ID is returned: if saving fails, no ID is handed out.
  const failing = createIssuer({ basis: '3-0uA', counter: { load: () => 10n, save: () => { throw new Error('disk full'); } } });
  assert.throws(() => failing.next(), /disk full/);
  assert.throws(() => createIssuer({ basis: '3-2', counter: fileCounter(file) }), /Not a SEMA basis/);
  assert.throws(() => createIssuer({ basis: '3-0uA' }), /Give a counter/);
} finally { rmSync(folder, { recursive: true, force: true }); }
console.log('SEMA IDs for outside applications test passed.');
