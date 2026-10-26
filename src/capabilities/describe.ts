import type { JsonObject } from '../core/types.js';
import type { CapabilityVersion, OperationDefinition, ServiceInstallation, ServiceInstance, ServiceVersion } from './records.js';
import { LIMITS } from './work.js';

/**
 * SEMA describes itself (D-199 to D-202): one description of a capability or a service, joined from Core's records and
 * the note in Foundation Access, in one fixed shape for programs and AI (JSON) and the same as Markdown for people. How
 * parameters are passed is read from the operations' input schemas. Without a note the description is built from the
 * records alone, so it is never blank.
 */
export type DependencyKind = 'account' | 'setting' | 'program' | 'network' | 'software' | 'file' | 'other';
export type ItemNote = { kind: 'capability' | 'service'; key: string; summary?: string; details?: string; dependencies?: Array<{ kind: DependencyKind; name: string; note?: string }>; examples?: Array<{ title: string; operation?: string; request: unknown; result?: unknown; note?: string }>; updatedAt?: string };
/** A note, or why there is none: missing, or Foundation Access could not be asked. */
export type NoteLookup = { note?: ItemNote; unavailable?: string };

/** required: always needed. requiredWithin: needed whenever that optional parent is given. */
export type Parameter = { name: string; type: string; required: boolean; requiredWithin?: string; description?: string; allowed?: unknown[]; limits?: string };
export type OperationDescription = { key: string; required: boolean; description?: string; job?: string; answerShape?: { input: string; output: string }; parameters: Parameter[]; returns: Parameter[] };
export type Description = {
  kind: 'capability' | 'service'; key: string; name: string; summary: string; details?: string;
  versions: Array<Record<string, unknown>>;
  operations: OperationDescription[];
  /** How a program calls it through Core, with the command's own fields. */
  howToCall: { route: string; body: Record<string, string> };
  dependencies: Array<{ kind: DependencyKind; name: string; note?: string; from: 'note' | 'records' }>;
  examples: NonNullable<ItemNote['examples']>;
  related: Array<{ kind: 'capability' | 'service'; key: string; versions: string[]; note: string }>;
  notes: { source: 'Foundation Access' | 'none'; updatedAt?: string; unavailable?: string };
};

const MAX_DEPTH = 6;
/** The parameters of a JSON Schema object, flattened to dotted names (a list's items as name[]), in the order written. */
export function parametersOf(schema: JsonObject | undefined, prefix = '', required = true, depth = 0): Parameter[] {
  if (!schema || depth > MAX_DEPTH) return [];
  const properties = (schema.properties ?? {}) as Record<string, JsonObject>;
  const needed = new Set((schema.required ?? []) as string[]);
  const out: Parameter[] = [];
  for (const [name, value] of Object.entries(properties)) {
    const full = prefix ? `${prefix}.${name}` : name;
    out.push({ ...parameter(full, value, required && needed.has(name)), ...(!required && needed.has(name) ? { requiredWithin: prefix } : {}) });
    if (value.type === 'object' && value.properties) out.push(...parametersOf(value, full, required && needed.has(name), depth + 1));
    const items = value.items as JsonObject | undefined;
    if (value.type === 'array' && items?.type === 'object' && items.properties) out.push(...parametersOf(items, `${full}[]`, required && needed.has(name), depth + 1));
  }
  return out;
}
const count = (value: unknown, noun: string) => `${String(value)} ${noun}${value === 1 ? '' : 's'}`;
function parameter(name: string, schema: JsonObject, required: boolean): Parameter {
  const items = schema.items as JsonObject | undefined;
  const type = schema.type === 'array' ? `array of ${String(items?.type ?? 'any')}` : String(schema.type ?? 'any');
  const limits = [
    schema.minLength !== undefined ? `at least ${count(schema.minLength, 'character')}` : '', schema.maxLength !== undefined ? `at most ${count(schema.maxLength, 'character')}` : '',
    schema.minimum !== undefined ? `at least ${String(schema.minimum)}` : '', schema.maximum !== undefined ? `at most ${String(schema.maximum)}` : '',
    schema.minItems !== undefined ? `at least ${count(schema.minItems, 'item')}` : '', schema.maxItems !== undefined ? `at most ${count(schema.maxItems, 'item')}` : '',
    schema.additionalProperties === false && schema.type === 'object' ? 'no other fields' : '',
  ].filter(Boolean).join(', ');
  return { name, type, required, ...(typeof schema.description === 'string' ? { description: schema.description } : {}), ...(Array.isArray(schema.enum) ? { allowed: schema.enum } : {}), ...(limits ? { limits } : {}) };
}
const operationOf = (operation: OperationDefinition): OperationDescription => ({
  key: operation.key, required: operation.required, ...(operation.description ? { description: operation.description } : {}),
  ...(operation.job ? { job: operation.job } : {}), ...(operation.answerShape ? { answerShape: operation.answerShape } : {}),
  parameters: parametersOf(operation.input), returns: parametersOf(operation.output),
});

