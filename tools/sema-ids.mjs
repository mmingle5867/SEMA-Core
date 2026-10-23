// SEMA IDs for an application built outside SEMA (D-177). Copy this one file into the application; it needs nothing but
// Node.js (or any JavaScript runtime with a file system, if the file counter is used).
//
// The System Console gives each installation of the application its own basis: an ID such as 3-0uA. That installation
// issues its IDs as the basis, a hyphen, and its own counter written in SEMA's Base56: 3-0uA-3, 3-0uA-4, 3-0uA-5 and so
// on. No other installation and nothing in SEMA ever issues under that basis, so the IDs can never collide, and when the
// application is brought into SEMA they are already valid SEMA IDs. Rules:
//   - Each installation uses only its own basis. Copying an installation (or its counter) to another machine would let
//     two issue the same IDs: give the new machine a basis of its own instead.
//   - The counter is saved before an ID is handed out, so a crash can skip a number but never reuse one. Unused numbers
//     are simply never used.
//   - Never reuse an ID, never hand-type one, and never count down.
//
//   import { createIssuer, fileCounter } from './sema-ids.mjs';
//   const ids = createIssuer({ basis: '3-0uA', counter: fileCounter('./data/sema-id-counter.txt') });
//   const id = ids.next();   // '3-0uA-3', then '3-0uA-4', ...
//
// To keep the counter in the application's own database instead, pass { load(), save(value) } as the counter; save must
// be written durably before it returns.

import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs';

/** SEMA's Base56 alphabet. Its first character, 2, is the zero digit, so the value 1 is written 3. */
export const ALPHABET = '234567890ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz';
const BASE = BigInt(ALPHABET.length);

/** A whole number written in SEMA's Base56, shortest form. */
export function encode(value) {
  let remaining = BigInt(value);
  if (remaining < 0n) throw new Error('A SEMA number is never negative');
  if (remaining === 0n) return ALPHABET[0];
  let text = '';
  while (remaining > 0n) { text = ALPHABET[Number(remaining % BASE)] + text; remaining /= BASE; }
  return text;
}

/** A Base56 segment read back as a whole number. */
export function decode(segment) {
  if (!segment || [...segment].some((character) => !ALPHABET.includes(character))) throw new Error(`Not a SEMA Base56 number: ${segment}`);
  if (segment.length > 1 && segment[0] === ALPHABET[0]) throw new Error(`A SEMA number has no leading zero digit: ${segment}`);
  return [...segment].reduce((total, character) => total * BASE + BigInt(ALPHABET.indexOf(character)), 0n);
}

/** Whether a text is a well-formed SEMA ID: hyphen-separated Base56 numbers, none of them zero. */
export function isSemaId(id) {
  if (typeof id !== 'string' || !id) return false;
  try { return id.split('-').every((segment) => decode(segment) > 0n); } catch { return false; }
}

/** A counter kept in a small text file, replaced in one step so a crash leaves either the old value or the new one. */
export function fileCounter(path) {
  return {
    load() { return existsSync(path) ? BigInt(readFileSync(path, 'utf8').trim() || '0') : 0n; },
    save(value) {
      const temporary = `${path}.tmp`;
      const handle = openSync(temporary, 'w');
      try { writeSync(handle, `${value}\n`); fsyncSync(handle); } finally { closeSync(handle); }
      renameSync(temporary, path);
    },
  };
}

/** Issues IDs from one installation's basis. The counter is saved before each ID is returned. */
export function createIssuer({ basis, counter }) {
  if (!isSemaId(basis)) throw new Error(`Not a SEMA basis: ${basis}. Use the basis the System Console gave this installation.`);
  if (!counter || typeof counter.load !== 'function' || typeof counter.save !== 'function') throw new Error('Give a counter: fileCounter(path), or { load(), save(value) }');
  return {
    basis,
    next() {
      const value = BigInt(counter.load()) + 1n;
      counter.save(value);
      return `${basis}-${encode(value)}`;
    },
  };
}
