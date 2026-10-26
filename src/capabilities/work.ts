import { EventEmitter } from 'node:events';
import type { SemaCore } from '../core/sema-core.js';
import type { CoreLifecycleStatus, JsonObject, JsonValue } from '../core/types.js';
import type { CapabilityStore, CapabilityVersion, ChoosingWay, ServiceInstance, ServiceVersion } from './records.js';
import { CapabilityRecordError } from './registry.js';
import { schemaProblems, valueProblems } from './schema.js';

/**
 * Commands to a capability (phase 2, D-160 to D-167). An application asks for an operation of a capability; Core checks
 * which services can run (can), whether the caller may use the capability (may), which to use by the way of choosing
 * the command asked for and the capability permits (should), and creates one execution per chosen service (execute).
 * Running copies of those services ask Core for work, answer accept or decline, and report a result. The application's
 * request is answered when every execution has finished or its wait runs out; then the result lists what has finished
 * and a reference for each execution still running. One command gets one result, recorded once.
 */
export const LIMITS = {
  /** No request is held open longer than this (D-161). */
  maxWaitSeconds: 60,
  /** An instance asking for work is held at most this long, then asks again (D-161). */
  maxWorkWaitSeconds: 30,
  /** Work offered to an instance that has not answered in this time may be offered to another. */
  offerSeconds: 60,
  /** A running copy that has not asked for work or checked in for this long is not counted as running. */
  liveSeconds: 150,
  /** The largest answer carried inline; anything larger goes by reference (D-164). */
  inlineBytes: 64 * 1024,
  /** A service doing a job says it is still working this often (D-180). */
  progressSeconds: 30,
  /** A running execution not reported on for this long is marked failed: "stopped reporting" (three intervals, D-180). */
  silentSeconds: 90,
  /** The furthest ahead a service may defer work (D-178). */
  maxDeferSeconds: 24 * 60 * 60,
};

/** Why a service cannot run now (CL-8, D-158, D-179, D-185): what is missing, and whether it passes or not. */
export const UNAVAILABLE_KINDS = ['memory', 'disk', 'processor', 'graphics', 'network', 'busy', 'setting', 'suspended', 'other'] as const;
/**
 * The kinds a machine has a measurable amount of: memory, disk and graphics-card memory in megabytes, processor in cores.
 * For these the service gives what it needs, what is free now and what the machine has in all, and Core decides whether
 * it is temporary or permanent (D-185): needing more than the machine has in all is permanent (this machine can never
 * run it, so it is never retried here); having enough in all but not free now is temporary (other work is using it).
 */
export const MEASURED_KINDS = ['memory', 'disk', 'processor', 'graphics'] as const;
export const MEASURE_UNITS: Record<typeof MEASURED_KINDS[number], string> = { memory: 'MB', disk: 'MB', processor: 'cores', graphics: 'MB' };
export type UnavailableReason = { kind: typeof UNAVAILABLE_KINDS[number]; lasting: 'temporary' | 'permanent'; needed?: number; free?: number; total?: number; note?: string };
const isMeasured = (kind: string): kind is typeof MEASURED_KINDS[number] => (MEASURED_KINDS as readonly string[]).includes(kind);

/**
 * What a running copy reports about its machine at every check-in (D-181): whether it has the network, and free and total
 * memory, disk and graphics-card memory in megabytes, and processor cores. Any part may be missing when the copy cannot
 * tell; `graphics: null` means the machine has no graphics card it can use.
 */
export type MachineReport = { network?: boolean; memory?: { freeMb: number; totalMb: number }; disk?: { freeMb: number; totalMb: number }; processor?: { cores: number; freeCores?: number }; graphics?: { freeMb: number; totalMb: number } | null };
/** What a service declares it needs (N8, D-181): the network (from `offline: false`), and at least so much of each. */
export type ServiceNeeds = { network: boolean; memoryMb?: number; diskMb?: number; cores?: number; graphicsMb?: number };

export function needsOf(declarations: JsonObject): ServiceNeeds {
  const needs = (declarations.needs && typeof declarations.needs === 'object' && !Array.isArray(declarations.needs) ? declarations.needs : {}) as Record<string, unknown>;
  const amount = (key: string) => typeof needs[key] === 'number' && (needs[key] as number) > 0 ? { [key]: needs[key] as number } : {};
  return { network: declarations.offline === false, ...amount('memoryMb'), ...amount('diskMb'), ...amount('cores'), ...amount('graphicsMb') };
}

/**
 * Where a copy's machine falls short of a service's needs, right now (D-181), each temporary or permanent by D-185. A part
 * the copy did not report is not held against it: Core cannot tell, and the service itself can still say unavailable.
 */
export function shortfalls(needs: ServiceNeeds, report: MachineReport | undefined): UnavailableReason[] {
  const found: UnavailableReason[] = [];
  const measured = (kind: 'memory' | 'disk' | 'graphics', needed: number | undefined, part: { freeMb: number; totalMb: number } | null | undefined) => {
    if (!needed || !part || typeof part.totalMb !== 'number') return;
    if (needed > part.totalMb) found.push({ kind, lasting: 'permanent', needed, free: part.freeMb, total: part.totalMb });
    else if (typeof part.freeMb === 'number' && needed > part.freeMb) found.push({ kind, lasting: 'temporary', needed, free: part.freeMb, total: part.totalMb });
  };
  if (needs.network && report?.network === false) found.push({ kind: 'network', lasting: 'temporary', note: 'no network' });
  measured('memory', needs.memoryMb, report?.memory);
  measured('disk', needs.diskMb, report?.disk);
  if (needs.graphicsMb && report?.graphics === null) found.push({ kind: 'graphics', lasting: 'permanent', note: 'this machine has no graphics card it can use' });
  else measured('graphics', needs.graphicsMb, report?.graphics);
  const processor = report?.processor;
  if (needs.cores && processor && typeof processor.cores === 'number') {
    if (needs.cores > processor.cores) found.push({ kind: 'processor', lasting: 'permanent', needed: needs.cores, ...(typeof processor.freeCores === 'number' ? { free: processor.freeCores } : {}), total: processor.cores });
    else if (typeof processor.freeCores === 'number' && needs.cores > processor.freeCores) found.push({ kind: 'processor', lasting: 'temporary', needed: needs.cores, free: processor.freeCores, total: processor.cores });
  }
  return found;
}

