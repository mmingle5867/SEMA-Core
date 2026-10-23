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
};

export type NotNow = { answer: 'decline' | 'unavailable'; reason: string };
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
  error?: string;
}
export interface CommandResult { id: string; commandId: string; entries: ResultEntry[]; recordedAt: string }

export interface WorkStore {
  addExecution(execution: WorkExecution): Promise<void>;
  getExecution(id: string): Promise<WorkExecution | undefined>;
  listExecutions(commandId: string): Promise<WorkExecution[]>;
  /** Offers the oldest waiting execution for the service version to the instance, atomically: PENDING, or offered before `staleBefore` and never answered. */
  claim(serviceVersionId: string, instanceId: string, now: string, staleBefore: string): Promise<WorkExecution | undefined>;
  /** Changes an execution only when it is still in the expected state and offered to the expected instance. Says whether it changed. */
  change(id: string, expected: { status: CoreLifecycleStatus; instanceId: string }, change: Partial<Pick<WorkExecution, 'status' | 'startedAt' | 'completedAt' | 'notNow' | 'error'>>): Promise<boolean>;
  addAnswer(id: string, answer: WorkAnswer): Promise<void>;
  getAnswer(executionId: string): Promise<WorkAnswer | undefined>;
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
    const next = [...this.executions.values()].filter((item) => item.serviceVersionId === serviceVersionId && (item.status === 'PENDING' || (item.status === 'WAITING' && item.offeredAt! < staleBefore))).sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
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
  async addAnswer(_id: string, answer: WorkAnswer) { this.answers.set(answer.executionId, copy(answer)); }
  async getAnswer(executionId: string) { const found = this.answers.get(executionId); return found && copy(found); }
  async addResult(result: CommandResult) { if (this.results.has(result.commandId)) return false; this.results.set(result.commandId, copy(result)); return true; }
  async getResult(commandId: string) { const found = this.results.get(commandId); return found && copy(found); }
}

/** A refusal at the "may" step. It says only "not allowed" (D-150, D-163). */
export class NotAllowedError extends Error { constructor() { super('Not allowed'); this.name = 'NotAllowedError'; } }

