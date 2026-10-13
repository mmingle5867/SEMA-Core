import { createHash } from 'node:crypto';
import { decodeBase56, encodeBase56 } from '../identity/base56.js';

/**
 * The first IDs of systems, from `3` up to `zzzzz`, are reserved. They are assigned one at a time by the
 * original system, never chosen or typed, and each new system is given its own through an install code.
 * A first ID of six or more characters is outside the reserve.
 */
export const RESERVED_TOP_LEVEL_LIMIT = BigInt(56) ** BigInt(5);

/**
 * The reserve is split into blocks of a million first IDs. A Core that assigns first IDs holds one block and
 * gives out only its own values, so two such Cores can never assign the same ID, even when they cannot reach
 * each other, and nothing has to be copied or kept in step. If a Core is lost, the unused part of its block
 * is simply never used. Block 0 belongs to the original system.
 */
export const TOP_LEVEL_BLOCK_SIZE = BigInt(1_000_000);
export const TOP_LEVEL_BLOCK_COUNT = Number((RESERVED_TOP_LEVEL_LIMIT + TOP_LEVEL_BLOCK_SIZE - BigInt(1)) / TOP_LEVEL_BLOCK_SIZE);

/** The values a block may give out: from `start` up to, but not including, `end`. Value 0 is never used and value 1 is the original system. */
export function topLevelBlockRange(block: number) {
  if (!Number.isSafeInteger(block) || block < 0 || block >= TOP_LEVEL_BLOCK_COUNT) throw new Error(`A block is a whole number from 0 to ${TOP_LEVEL_BLOCK_COUNT - 1}`);
  const first = BigInt(block) * TOP_LEVEL_BLOCK_SIZE, last = first + TOP_LEVEL_BLOCK_SIZE;
  return { start: first < BigInt(2) ? BigInt(2) : first, end: last > RESERVED_TOP_LEVEL_LIMIT ? RESERVED_TOP_LEVEL_LIMIT : last };
}

const VERSION = 'S1';
const check = (id: string) => encodeBase56(BigInt(`0x${createHash('sha256').update(`sema-install-code-v1:${id}`).digest('hex').slice(0, 12)}`));

/**
 * An install code carries the first ID assigned to a new system. Version S1 adds check characters, which
 * catch a mistyped code but do not stop someone inventing one. A later version carries a keyholder
 * signature in the same place, so the shape of a code does not change.
 */
export function formatInstallCode(id: string) { return `${VERSION}.${id}.${check(id)}`; }

/** Reads an install code and returns the ID it assigns. Anything mistyped, malformed or outside the reserve is refused. */
export function parseInstallCode(code: string) {
  const parts = code.trim().split('.');
  if (parts.length !== 3 || parts[0] !== VERSION) throw new Error('This is not a SEMA install code');
  const [, id, given] = parts;
  let value: bigint;
  try { value = decodeBase56(id); } catch { throw new Error('This is not a SEMA install code'); }
  if (value < BigInt(1) || value >= RESERVED_TOP_LEVEL_LIMIT || encodeBase56(value) !== id) throw new Error('This is not a SEMA install code');
  if (check(id) !== given) throw new Error('The install code is not correct. Check it for a typing mistake');
  return id;
}