/** A reason in plain words, such as "memory: needs 8192 MB, this machine has 4096 MB in all (permanent)". */
export function describeReason(reason: UnavailableReason) {
  if (isMeasured(reason.kind) && reason.needed !== undefined && reason.total !== undefined) {
    const unit = MEASURE_UNITS[reason.kind];
    const of = (amount: number) => `${amount} ${amount === 1 && unit === 'cores' ? 'core' : unit}`;
    return reason.lasting === 'permanent'
      ? `${reason.kind}: needs ${of(reason.needed)}, this machine has ${of(reason.total)} in all (permanent)`
      : `${reason.kind}: needs ${of(reason.needed)}, ${of(reason.free ?? 0)} of ${of(reason.total)} free, the rest in use (temporary)`;
  }
  return `${reason.kind}${reason.note ? `: ${reason.note}` : ''} (${reason.lasting})`;
}
export type NotNow = { answer: 'decline' | 'unavailable'; reason: string; reasons?: UnavailableReason[] };
export interface WorkExecution {
  id: string;
  commandId: string;
  serviceVersionId: string;
  /** PENDING: waiting for a running copy to take it. WAITING: offered to one, not yet answered. RUNNING: accepted. */
  status: CoreLifecycleStatus;
  instanceId?: string;
  offeredAt?: string;
  startedAt?: string;
  completedAt?: string;
  notNow?: NotNow;
  /** The service deferred the work: it is not offered again before `until` (D-178). */
  deferred?: { until: string; reason: string };
  /** The service's last report that it is still working (D-180). */
  progress?: { at: string; percent?: number; note?: string };
  error?: string;
  createdAt: string;
}
export const OUTCOMES = ['achieved', 'partly', 'not-achieved', 'needs-review'] as const;
export interface WorkAnswer { executionId: string; outcome?: typeof OUTCOMES[number]; answer?: JsonValue; reference?: string; recordedAt: string }
export interface ResultEntry {
  executionId: string;
  serviceVersionId: string;
  serviceKey: string;
  status: CoreLifecycleStatus;
  outcome?: WorkAnswer['outcome'];
  answer?: JsonValue;
  reference?: string;
  notNow?: NotNow;
  deferredUntil?: string;
  progress?: WorkExecution['progress'];
  error?: string;
}
/** notes: what the caller should know about how the command was handled, such as no organization found (D-209). */
export interface CommandResult { id: string; commandId: string; entries: ResultEntry[]; recordedAt: string; notes?: string[] }

export interface WorkStore {
  addExecution(execution: WorkExecution): Promise<void>;
  getExecution(id: string): Promise<WorkExecution | undefined>;
  listExecutions(commandId: string): Promise<WorkExecution[]>;
  /** Offers the oldest waiting execution for the service version to the instance, atomically: PENDING, or offered before `staleBefore` and never answered. */
  claim(serviceVersionId: string, instanceId: string, now: string, staleBefore: string): Promise<WorkExecution | undefined>;
  /** Changes an execution only when it is still in the expected state and offered to the expected instance. Says whether it changed. */
  change(id: string, expected: { status: CoreLifecycleStatus; instanceId: string }, change: Partial<Pick<WorkExecution, 'status' | 'startedAt' | 'completedAt' | 'notNow' | 'error' | 'deferred' | 'progress'>>): Promise<boolean>;
  /** Cancels a command's executions that are still waiting to be offered (deferred ones, when another service has answered). */
  cancelPending(commandId: string, now: string): Promise<void>;
  /** Every execution being worked on, for the check on still-working reports. */
  listRunning(): Promise<WorkExecution[]>;
  addAnswer(id: string, answer: WorkAnswer): Promise<void>;
  getAnswer(executionId: string): Promise<WorkAnswer | undefined>;
  /** The latest answers from these service versions, newest first, for usage figures. */
  recentAnswers(serviceVersionIds: string[], limit: number): Promise<Array<{ serviceVersionId: string; answer: WorkAnswer }>>;
  /** Records the command's one result; refused (false) when it already has one. */
  addResult(result: CommandResult): Promise<boolean>;
  getResult(commandId: string): Promise<CommandResult | undefined>;
}

const copy = <T>(value: T): T => structuredClone(value);
const finished = (status: CoreLifecycleStatus) => status === 'SUCCESS' || status === 'FAILED' || status === 'CANCELLED';