/** The newest version first, part by part, numbers as numbers. */
const newerFirst = (a: string, b: string) => {
  const left = a.split(/[.+-]/), right = b.split(/[.+-]/);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const x = left[i] ?? '', y = right[i] ?? '';
    const difference = /^\d+$/.test(x) && /^\d+$/.test(y) ? Number(y) - Number(x) : y.localeCompare(x);
    if (difference) return difference;
  }
  return 0;
};
const HOW_TO_CALL: Description['howToCall'] = {
  route: 'POST /v1/core/capability-commands',
  body: {
    capabilityKey: 'the capability key', version: 'the capability version', operation: 'the operation key',
    way: 'bound, dynamic or consensus (optional when the organization sets a default)', services: 'service keys or service version IDs (optional; in order for dynamic)',
    input: 'the operation\'s parameters, below', waitSeconds: 'how long to wait for the answer, 0 to 60', workspaceId: 'the workspace the command belongs to (optional)', enough: 'under consensus, how many answers finish the command (optional)',
  },
};

type Records = { capabilities: CapabilityVersion[]; services: ServiceVersion[]; installations: ServiceInstallation[]; instances: ServiceInstance[] };
const running = (records: Records, service: ServiceVersion, now: number) => {
  const installations = records.installations.filter((item) => item.serviceVersionId === service.id).map((item) => item.id);
  return records.instances.filter((item) => installations.includes(item.installationId) && item.state === 'RUNNING' && Date.parse(item.lastCheckInAt) >= now - LIMITS.liveSeconds * 1000).length;
};

/** A capability: every version of its contract, its operations (from the newest active version) and its services. Undefined when Core holds no version of it. */
export function describeCapability(records: Records, key: string, lookup: NoteLookup, now = Date.now()): Description | undefined {
  const versions = records.capabilities.filter((item) => item.capabilityKey === key).sort((a, b) => newerFirst(a.version, b.version));
  if (!versions.length) return undefined;
  const current = versions.find((item) => item.status === 'ACTIVE') ?? versions[0];
  const services = records.services.filter((item) => versions.some((version) => version.id === item.capabilityVersionId));
  const note = lookup.note;
  return {
    kind: 'capability', key, name: current.displayName, summary: note?.summary ?? current.description, ...(note?.details ? { details: note.details } : {}),
    versions: versions.map((item) => ({ version: item.version, id: item.id, status: item.status, description: item.description, choosing: item.choosing, operations: item.operations.map((operation) => operation.key), createdAt: item.createdAt })),
    operations: current.operations.map(operationOf),
    howToCall: current.choosing.length ? HOW_TO_CALL : { route: 'none: its services are reached directly by the programs that use them', body: {} },
    dependencies: (note?.dependencies ?? []).map((item) => ({ ...item, from: 'note' as const })),
    examples: note?.examples ?? [],
    related: [...new Set(services.map((item) => item.serviceKey))].sort().map((serviceKey) => {
      const mine = services.filter((item) => item.serviceKey === serviceKey);
      const live = mine.reduce((sum, item) => sum + running(records, item, now), 0);
      return { kind: 'service' as const, key: serviceKey, versions: mine.map((item) => item.version).sort(newerFirst), note: `${mine[0].displayName}; ${live ? `${live} running ${live === 1 ? 'copy' : 'copies'} on this Core` : 'not running on this Core'}` };
    }),
    notes: note ? { source: 'Foundation Access', ...(note.updatedAt ? { updatedAt: note.updatedAt } : {}) } : { source: 'none', ...(lookup.unavailable ? { unavailable: lookup.unavailable } : {}) },
  };
}

