import type { JsonValue } from '../core/types.js';

/**
 * The small schema checker (D-165): a stated subset of JSON Schema, small enough to be written the same way in any
 * language, so every Core and every wrapper agrees. A contract using anything outside it is refused when it is
 * published, so nothing it declares goes unchecked. `description`, `title` and `format` are recorded and not checked.
 */
export const SCHEMA_KEYWORDS = ['type', 'required', 'properties', 'additionalProperties', 'items', 'minLength', 'maxLength', 'minItems', 'maxItems', 'minimum', 'maximum', 'enum', 'description', 'title', 'format'] as const;
const KEYWORDS = new Set<string>(SCHEMA_KEYWORDS);
const TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);
const MAX_DEPTH = 32;

type Schema = { [key: string]: JsonValue };
const isObject = (value: unknown): value is Schema => typeof value === 'object' && value !== null && !Array.isArray(value);
const count = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0;

/** Says what is wrong with a schema, or nothing when it keeps to the subset. */
export function schemaProblems(schema: unknown, where = 'schema', depth = 0): string[] {
  if (depth > MAX_DEPTH) return [`${where} is nested more than ${MAX_DEPTH} levels deep`];
  if (!isObject(schema)) return [`${where} must be an object`];
  const problems: string[] = [];
  for (const keyword of Object.keys(schema)) if (!KEYWORDS.has(keyword)) problems.push(`${where} uses "${keyword}", which SEMA's schema checker does not support (supported: ${SCHEMA_KEYWORDS.join(', ')})`);
  const types = schema.type === undefined ? [] : Array.isArray(schema.type) ? schema.type : [schema.type];
  if (schema.type !== undefined && (!types.length || !types.every((type) => typeof type === 'string' && TYPES.has(type)))) problems.push(`${where}.type must be one of ${[...TYPES].join(', ')}, or a list of them`);
  if (schema.required !== undefined && (!Array.isArray(schema.required) || !schema.required.every((name) => typeof name === 'string'))) problems.push(`${where}.required must be a list of property names`);
  if (schema.properties !== undefined) {
    if (!isObject(schema.properties)) problems.push(`${where}.properties must be an object`);
    else for (const [name, child] of Object.entries(schema.properties)) problems.push(...schemaProblems(child, `${where}.properties.${name}`, depth + 1));
  }
  if (schema.additionalProperties !== undefined && schema.additionalProperties !== false) problems.push(`${where}.additionalProperties may only be false`);
  if (schema.items !== undefined) problems.push(...schemaProblems(schema.items, `${where}.items`, depth + 1));
  for (const keyword of ['minLength', 'maxLength', 'minItems', 'maxItems'] as const) if (schema[keyword] !== undefined && !count(schema[keyword])) problems.push(`${where}.${keyword} must be a whole number, 0 or more`);
  for (const keyword of ['minimum', 'maximum'] as const) if (schema[keyword] !== undefined && typeof schema[keyword] !== 'number') problems.push(`${where}.${keyword} must be a number`);
  if (schema.enum !== undefined && (!Array.isArray(schema.enum) || !schema.enum.length)) problems.push(`${where}.enum must be a non-empty list`);
  for (const keyword of ['description', 'title', 'format'] as const) if (schema[keyword] !== undefined && typeof schema[keyword] !== 'string') problems.push(`${where}.${keyword} must be text`);
  return problems;
}

const typeOf = (value: unknown) => value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Says where a value does not match a schema that keeps to the subset, or nothing when it matches. Stops at 20. */
export function valueProblems(schema: Schema, value: unknown, where = 'input'): string[] {
  const problems: string[] = [];
  const check = (s: Schema, v: unknown, at: string) => {
    if (problems.length >= 20) return;
    if (s.type !== undefined) {
      const types = (Array.isArray(s.type) ? s.type : [s.type]) as string[];
      const actual = typeOf(v);
      const fits = types.some((type) => type === actual || (type === 'integer' && actual === 'number' && Number.isInteger(v)) || (type === 'number' && actual === 'number' && Number.isFinite(v)));
      if (!fits) { problems.push(`${at} must be ${types.join(' or ')}`); return; }
    }
    if (s.enum !== undefined && !(s.enum as JsonValue[]).some((allowed) => same(allowed, v))) problems.push(`${at} must be one of ${(s.enum as JsonValue[]).map((allowed) => JSON.stringify(allowed)).join(', ')}`);
    if (typeof v === 'string') {
      // Lengths count characters, not UTF-16 units, so a length means the same in every language.
      const length = [...v].length;
      if (typeof s.minLength === 'number' && length < s.minLength) problems.push(`${at} must be at least ${s.minLength} characters`);
      if (typeof s.maxLength === 'number' && length > s.maxLength) problems.push(`${at} must be at most ${s.maxLength} characters`);
    }
    if (typeof v === 'number') {
      if (typeof s.minimum === 'number' && v < s.minimum) problems.push(`${at} must be at least ${s.minimum}`);
      if (typeof s.maximum === 'number' && v > s.maximum) problems.push(`${at} must be at most ${s.maximum}`);
    }
    if (Array.isArray(v)) {
      if (typeof s.minItems === 'number' && v.length < s.minItems) problems.push(`${at} must have at least ${s.minItems} items`);
      if (typeof s.maxItems === 'number' && v.length > s.maxItems) problems.push(`${at} must have at most ${s.maxItems} items`);
      if (isObject(s.items)) v.forEach((item, index) => check(s.items as Schema, item, `${at}[${index}]`));
    }
    if (isObject(v)) {
      for (const name of (s.required as string[] | undefined) ?? []) if (!Object.hasOwn(v, name)) problems.push(`${at}.${name} is required`);
      const properties = isObject(s.properties) ? s.properties : {};
      for (const [name, child] of Object.entries(v)) {
        if (Object.hasOwn(properties, name)) check(properties[name] as Schema, child, `${at}.${name}`);
        else if (s.additionalProperties === false) problems.push(`${at}.${name} is not allowed`);
      }
    }
  };
  check(schema, value, where);
  return problems.slice(0, 20);
}