export class InMemoryWorkStore implements WorkStore {
  private readonly executions = new Map<string, WorkExecution>();
  private readonly answers = new Map<string, WorkAnswer>();
  private readonly results = new Map<string, CommandResult>();
  async addExecution(execution: WorkExecution) { this.executions.set(execution.id, copy(execution)); }
  async getExecution(id: string) { const found = this.executions.get(id); return found && copy(found); }
  async listExecutions(commandId: string) { return [...this.executions.values()].filter((item) => item.commandId === commandId).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map(copy); }
  async claim(serviceVersionId: string, instanceId: string, now: string, staleBefore: string) {
    const next = [...this.executions.values()].filter((item) => item.serviceVersionId === serviceVersionId && ((item.status === 'PENDING' && !(item.deferred && item.deferred.until > now)) || (item.status === 'WAITING' && item.offeredAt! < staleBefore))).sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
    if (!next) return undefined;
    Object.assign(next, { status: 'WAITING', instanceId, offeredAt: now });
    return copy(next);
  }
  async change(id: string, expected: { status: CoreLifecycleStatus; instanceId: string }, change: Partial<WorkExecution>) {
    const found = this.executions.get(id);
    if (!found || found.status !== expected.status || found.instanceId !== expected.instanceId) return false;
    Object.assign(found, copy(change));
    return true;
  }
  async cancelPending(commandId: string, now: string) { for (const item of this.executions.values()) if (item.commandId === commandId && item.status === 'PENDING') Object.assign(item, { status: 'CANCELLED', completedAt: now }); }
  async listRunning() { return [...this.executions.values()].filter((item) => item.status === 'RUNNING').map(copy); }
  async addAnswer(_id: string, answer: WorkAnswer) { this.answers.set(answer.executionId, copy(answer)); }
  async getAnswer(executionId: string) { const found = this.answers.get(executionId); return found && copy(found); }
  async recentAnswers(serviceVersionIds: string[], limit: number) {
    return [...this.answers.values()].map((answer) => ({ serviceVersionId: this.executions.get(answer.executionId)?.serviceVersionId ?? '', answer }))
      .filter((entry) => serviceVersionIds.includes(entry.serviceVersionId)).sort((a, b) => b.answer.recordedAt.localeCompare(a.answer.recordedAt)).slice(0, limit).map(copy);
  }
  async addResult(result: CommandResult) { if (this.results.has(result.commandId)) return false; this.results.set(result.commandId, copy(result)); return true; }
  async getResult(commandId: string) { const found = this.results.get(commandId); return found && copy(found); }
}

/** A refusal at the "may" step. It says only "not allowed" (D-150, D-163). */
/**
 * The organization's choices that apply to a command (D-190 to D-195), as Foundation Access gives them with its "may"
 * answer. lists: the ordered lists of services that apply, most specific first; a service must be on every one. An entry
 * is a service key (its versions, newest first) or key@version. way: the default way of choosing. approved: the service
 * version IDs approved for the organization, which count only when approvalRequired. settings: the organization's choice
 * of each service's settings, by service key (such as { "neo.ai.claude": { model: "claude-sonnet-5-5" } }, D-204).
 */
export type OrganizationChoices = { lists: string[][]; way?: ChoosingWay; approvalRequired: boolean; approved: string[]; settings?: Record<string, Record<string, string>> };
/** organizationId: the organization the command belongs to; null when Foundation Access was asked and found none (D-209). */
export type MayAnswer = { allowed: boolean; choices?: OrganizationChoices; organizationId?: string | null };
export type MayRequest = { capabilityKey: string; jobKey?: string; workspaceId?: string };

/** Whether a list entry names this service: its key, or its key and version. */
const names = (entry: string, service: ServiceVersion) => { const [key, version] = entry.split('@'); return key === service.serviceKey && (version === undefined || version === service.version); };
/** Newer versions first: compared part by part, numbers as numbers. */
const newerFirst = (a: ServiceVersion, b: ServiceVersion) => {
  const left = a.version.split(/[.+-]/), right = b.version.split(/[.+-]/);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const x = left[i] ?? '', y = right[i] ?? '';
    const difference = /^\d+$/.test(x) && /^\d+$/.test(y) ? Number(y) - Number(x) : y.localeCompare(x);
    if (difference) return difference;
  }
  return 0;
};

export class NotAllowedError extends Error { constructor() { super('Not allowed'); this.name = 'NotAllowedError'; } }

type Payload = { capabilityVersionId: string; capabilityKey: string; version: string; operation: string; way: ChoosingWay; services: string[]; input: JsonValue; enough?: number; settings?: Record<string, Record<string, string>> };
const text = (value: unknown, name: string, max = 200) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new CapabilityRecordError(`${name} must be a non-empty string of at most ${max} characters`);
  return value.trim();
};
const seconds = (value: unknown, max: number, fallback: number) => {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new CapabilityRecordError(`waitSeconds must be a number from 0 to ${max}`);
  return Math.min(value, max);
};

export class CapabilityWork {
  private readonly changes = new EventEmitter();
  constructor(
    private readonly core: SemaCore,
    private readonly records: CapabilityStore,
    private readonly store: WorkStore,
    private readonly issue: (typeCode: string, metadata: JsonObject) => Promise<string>,
  ) { this.changes.setMaxListeners(0); }