/** A service: every version, what each declares, the capability it implements, where it is installed and running. Undefined when Core holds no version of it. */
export function describeService(records: Records, key: string, lookup: NoteLookup, now = Date.now()): Description | undefined {
  const versions = records.services.filter((item) => item.serviceKey === key).sort((a, b) => newerFirst(a.version, b.version));
  if (!versions.length) return undefined;
  const current = versions.find((item) => item.status === 'ACTIVE') ?? versions[0];
  const capability = records.capabilities.find((item) => item.id === current.capabilityVersionId);
  const declared = current.declarations as Record<string, unknown>;
  const derived = [
    capability ? `A service of ${capability.displayName} (${capability.capabilityKey} ${capability.version})` : 'A service',
    declared.runsWhere ? `runs ${declared.runsWhere === 'remote' ? 'elsewhere (it sends the work over the network)' : declared.runsWhere === 'device' ? 'on this machine' : 'here or elsewhere'}` : '',
    declared.dataSentTo ? `sends data to ${String(declared.dataSentTo)}` : '',
  ].filter(Boolean).join('; ') + '.';
  const needs = (declared.needs ?? {}) as Record<string, unknown>;
  const fromRecords: Description['dependencies'] = [
    ...(declared.offline === false ? [{ kind: 'network' as const, name: 'Network', note: 'It does not work offline.', from: 'records' as const }] : []),
    ...(Array.isArray(declared.systems) && declared.systems.length ? [{ kind: 'software' as const, name: 'Operating system', note: `Runs on ${declared.systems.join(', ')}.`, from: 'records' as const }] : []),
    ...Object.entries(needs).map(([name, value]) => ({ kind: 'software' as const, name: `Machine: ${name}`, note: `Needs ${String(value)}${name.endsWith('Mb') ? ' MB' : ''}.`, from: 'records' as const })),
  ];
  const note = lookup.note;
  const operations = capability ? capability.operations.filter((operation) => current.operations.includes(operation.key)).map(operationOf) : [];
  return {
    kind: 'service', key, name: current.displayName, summary: note?.summary ?? derived, ...(note?.details ? { details: note.details } : {}),
    versions: versions.map((item) => {
      const capabilityOf = records.capabilities.find((entry) => entry.id === item.capabilityVersionId);
      return { version: item.version, id: item.id, status: item.status, capability: capabilityOf ? `${capabilityOf.capabilityKey} ${capabilityOf.version}` : item.capabilityVersionId, operations: item.operations, extensions: item.extensions, declarations: item.declarations, installedHere: records.installations.some((entry) => entry.serviceVersionId === item.id), runningHere: running(records, item, now), createdAt: item.createdAt };
    }),
    operations,
    howToCall: capability?.choosing.length ? { route: HOW_TO_CALL.route, body: { ...HOW_TO_CALL.body, services: `${key} (or a version ID), to name this service` } } : { route: 'none: programs reach it directly', body: {} },
    dependencies: [...(note?.dependencies ?? []).map((item) => ({ ...item, from: 'note' as const })), ...fromRecords],
    examples: note?.examples ?? [],
    related: capability ? [{ kind: 'capability', key: capability.capabilityKey, versions: [...new Set(versions.map((item) => records.capabilities.find((entry) => entry.id === item.capabilityVersionId)?.version).filter((item): item is string => Boolean(item)))].sort(newerFirst), note: capability.displayName }] : [],
    notes: note ? { source: 'Foundation Access', ...(note.updatedAt ? { updatedAt: note.updatedAt } : {}) } : { source: 'none', ...(lookup.unavailable ? { unavailable: lookup.unavailable } : {}) },
  };
}