type Payload = { capabilityVersionId: string; capabilityKey: string; version: string; operation: string; way: ChoosingWay; services: string[]; input: JsonValue };
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
   * Runs an operation of a capability. `mayUse` asks Foundation Access whether the caller may use the capability; when it
   * says no, the caller is told only "not allowed", never which services exist or why they could not run.
   */
  async run(caller: string | null, input: { capabilityKey: unknown; version: unknown; operation: unknown; way: unknown; services?: unknown; input?: unknown; waitSeconds?: unknown; workspaceId?: unknown }, mayUse: (capabilityKey: string) => Promise<boolean>) {
    if (!caller) throw new CapabilityRecordError('Only a program that has proved who it is may issue a command');
    if ((await this.records.listInstances()).some((instance) => instance.applicationKey === caller)) throw new CapabilityRecordError('A service never issues a command: this program key runs a service (D-160)');
    const capabilityKey = text(input.capabilityKey, 'capabilityKey', 120), version = text(input.version, 'version', 40);
    const waitSeconds = seconds(input.waitSeconds, LIMITS.maxWaitSeconds, 30);

    // Can: work out what could run, but say nothing about it until "may" has passed.
    const capability = await this.records.findCapabilityVersion(capabilityKey, version);
    let plan: { capability: CapabilityVersion; operation: string; way: ChoosingWay; requested: ServiceVersion[]; live: Map<string, ServiceInstance[]>; reasons: string[] } | Error;
    try { plan = await this.plan(capability, capabilityKey, version, input); } catch (error) { plan = error as Error; }
    // May: the capability, and the job when the operation names one (D-174). The job key is read before anything else is
    // checked, so a caller who may not use the job learns nothing more.
    const requested = capability?.operations.find((item) => item.key === input.operation);
    const job = requested?.job && input.input && typeof input.input === 'object' ? (input.input as Record<string, unknown>)[requested.job] as { key?: unknown } | undefined : undefined;
    const jobKey = typeof job?.key === 'string' && /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(job.key) ? job.key : undefined;
    if (!(await mayUse(capabilityKey)) || (jobKey !== undefined && !(await mayUse(`${capabilityKey}.job.${jobKey}`)))) {
      await this.core.recordAudit({ action: 'capability.command.refused', actorId: caller, evidence: { capabilityKey, version, reason: 'not allowed' } });
      throw new NotAllowedError();
    }
    if (plan instanceof Error) throw plan;
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
    // Execute: one execution per chosen service. Under dynamic, the rest wait in order in case the first declines.
    const payload: Payload = { capabilityVersionId: plan.capability.id, capabilityKey, version, operation: plan.operation, way: plan.way, services: (plan.way === 'consensus' ? chosen : plan.requested).map((service) => service.id), input: body };
    const command = await this.core.createCommand({ commandType: 'capability.run', actorId: caller, workspaceId: typeof input.workspaceId === 'string' ? input.workspaceId : null, subjectIds: [plan.capability.id], payload: payload as unknown as JsonObject });
    for (const service of chosen) await this.addExecution(command.id, service.id);
    await this.core.updateCommandStatus({ commandId: command.id, status: 'RUNNING' });
    await this.core.recordAudit({ action: 'capability.command.run', actorId: caller, commandId: command.id, subjectIds: [plan.capability.id, ...chosen.map((service) => service.id)], evidence: { operation: plan.operation, way: plan.way } });
    await this.waitUntilFinished(command.id, waitSeconds);
    const entries = await this.entries(command.id);
    const result: CommandResult = { id: await this.issue('RESULT', { commandId: command.id }), commandId: command.id, entries, recordedAt: new Date().toISOString() };
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
        return { work: { executionId: offered.id, commandId: offered.commandId, capabilityKey: payload.capabilityKey, version: payload.version, operation: payload.operation, input: payload.input, answerWithinSeconds: LIMITS.offerSeconds } };
      }
      if (Date.now() >= deadline) return { work: null };
      await this.nextChange(Math.min(1000, deadline - Date.now()));
    }
  }

  /** The instance answers the work it was offered: accept, or decline with a reason ("not now"). */
  async answer(caller: string | null, input: { instanceId: unknown; executionId: unknown; answer: unknown; reason?: unknown }) {
    const { instance } = await this.ownInstance(caller, input.instanceId);
    const executionId = text(input.executionId, 'executionId');
    if (input.answer !== 'accept' && input.answer !== 'decline') throw new CapabilityRecordError('answer must be accept or decline');
    const now = new Date().toISOString();
    const changed = input.answer === 'accept'
      ? await this.store.change(executionId, { status: 'WAITING', instanceId: instance.id }, { status: 'RUNNING', startedAt: now })
      : await this.store.change(executionId, { status: 'WAITING', instanceId: instance.id }, { status: 'FAILED', completedAt: now, notNow: { answer: 'decline', reason: text(input.reason, 'reason', 500) } });
    if (!changed) throw new CapabilityRecordError(`Execution ${executionId} is not waiting for this instance's answer; it may have been offered to another after ${LIMITS.offerSeconds} s`);
    const execution = (await this.store.getExecution(executionId))!;
    if (input.answer === 'decline') await this.afterFinish(execution);
    this.changed();
    return execution;
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

  private async plan(capability: CapabilityVersion | undefined, capabilityKey: string, version: string, input: { operation: unknown; way: unknown; services?: unknown }) {
    if (!capability) throw new CapabilityRecordError(`${capabilityKey} ${version} is not registered on this Core`);
    if (capability.status !== 'ACTIVE') throw new CapabilityRecordError(`${capabilityKey} ${version} is not active`);
    if (!capability.choosing.length) throw new CapabilityRecordError(`${capabilityKey} ${version} lists no ways of choosing its services, so it cannot be run by command: programs reach its services directly`);
    const operation = text(input.operation, 'operation', 60);
    if (!capability.operations.some((item) => item.key === operation)) throw new CapabilityRecordError(`${capabilityKey} ${version} has no operation ${operation}`);
    const way = input.way as ChoosingWay;
    if (!capability.choosing.includes(way)) throw new CapabilityRecordError(`${capabilityKey} ${version} permits choosing its services by ${capability.choosing.join(', ')}, not ${String(input.way)}`);
    if (way === 'policy') throw new CapabilityRecordError('Choosing by the organization\'s rules is not available until organization rules are built');
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
    if (way === 'bound' && named.length !== 1) throw new CapabilityRecordError('Bound runs exactly one service: name it, and only it');
    if (way === 'dynamic' && !named.length) throw new CapabilityRecordError('Dynamic needs the services in order of preference');
    const requested = way === 'consensus' && !named.length ? all : named;
    // Can: which requested services have a running copy that has checked in lately, and why the others cannot run (CL-8).
    const installations = await this.records.listInstallations(), instances = await this.records.listInstances();
    const liveAfter = Date.now() - LIMITS.liveSeconds * 1000;
    const live = new Map<string, ServiceInstance[]>(), reasons: string[] = [];
    for (const service of requested) {
      const installation = installations.find((item) => item.serviceVersionId === service.id);
      const copies = installation ? instances.filter((item) => item.installationId === installation.id && item.state === 'RUNNING' && Date.parse(item.lastCheckInAt) >= liveAfter) : [];
      live.set(service.id, copies);
      if (!installation) reasons.push(`${service.serviceKey} ${service.version}: not installed on this machine (permanent until it is installed)`);
      else if (!copies.length) reasons.push(`${service.serviceKey} ${service.version}: not running, no copy has checked in for ${LIMITS.liveSeconds} s (temporary)`);
    }
    if (!requested.length) reasons.push(`no service of ${capabilityKey} ${version} offers ${operation}`);
    return { capability, operation, way, requested, live, reasons };
  }

  private async addExecution(commandId: string, serviceVersionId: string) {
    const execution: WorkExecution = { id: await this.issue('EXECUTION', { commandId }), commandId, serviceVersionId, status: 'PENDING', createdAt: new Date().toISOString() };
    await this.store.addExecution(execution);
    this.changed();
  }

  /**
   * After an execution finishes: under dynamic, a declined or failed one passes the command to the next service in the
   * order asked for that has a running copy; a bound command never passes to another service. When every execution has
   * finished, the command's status says so.
   */
  private async afterFinish(execution: WorkExecution) {
    const command = (await this.core.getCommand(execution.commandId))!;
    const payload = command.payload as unknown as Payload;
    const executions = await this.store.listExecutions(command.id);
    if (payload.way === 'dynamic' && execution.status !== 'SUCCESS' && !executions.some((item) => item.status === 'SUCCESS' || !finished(item.status))) {
      const tried = new Set(executions.map((item) => item.serviceVersionId));
      const installations = await this.records.listInstallations(), instances = await this.records.listInstances();
      const liveAfter = Date.now() - LIMITS.liveSeconds * 1000;
      const next = payload.services.filter((id) => !tried.has(id)).find((id) => {
        const installation = installations.find((item) => item.serviceVersionId === id);
        return installation && instances.some((item) => item.installationId === installation.id && item.state === 'RUNNING' && Date.parse(item.lastCheckInAt) >= liveAfter);
      });
      if (next) { await this.addExecution(command.id, next); return; }
    }
    const now = await this.store.listExecutions(command.id);
    if (now.every((item) => finished(item.status))) await this.core.updateCommandStatus({ commandId: command.id, status: now.some((item) => item.status === 'SUCCESS') ? 'SUCCESS' : 'FAILED' });
  }

  private async entries(commandId: string): Promise<ResultEntry[]> {
    const services = await this.records.listServiceVersions();
    return Promise.all((await this.store.listExecutions(commandId)).map(async (execution) => {
      const answer = execution.status === 'SUCCESS' ? await this.store.getAnswer(execution.id) : undefined;
      return {
        executionId: execution.id, serviceVersionId: execution.serviceVersionId, serviceKey: services.find((service) => service.id === execution.serviceVersionId)?.serviceKey ?? '', status: execution.status,
        ...(answer?.outcome ? { outcome: answer.outcome } : {}), ...(answer?.answer !== undefined ? { answer: answer.answer } : {}), ...(answer?.reference ? { reference: answer.reference } : {}),
        ...(execution.notNow ? { notNow: execution.notNow } : {}), ...(execution.error ? { error: execution.error } : {}),
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