  /**
   * Runs an operation of a capability. `may` asks Foundation Access whether the caller may use the capability (and its
   * job), and gets the organization's choices with the answer; when it says no, the caller is told only "not allowed",
   * never which services exist or why they could not run.
   */
  async run(caller: string | null, input: { capabilityKey: unknown; version: unknown; operation: unknown; way?: unknown; services?: unknown; input?: unknown; waitSeconds?: unknown; workspaceId?: unknown; enough?: unknown }, may: (request: MayRequest) => Promise<MayAnswer>) {
    if (!caller) throw new CapabilityRecordError('Only a program that has proved who it is may issue a command');
    if ((await this.records.listInstances()).some((instance) => instance.applicationKey === caller)) throw new CapabilityRecordError('A service never issues a command: this program key runs a service (D-160)');
    const capabilityKey = text(input.capabilityKey, 'capabilityKey', 120), version = text(input.version, 'version', 40);
    const waitSeconds = seconds(input.waitSeconds, LIMITS.maxWaitSeconds, 30);

    const capability = await this.records.findCapabilityVersion(capabilityKey, version);
    // May: the capability, and the job when the operation names one (D-174), with the organization's choices (D-193). It
    // is asked before anything is said about the capability or its services, so a caller who may not use it learns nothing.
    const requested = capability?.operations.find((item) => item.key === input.operation);
    const job = requested?.job && input.input && typeof input.input === 'object' ? (input.input as Record<string, unknown>)[requested.job] as { key?: unknown } | undefined : undefined;
    const jobKey = typeof job?.key === 'string' && /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(job.key) ? job.key : undefined;
    const workspaceId = typeof input.workspaceId === 'string' && input.workspaceId ? input.workspaceId : undefined;
    const refuse = async () => {
      await this.core.recordAudit({ action: 'capability.command.refused', actorId: caller, evidence: { capabilityKey, version, reason: 'not allowed' } });
      return new NotAllowedError();
    };
    const answer = await may({ capabilityKey, ...(jobKey ? { jobKey } : {}), ...(workspaceId ? { workspaceId } : {}) });
    if (!answer.allowed) throw await refuse();
    // Can: what could run, within the organization's choices.
    const plan = await this.plan(capability, capabilityKey, version, input, answer.choices);
    if (plan === 'not allowed') throw await refuse();
    // Should: which services, by the way of choosing the command asked for.
    const ready = plan.requested.filter((service) => plan.live.get(service.id)?.length);
    const chosen = plan.way === 'consensus' ? ready : ready.slice(0, 1);
    if (!chosen.length) {
      await this.core.recordAudit({ action: 'capability.command.not-now', actorId: caller, subjectIds: [plan.capability.id], evidence: { reasons: plan.reasons } });
      throw new CapabilityRecordError(`No service can run now. ${plan.reasons.join('. ')}`);
    }
    const body = input.input === undefined ? {} : input.input as JsonValue;
    const operation = plan.capability.operations.find((item) => item.key === plan.operation)!;
    if (operation.input) {
      const problems = valueProblems(operation.input, body, 'input');
      if (problems.length) throw new CapabilityRecordError(`The input does not match ${capabilityKey} ${version}: ${problems.join('; ')}`);
    }
    if (operation.job && !jobKey) throw new CapabilityRecordError(`${capabilityKey} ${version} needs input.${operation.job}.key, the job this call is for: lowercase words joined by dots or hyphens`);
    if (operation.answerShape) {
      const shape = (body as Record<string, unknown>)[operation.answerShape.input];
      const problems = schemaProblems(shape, `input.${operation.answerShape.input}`);
      if (problems.length) throw new CapabilityRecordError(`The requested answer shape cannot be checked: ${problems.slice(0, 5).join('; ')}`);
    }
    // Enough (D-182): under all of them, how many answers finish the command; the rest record theirs late.
    let enough: number | undefined;
    if (input.enough !== undefined) {
      if (plan.way !== 'consensus') throw new CapabilityRecordError('enough applies only when all of them are asked (consensus)');
      if (!Number.isSafeInteger(input.enough) || (input.enough as number) < 1) throw new CapabilityRecordError('enough must be a whole number, 1 or more');
      if ((input.enough as number) > chosen.length) throw new CapabilityRecordError(`enough is ${String(input.enough)}, but only ${chosen.length} service${chosen.length === 1 ? '' : 's'} can run now. ${plan.reasons.join('. ')}`.trim());
      enough = input.enough as number;
    }
    // Execute: one execution per chosen service. Under dynamic, the rest wait in order in case the first declines.
    const services = plan.way === 'consensus' ? chosen : plan.requested;
    // The organization's settings for the services that may do this work (D-204), recorded with the command.
    const settings = Object.fromEntries(services.map((service) => [service.serviceKey, answer.choices?.settings?.[service.serviceKey]]).filter((entry): entry is [string, Record<string, string>] => Boolean(entry[1])));
    const payload: Payload = { capabilityVersionId: plan.capability.id, capabilityKey, version, operation: plan.operation, way: plan.way, services: services.map((service) => service.id), input: body, ...(enough ? { enough } : {}), ...(Object.keys(settings).length ? { settings } : {}) };
    const command = await this.core.createCommand({ commandType: 'capability.run', actorId: caller, workspaceId: workspaceId ?? null, subjectIds: [plan.capability.id], payload: payload as unknown as JsonObject });
    for (const service of chosen) await this.addExecution(command.id, service.id);
    await this.core.updateCommandStatus({ commandId: command.id, status: 'RUNNING' });
    await this.core.recordAudit({ action: 'capability.command.run', actorId: caller, commandId: command.id, subjectIds: [plan.capability.id, ...chosen.map((service) => service.id)], evidence: { operation: plan.operation, way: plan.way, ...(enough ? { enough } : {}) } });
    await this.waitUntilFinished(command.id, waitSeconds);
    const entries = await this.entries(command.id);
    // Said plainly when the organization's choices could not apply: no workspace, and the program's grant names no organization (D-209).
    const notes = answer.organizationId === null ? ['No organization was found for this command (it names no workspace, and the calling program\'s grant names no organization), so the organization\'s choices, such as allowed services and service settings, were not applied.'] : [];
    const result: CommandResult = { id: await this.issue('RESULT', { commandId: command.id }), commandId: command.id, entries, recordedAt: new Date().toISOString(), ...(notes.length ? { notes } : {}) };
    await this.store.addResult(result);
    return result;
  }

  /** Waits again on a command, as its reference: what each execution has done so far. The command's result never changes. */
  async waitOn(caller: string | null, input: { commandId: unknown; waitSeconds?: unknown }) {
    const commandId = text(input.commandId, 'commandId');
    const command = await this.core.getCommand(commandId);
    if (!command || command.commandType !== 'capability.run' || command.actorId !== caller) throw new CapabilityRecordError(`Command ${commandId} is not one of this program's capability commands`);
    await this.waitUntilFinished(commandId, seconds(input.waitSeconds, LIMITS.maxWaitSeconds, 30));
    return { commandId, entries: await this.entries(commandId), result: await this.store.getResult(commandId) };
  }