const code = (value: unknown) => '```json\n' + JSON.stringify(value, null, 2) + '\n```';
const cell = (value: unknown) => String(value ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
/** The same description, for people. */
export function toMarkdown(description: Description): string {
  const lines: string[] = [];
  lines.push(`# ${description.name}`, '', `${description.kind === 'capability' ? 'Capability' : 'Service'} \`${description.key}\``, '', description.summary, '');
  if (description.details) lines.push(description.details, '');
  if (description.notes.source === 'none') lines.push(`_No note has been written yet${description.notes.unavailable ? ` (${description.notes.unavailable})` : ''}; this is built from Core's records._`, '');
  lines.push('## How to call it', '', `\`${description.howToCall.route}\``, '');
  if (Object.keys(description.howToCall.body).length) { lines.push('| Field | What it is |', '| --- | --- |'); for (const [name, what] of Object.entries(description.howToCall.body)) lines.push(`| \`${name}\` | ${cell(what)} |`); lines.push(''); }
  for (const operation of description.operations) {
    lines.push(`## Operation \`${operation.key}\`${operation.required ? '' : ' (extension)'}`, '');
    if (operation.description) lines.push(operation.description, '');
    if (operation.job) lines.push(`Names its job in \`input.${operation.job}\`; permission is checked per job.`, '');
    if (operation.answerShape) lines.push(`The caller gives the answer's shape in \`input.${operation.answerShape.input}\`; the answer comes back in \`${operation.answerShape.output}\`, checked against it.`, '');
    for (const [title, list] of [['Parameters (in `input`)', operation.parameters], ['What comes back', operation.returns]] as const) {
      if (!list.length) continue;
      lines.push(`### ${title}`, '', '| Name | Type | Required | Description | Limits |', '| --- | --- | --- | --- | --- |');
      for (const item of list) lines.push(`| \`${item.name}\` | ${cell(item.type)} | ${item.required ? 'yes' : item.requiredWithin ? `when \`${item.requiredWithin}\` is given` : 'no'} | ${cell(item.description)}${item.allowed ? ` One of: ${item.allowed.map((value) => `\`${String(value)}\``).join(', ')}.` : ''} | ${cell(item.limits)} |`);
      lines.push('');
    }
  }
  if (description.dependencies.length) {
    lines.push('## Dependencies', '', '| Kind | Name | Note |', '| --- | --- | --- |');
    for (const item of description.dependencies) lines.push(`| ${item.kind} | ${cell(item.name)} | ${cell(item.note)} |`);
    lines.push('');
  }
  for (const example of description.examples) {
    lines.push(`## Example: ${example.title}`, '');
    if (example.note) lines.push(example.note, '');
    lines.push(`Request${example.operation ? ` (operation \`${example.operation}\`)` : ''}:`, '', code(example.request), '');
    if (example.result !== undefined) lines.push('Result:', '', code(example.result), '');
  }
  if (description.related.length) {
    lines.push(description.kind === 'capability' ? '## Services' : '## Capability', '');
    for (const item of description.related) lines.push(`- \`${item.key}\` (${item.versions.join(', ')}): ${item.note}`);
    lines.push('');
  }
  lines.push('## Versions', '', '| Version | ID | Status |', '| --- | --- | --- |');
  for (const item of description.versions) lines.push(`| ${cell(item.version)} | \`${cell(item.id)}\` | ${cell(item.status)} |`);
  lines.push('');
  return lines.join('\n');
}