  /**
   * A service's usage on its latest answers (D-205): the model and tokens each answer reported, for estimating what a run
   * costs at each model's price. Only answers that carry usage figures count.
   */
  async usage(input: { serviceKey: unknown; limit?: unknown }) {
    const serviceKey = text(input.serviceKey, 'serviceKey', 120);
    const limit = input.limit === undefined ? 20 : Number(input.limit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new CapabilityRecordError('limit must be a whole number from 1 to 200');
    const versions = (await this.records.listServiceVersions()).filter((service) => service.serviceKey === serviceKey);
    const recent = await this.store.recentAnswers(versions.map((service) => service.id), limit * 3);
    const runs = recent.map(({ serviceVersionId, answer }) => {
      const usage = (answer.answer as { usage?: { model?: unknown; inputTokens?: unknown; outputTokens?: unknown } } | undefined)?.usage;
      return usage && typeof usage.inputTokens === 'number' && typeof usage.outputTokens === 'number' ? { version: versions.find((service) => service.id === serviceVersionId)?.version, recordedAt: answer.recordedAt, model: typeof usage.model === 'string' ? usage.model : undefined, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens } : undefined;
    }).filter((run): run is NonNullable<typeof run> => Boolean(run)).slice(0, limit);
    return { serviceKey, runs };
  }

  /** A running copy asks for work, and is held until there is some or its wait runs out. Asking counts as checking in. */
  async takeWork(caller: string | null, input: { instanceId: unknown; waitSeconds?: unknown; resources?: unknown }) {
    const { instance, serviceVersionId } = await this.ownInstance(caller, input.instanceId);
    const deadline = Date.now() + seconds(input.waitSeconds, LIMITS.maxWorkWaitSeconds, LIMITS.maxWorkWaitSeconds) * 1000;
    for (;;) {
      const now = new Date();
      await this.records.updateInstance(instance.id, { lastCheckInAt: now.toISOString(), ...(input.resources && typeof input.resources === 'object' && !Array.isArray(input.resources) ? { resources: input.resources as JsonObject } : {}) });
      const offered = await this.store.claim(serviceVersionId, instance.id, now.toISOString(), new Date(now.getTime() - LIMITS.offerSeconds * 1000).toISOString());
      if (offered) {
        const command = (await this.core.getCommand(offered.commandId))!;
        const payload = command.payload as unknown as Payload;
        this.changed();
        const serviceKey = (await this.records.getServiceVersion(serviceVersionId))?.serviceKey;
        const settings = serviceKey ? payload.settings?.[serviceKey] : undefined;
        return { work: { executionId: offered.id, commandId: offered.commandId, capabilityKey: payload.capabilityKey, version: payload.version, operation: payload.operation, input: payload.input, answerWithinSeconds: LIMITS.offerSeconds, ...(settings ? { settings } : {}) } };
      }
      if (Date.now() >= deadline) return { work: null };
      await this.nextChange(Math.min(1000, deadline - Date.now()));
    }
  }

  /**
   * The instance answers the work it was offered (N3): accept; decline with a reason; defer, saying until when (at most a
   * day) and why (D-178); or unavailable, with the reasons (D-179). Decline, defer and unavailable are "not now": under a
   * list in order the next service is tried meanwhile; a deferred execution is offered again once its time has come.
   */
  async answer(caller: string | null, input: { instanceId: unknown; executionId: unknown; answer: unknown; reason?: unknown; until?: unknown; reasons?: unknown }) {
    const { instance } = await this.ownInstance(caller, input.instanceId);
    const executionId = text(input.executionId, 'executionId');
    const expected = { status: 'WAITING' as const, instanceId: instance.id };
    const now = new Date();
    let changed: boolean;
    if (input.answer === 'accept') changed = await this.store.change(executionId, expected, { status: 'RUNNING', startedAt: now.toISOString() });
    else if (input.answer === 'decline') changed = await this.store.change(executionId, expected, { status: 'FAILED', completedAt: now.toISOString(), notNow: { answer: 'decline', reason: text(input.reason, 'reason', 500) } });
    else if (input.answer === 'defer') {
      const until = typeof input.until === 'string' ? Date.parse(input.until) : NaN;
      if (!Number.isFinite(until) || until <= now.getTime() || until > now.getTime() + LIMITS.maxDeferSeconds * 1000) throw new CapabilityRecordError(`until must be a time after now and at most ${LIMITS.maxDeferSeconds / 3600} hours ahead`);
      changed = await this.store.change(executionId, expected, { status: 'PENDING', deferred: { until: new Date(until).toISOString(), reason: text(input.reason, 'reason', 500) } });
    } else if (input.answer === 'unavailable') {
      const reasons = this.reasons(input.reasons);
      const reason = input.reason === undefined ? reasons.map(describeReason).join('; ') : text(input.reason, 'reason', 500);
      changed = await this.store.change(executionId, expected, { status: 'FAILED', completedAt: now.toISOString(), notNow: { answer: 'unavailable', reason, reasons } });
    } else throw new CapabilityRecordError('answer must be accept, decline, defer or unavailable');
    if (!changed) throw new CapabilityRecordError(`Execution ${executionId} is not waiting for this instance's answer; it may have been offered to another after ${LIMITS.offerSeconds} s`);
    const execution = (await this.store.getExecution(executionId))!;
    if (input.answer === 'defer') await this.passOn(execution.commandId);
    else if (input.answer !== 'accept') await this.afterFinish(execution);
    this.changed();
    return execution;
  }

  /** The instance says it is still working on a job, optionally how far along (a percentage) and a short note (D-180). */
  async progress(caller: string | null, input: { instanceId: unknown; executionId: unknown; percent?: unknown; note?: unknown }) {
    const { instance } = await this.ownInstance(caller, input.instanceId);
    const executionId = text(input.executionId, 'executionId');
    if (input.percent !== undefined && (typeof input.percent !== 'number' || !Number.isFinite(input.percent) || input.percent < 0 || input.percent > 100)) throw new CapabilityRecordError('percent must be a number from 0 to 100');
    const progress = { at: new Date().toISOString(), ...(input.percent !== undefined ? { percent: input.percent as number } : {}), ...(input.note !== undefined ? { note: text(input.note, 'note', 200) } : {}) };
    if (!(await this.store.change(executionId, { status: 'RUNNING', instanceId: instance.id }, { progress }))) throw new CapabilityRecordError(`Execution ${executionId} is not running on this instance`);
    return { executionId, progress };
  }

  /**
   * Marks failed every execution whose service has not said it is still working for `silentMs` (D-180): it crashed or
   * hung in the middle of the job. Under a list in order the next service is tried. Says which were marked.
   */
  async markSilent(silentMs: number = LIMITS.silentSeconds * 1000) {
    const cutoff = Date.now() - silentMs;
    const marked: string[] = [];
    for (const execution of await this.store.listRunning()) {
      const last = Date.parse(execution.progress?.at ?? execution.startedAt ?? execution.createdAt);
      if (last >= cutoff) continue;
      const now = new Date().toISOString();
      if (await this.store.change(execution.id, { status: 'RUNNING', instanceId: execution.instanceId! }, { status: 'FAILED', completedAt: now, error: `stopped reporting: no word from the service for ${Math.round(silentMs / 1000)} s` })) {
        marked.push(execution.id);
        await this.afterFinish((await this.store.getExecution(execution.id))!);
      }
    }
    if (marked.length) this.changed();
    return marked;
  }

  private reasons(value: unknown): UnavailableReason[] {
    if (!Array.isArray(value) || !value.length || value.length > 20) throw new CapabilityRecordError('reasons must list 1 to 20 reasons, each { kind, and needed, free and total for memory, disk, processor or graphics, or else lasting; note? }');
    const amount = (value: unknown, name: string) => {
      if (value === undefined) return undefined;
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new CapabilityRecordError(`${name} must be a number, 0 or more`);
      return value;
    };
    return value.map((item) => {
      const reason = item as Record<string, unknown>;
      if (!reason || typeof reason !== 'object' || !(UNAVAILABLE_KINDS as readonly unknown[]).includes(reason.kind)) throw new CapabilityRecordError(`Each reason's kind must be one of ${UNAVAILABLE_KINDS.join(', ')}`);
      const kind = reason.kind as UnavailableReason['kind'];
      const note = reason.note !== undefined ? { note: text(reason.note, 'note', 200) } : {};
      const needed = amount(reason.needed, 'needed'), free = amount(reason.free, 'free'), total = amount(reason.total, 'total');
      // Measured: Core decides from the numbers, whatever the service said (D-185).
      if (isMeasured(kind) && needed !== undefined && total !== undefined) {
        if (free !== undefined && free > total) throw new CapabilityRecordError(`${kind}: free cannot be more than total`);
        return { kind, lasting: needed > total ? 'permanent' as const : 'temporary' as const, needed, ...(free !== undefined ? { free } : {}), total, ...note };
      }
      if (isMeasured(kind) && (needed !== undefined || free !== undefined || total !== undefined)) throw new CapabilityRecordError(`${kind}: give needed and total (and free), in ${MEASURE_UNITS[kind]}, so Core can tell temporary from permanent`);
      if (reason.lasting !== 'temporary' && reason.lasting !== 'permanent') throw new CapabilityRecordError(`${kind}: say whether it is temporary or permanent (lasting)${isMeasured(kind) ? `, or give needed, free and total in ${MEASURE_UNITS[kind]}` : ''}`);
      return { kind, lasting: reason.lasting, ...note };
    });
  }

  /** The instance reports what it did: a small answer inline, or a reference to where it stored a larger one; or that it failed. */
  async report(caller: string | null, input: { instanceId: unknown; executionId: unknown; status: unknown; outcome?: unknown; answer?: unknown; reference?: unknown; error?: unknown }) {
    const { instance } = await this.ownInstance(caller, input.instanceId);
    const executionId = text(input.executionId, 'executionId');
    const execution = await this.store.getExecution(executionId);
    if (!execution || execution.status !== 'RUNNING' || execution.instanceId !== instance.id) throw new CapabilityRecordError(`Execution ${executionId} is not running on this instance`);
    if (input.outcome !== undefined && !(OUTCOMES as readonly unknown[]).includes(input.outcome)) throw new CapabilityRecordError(`outcome must be one of ${OUTCOMES.join(', ')}`);
    const now = new Date().toISOString();
    if (input.status === 'SUCCESS') {
      if ((input.answer === undefined) === (input.reference === undefined)) throw new CapabilityRecordError('A successful report carries either an answer or a reference, not both');
      if (input.answer !== undefined) {
        if (Buffer.byteLength(JSON.stringify(input.answer)) > LIMITS.inlineBytes) throw new CapabilityRecordError(`An answer over ${LIMITS.inlineBytes / 1024} KB goes by reference: store it and report where`);
        const command = (await this.core.getCommand(execution.commandId))!;
        const payload = command.payload as unknown as Payload;
        const operation = (await this.records.getCapabilityVersion(payload.capabilityVersionId))!.operations.find((item) => item.key === payload.operation);
        const problems = operation?.output ? valueProblems(operation.output, input.answer, 'answer') : [];
        // The answer also matches the shape the caller asked for (D-174).
        if (!problems.length && operation?.answerShape) {
          const shape = (payload.input as Record<string, unknown>)[operation.answerShape.input] as JsonObject;
          problems.push(...valueProblems(shape, (input.answer as Record<string, unknown>)?.[operation.answerShape.output], `answer.${operation.answerShape.output}`));
        }
        if (problems.length) throw new CapabilityRecordError(`The answer does not match ${payload.capabilityKey} ${payload.version}: ${problems.join('; ')}`);
      }
      const reference = input.reference === undefined ? undefined : text(input.reference, 'reference', 2000);
      await this.store.addAnswer(await this.issue('RESULT', { executionId }), { executionId, ...(input.outcome ? { outcome: input.outcome as WorkAnswer['outcome'] } : {}), ...(input.answer !== undefined ? { answer: input.answer as JsonValue } : { reference }), recordedAt: now });
      await this.store.change(executionId, { status: 'RUNNING', instanceId: instance.id }, { status: 'SUCCESS', completedAt: now });
    } else if (input.status === 'FAILED') {
      await this.store.change(executionId, { status: 'RUNNING', instanceId: instance.id }, { status: 'FAILED', completedAt: now, error: text(input.error, 'error', 2000) });
    } else throw new CapabilityRecordError('status must be SUCCESS or FAILED');
    const done = (await this.store.getExecution(executionId))!;
    await this.afterFinish(done);
    this.changed();
    return done;
  }

  /**
   * Can, within the organization's choices (D-190 to D-195). A service not on every list that applies, or not approved
   * where approval is on, is passed over like one that cannot run; when that leaves none, the answer is "not allowed".
   * A command that names no way gets the default; one that names no services gets the default order.
   */
  private async plan(capability: CapabilityVersion | undefined, capabilityKey: string, version: string, input: { operation: unknown; way?: unknown; services?: unknown }, choices?: OrganizationChoices) {
    if (!capability) throw new CapabilityRecordError(`${capabilityKey} ${version} is not registered on this Core`);
    if (capability.status !== 'ACTIVE') throw new CapabilityRecordError(`${capabilityKey} ${version} is not active`);
    if (!capability.choosing.length) throw new CapabilityRecordError(`${capabilityKey} ${version} lists no ways of choosing its services, so it cannot be run by command: programs reach its services directly`);
    const operation = text(input.operation, 'operation', 60);
    if (!capability.operations.some((item) => item.key === operation)) throw new CapabilityRecordError(`${capabilityKey} ${version} has no operation ${operation}`);
    const way = (input.way ?? choices?.way) as ChoosingWay;
    if (way === undefined) throw new CapabilityRecordError(`Name a way of choosing (${capability.choosing.join(', ')}): the organization sets no default for ${capabilityKey}`);
    if (!capability.choosing.includes(way)) throw new CapabilityRecordError(`${capabilityKey} ${version} permits choosing its services by ${capability.choosing.join(', ')}, not ${String(way)}${input.way === undefined ? ' (the organization\'s default)' : ''}`);
    if (way === 'policy') throw new CapabilityRecordError('Choosing by policy rules is not built yet; a command that names no way gets the organization\'s default way and order');
    const all = (await this.records.listServiceVersions()).filter((service) => service.capabilityVersionId === capability.id && service.status === 'ACTIVE' && service.operations.includes(operation));
    if (input.services !== undefined && (!Array.isArray(input.services) || !input.services.length || input.services.length > 50)) throw new CapabilityRecordError('services must list 1 to 50 service version IDs or service keys');
    const named = ((input.services ?? []) as unknown[]).map((value) => {
      const name = text(value, 'service', 120);
      const matches = all.filter((service) => service.id === name || service.serviceKey === name);
      if (!matches.length) throw new CapabilityRecordError(`${name} is not a service of ${capabilityKey} ${version} offering ${operation}`);
      if (matches.length > 1) throw new CapabilityRecordError(`${name} has several versions for ${capabilityKey} ${version}: name the service version ID`);
      return matches[0];
    });
    if (new Set(named.map((service) => service.id)).size !== named.length) throw new CapabilityRecordError('services must not repeat');
    const lists = choices?.lists ?? [];
    if (way === 'bound' && named.length > 1) throw new CapabilityRecordError('Bound runs exactly one service: name it, and only it');
    if (!named.length && !lists.length && way !== 'consensus') throw new CapabilityRecordError(way === 'bound' ? 'Bound runs exactly one service: name it, and only it' : 'Dynamic needs the services in order of preference');
    const usable = (service: ServiceVersion) => lists.every((list) => list.some((entry) => names(entry, service))) && (!choices?.approvalRequired || choices.approved.includes(service.id));
    // The default order: the most specific list, each entry's versions newest first.
    const ordered = lists.length ? [...new Set(lists[0].flatMap((entry) => all.filter((service) => names(entry, service)).sort(newerFirst)))] : all;
    const candidates = named.length ? named : ordered;
    let requested = candidates.filter(usable);
    if (candidates.length && !requested.length) return 'not allowed' as const;
    if (way === 'bound') requested = requested.slice(0, 1);
    // Can (CL-8, D-181): which requested services have a running copy that has checked in lately and whose machine meets
    // what the service needs now, and why the others cannot run.
    const live = new Map<string, ServiceInstance[]>(), reasons: string[] = [];
    for (const service of requested) {
      const able = await this.able(service);
      live.set(service.id, able.copies);
      if (able.reason) reasons.push(`${service.serviceKey} ${service.version}: ${able.reason}`);
    }
    if (!requested.length) reasons.push(`no service of ${capabilityKey} ${version} offers ${operation}`);
    return { capability, operation, way, requested, live, reasons };
  }

  /**
   * The running copies of a service that can take its work now: installed here, checked in lately, and on a machine
   * meeting what the service needs (D-181). When none can, why, temporary or permanent (D-185).
   */
  private async able(service: ServiceVersion): Promise<{ copies: ServiceInstance[]; reason?: string }> {
    const installation = (await this.records.listInstallations()).find((item) => item.serviceVersionId === service.id);
    if (!installation) return { copies: [], reason: 'not installed on this machine (permanent until it is installed)' };
    const liveAfter = Date.now() - LIMITS.liveSeconds * 1000;
    const copies = (await this.records.listInstances()).filter((item) => item.installationId === installation.id && item.state === 'RUNNING' && Date.parse(item.lastCheckInAt) >= liveAfter);
    if (!copies.length) return { copies: [], reason: `not running, no copy has checked in for ${LIMITS.liveSeconds} s (temporary)` };
    const needs = needsOf(service.declarations);
    const checked = copies.map((copy) => ({ copy, short: shortfalls(needs, copy.resources as MachineReport) }));
    const ready = checked.filter((item) => !item.short.length).map((item) => item.copy);
    if (ready.length) return { copies: ready };
    // Every copy falls short: say why, preferring a temporary reason (one copy may yet be able) over a permanent one.
    const best = checked.find((item) => item.short.every((reason) => reason.lasting === 'temporary')) ?? checked[0];
    return { copies: [], reason: best.short.map(describeReason).join('; ') };
  }

  private async addExecution(commandId: string, serviceVersionId: string) {
    const execution: WorkExecution = { id: await this.issue('EXECUTION', { commandId }), commandId, serviceVersionId, status: 'PENDING', createdAt: new Date().toISOString() };
    await this.store.addExecution(execution);
    this.changed();
  }

  /**
   * Under a list in order (dynamic), when nothing is being worked on or waiting to be offered now (a deferred execution
   * waits for its time), the command passes to the next service in the order asked for that has a running copy. A
   * bound command never passes to another service. Says whether it passed the command on.
   */
  private async passOn(commandId: string) {
    const command = (await this.core.getCommand(commandId))!;
    const payload = command.payload as unknown as Payload;
    if (payload.way !== 'dynamic') return false;
    const executions = await this.store.listExecutions(commandId);
    const active = executions.some((item) => item.status === 'SUCCESS' || item.status === 'WAITING' || item.status === 'RUNNING' || (item.status === 'PENDING' && !item.deferred));
    if (active) return false;
    const tried = new Set(executions.map((item) => item.serviceVersionId));
    let next: string | undefined;
    for (const id of payload.services.filter((item) => !tried.has(item))) {
      const service = await this.records.getServiceVersion(id);
      if (service && (await this.able(service)).copies.length) { next = id; break; }
    }
    if (!next) return false;
    await this.addExecution(commandId, next);
    return true;
  }

  /**
   * After an execution finishes. Under a list in order, a success cancels any deferred one still waiting, and anything
   * else passes the command to the next service. Under all of them, the command is finished once enough have succeeded
   * (D-182); the rest carry on and record theirs late. When every execution has finished, the command's status says so.
   */
  private async afterFinish(execution: WorkExecution) {
    const command = (await this.core.getCommand(execution.commandId))!;
    const payload = command.payload as unknown as Payload;
    const now = new Date().toISOString();
    if (payload.way === 'dynamic') {
      if (execution.status === 'SUCCESS') await this.store.cancelPending(command.id, now);
      else if (await this.passOn(command.id)) return;
    }
    const executions = await this.store.listExecutions(command.id);
    const succeeded = executions.filter((item) => item.status === 'SUCCESS').length;
    if (payload.enough && succeeded >= payload.enough && !finished(command.status)) { await this.core.updateCommandStatus({ commandId: command.id, status: 'SUCCESS' }); return; }
    if (executions.every((item) => finished(item.status))) await this.core.updateCommandStatus({ commandId: command.id, status: succeeded ? 'SUCCESS' : 'FAILED' });
  }

  private async entries(commandId: string): Promise<ResultEntry[]> {
    const services = await this.records.listServiceVersions();
    return Promise.all((await this.store.listExecutions(commandId)).map(async (execution) => {
      const answer = execution.status === 'SUCCESS' ? await this.store.getAnswer(execution.id) : undefined;
      return {
        executionId: execution.id, serviceVersionId: execution.serviceVersionId, serviceKey: services.find((service) => service.id === execution.serviceVersionId)?.serviceKey ?? '', status: execution.status,
        ...(answer?.outcome ? { outcome: answer.outcome } : {}), ...(answer?.answer !== undefined ? { answer: answer.answer } : {}), ...(answer?.reference ? { reference: answer.reference } : {}),
        ...(execution.notNow ? { notNow: execution.notNow } : {}), ...(execution.status === 'PENDING' && execution.deferred ? { deferredUntil: execution.deferred.until } : {}),
        ...(execution.status === 'RUNNING' && execution.progress ? { progress: execution.progress } : {}), ...(execution.error ? { error: execution.error } : {}),
      };
    }));
  }

  private async ownInstance(caller: string | null, instanceId: unknown) {
    const instance = await this.records.getInstance(text(instanceId, 'instanceId'));
    if (!instance) throw new CapabilityRecordError(`Instance ${String(instanceId)} is not on this machine`);
    if (instance.state !== 'RUNNING') throw new CapabilityRecordError(`Instance ${instance.id} has stopped; start a new one`);
    if (!instance.applicationKey) throw new CapabilityRecordError(`Instance ${instance.id} was recorded before Core knew which program runs it; start a new one`);
    if (instance.applicationKey !== caller) throw new CapabilityRecordError(`Instance ${instance.id} belongs to another program`);
    const installation = (await this.records.getInstallation(instance.installationId))!;
    return { instance, serviceVersionId: installation.serviceVersionId };
  }

  /**
   * Waits until the command is finished or the time is up. The command's own status is the signal, not its executions:
   * between one service declining and the next being given the work, every execution so far has finished, but the
   * command has not.
   */
  private async waitUntilFinished(commandId: string, waitSeconds: number) {
    const deadline = Date.now() + waitSeconds * 1000;
    for (;;) {
      if (finished((await this.core.getCommand(commandId))!.status)) return;
      if (Date.now() >= deadline) return;
      await this.nextChange(Math.min(1000, deadline - Date.now()));
    }
  }

  private changed() { this.changes.emit('change'); }
  /** Waits for the next change made through this Core, or the time given, whichever comes first. */
  private nextChange(ms: number) {
    return new Promise<void>((resolve) => {
      const done = () => { clearTimeout(timer); this.changes.off('change', done); resolve(); };
      const timer = setTimeout(done, Math.max(0, ms));
      this.changes.once('change', done);
    });
  }
}
