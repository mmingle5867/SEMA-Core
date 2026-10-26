import { statfs } from 'node:fs/promises';
import { availableParallelism, freemem, totalmem } from 'node:os';
import { openCoreClientSigning, type CoreClientSigning } from '../keys/client-signing.js';
import type { StoredKey } from '../keys/machine-key.js';
import type { ServiceOffers } from '../capabilities/records.js';
import type { JsonValue } from '../core/types.js';
import { valueProblems } from '../capabilities/schema.js';
// A type only: nothing from Core's database layer is loaded with the wrapper.
import type { MachineReport, UnavailableReason } from '../capabilities/work.js';

/**
 * The wrapper (C6, D-166): the small standard boundary every service runs in, so the service holds only its business
 * logic. This first version does what phase 2 needs and nothing more:
 *
 * - proves the service with its own key (signed requests, D-123), under its own program key (D-160);
 * - finds its installation on this machine and records a running instance, trying again until Core accepts it;
 * - asks Core for work, a few jobs at once up to its capacity, which also keeps the instance checked in;
 * - accepts the work, or declines it with the reason the service gives ("not now");
 * - runs the service's handler for the operation and checks its answer against the capability's contract before
 *   reporting it (D-155); an answer that does not match is reported as a failure, saying why;
 * - reports the answer inline, or a reference when the service stored a larger one (D-164); a handler that throws is
 *   reported as a failure with its message;
 * - stops cleanly: no new work is taken, work in hand is finished, and the instance is recorded as stopped.
 *
 * Not yet: deferring work, "still working" reports and usage figures (phases 3 and 4), and checking the package
 * fingerprint before starting (phase 4). Nothing here needs Core's database layer: a service on the same machine loads
 * it from Core's folder (dist/wrapper/service-wrapper.js), as programs load the signing code.
 */
/** settings: the organization's choice of this service's settings (D-204), such as { model: "claude-sonnet-5-5" }; empty when none. */
export interface Work { executionId: string; commandId: string; capabilityKey: string; version: string; operation: string; input: JsonValue; settings?: Record<string, string> }
export type HandlerResult = { answer: JsonValue; outcome?: Outcome } | { reference: string; outcome?: Outcome };
export type Outcome = 'achieved' | 'partly' | 'not-achieved' | 'needs-review';
/** Says the service is still working, optionally how far along (0 to 100) and a short note (D-180). The wrapper also says so on its own every 30 s. */
export type Progress = (percent?: number, note?: string) => void;
export type Handler = (input: JsonValue, work: Work, progress: Progress) => Promise<HandlerResult>;
/** What the service says when offered work: take it (true), decline with a reason, defer until a time and why, or unavailable with reasons. */
export type Decision = true | string | { defer: { until: Date | string; reason: string } } | { unavailable: UnavailableReason[] };
/** A capability contract as published (a SEMA-Capabilities definition file): only the parts the wrapper checks. */
export interface Contract { capabilityKey: string; version: string; operations: Array<{ key: string; output?: { [key: string]: JsonValue }; answerShape?: { input: string; output: string } }> }

export interface ServiceWrapperOptions {
  coreUrl: string;
  /** The service's own program key and secret. The secret is used only to register the service's key with Core. */
  applicationKey: string;
  secret: string;
  /** Where the service's private key is kept; made on the first start. Or the key itself (tests). */
  keyFile?: string;
  key?: StoredKey;
  /** Which service version this is. Its installation on this machine is found from these. */
  service: { serviceKey: string; version: string };
  /** The contract it implements, to check answers before reporting them. */
  contract: Contract;
  /** The settings this service lets an organization choose, with their choices and prices (D-203): reported when it starts. */
  offers?: ServiceOffers;
  /** One handler per operation the service offers. */
  operations: Record<string, Handler>;
  /** Optional: says whether to take a piece of work. Return true to accept, or a reason to decline ("not now"). */
  accept?: (work: Work) => Promise<Decision> | Decision;
  /**
   * Whether the machine can reach what the service needs over the network, checked at every check-in (D-181). A service
   * that works offline leaves it out. A failed or thrown check counts as no network.
   */
  checkNetwork?: () => Promise<boolean>;
  /** The graphics card's free and total memory in megabytes, or null when the machine has none the service can use. Left out when it cannot tell. */
  graphics?: () => Promise<{ freeMb: number; totalMb: number } | null>;
  /** How often the wrapper says a job is still working, in seconds (default 30, D-180). */
  progressSeconds?: number;
  /** How many jobs at once (1 to 1000). */
  capacity?: number;
  /** How long Core may hold each request for work (up to 30 s; default 25). Stopping waits at most this long. */
  workWaitSeconds?: number;
  /** How long to wait between tries when Core cannot be reached or refuses. */
  retryMs?: number;
  log?: (line: string) => void;
}

type Records = { capabilities: Array<{ id: string; capabilityKey: string; version: string }>; services: Array<{ id: string; serviceKey: string; version: string; capabilityVersionId: string; legacy: boolean }>; installations: Array<{ id: string; serviceVersionId: string }> };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class ServiceWrapper {
  private stopping = false;
  private instanceId: string | undefined;
  private readonly running = new Set<Promise<void>>();
  private lastProblem = '';
  private readonly log: (line: string) => void;
  private readonly capacity: number;
  private readonly retryMs: number;

  private constructor(private readonly options: ServiceWrapperOptions, private readonly signing: CoreClientSigning) {
    this.log = options.log ?? ((line) => console.log(line));
    this.capacity = options.capacity ?? 1;
    this.retryMs = options.retryMs ?? 5000;
    if (!Number.isSafeInteger(this.capacity) || this.capacity < 1 || this.capacity > 1000) throw new Error('capacity must be a whole number from 1 to 1000');
  }

  /** Starts the service: records its instance with Core (trying again until Core accepts it) and starts asking for work. */
  static async start(options: ServiceWrapperOptions) {
    if (!options.keyFile && !options.key) throw new Error('Give keyFile, where the service keeps its private key');
    const signing = await openCoreClientSigning({ keyFile: options.keyFile ?? '', key: options.key, coreUrl: options.coreUrl, applicationKey: options.applicationKey, secret: options.secret });
    const wrapper = new ServiceWrapper(options, signing);
    wrapper.loops = Array.from({ length: wrapper.capacity }, () => wrapper.loop());
    return wrapper;
  }

  private loops: Promise<void>[] = [];
  get keyId() { return this.signing.keyId; }
  /** The instance Core recorded, once it has. */
  get instance() { return this.instanceId; }

  /** Stops taking work, lets work in hand finish, and records the instance as stopped. */
  async stop() {
    this.stopping = true;
    await Promise.all(this.loops);
    await Promise.all([...this.running]);
    if (this.instanceId) await this.call('POST', '/v1/core/services/instances/stop', { instanceId: this.instanceId }).catch(() => undefined);
  }

  private async call<T>(method: 'GET' | 'POST', path: string, body?: unknown, timeoutMs = 30_000): Promise<T> {
    const response = await this.signing.fetch(method, new URL(this.options.coreUrl.replace(/\/$/, '') + path), body === undefined ? undefined : Buffer.from(JSON.stringify(body)), body === undefined ? {} : { 'content-type': 'application/json' }, timeoutMs);
    const text = await response.text();
    if (!response.ok) {
      let message = text;
      try { message = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? text; } catch { /* plain text */ }
      throw new Error(`Core refused ${path} (${response.status}): ${message}`);
    }
    return JSON.parse(text) as T;
  }

  /** Says a problem once, until it changes or goes away, so a long outage does not fill the log. */
  private problem(message: string) { if (message !== this.lastProblem) { this.lastProblem = message; this.log(message); } }
  private cleared() { if (this.lastProblem) { this.lastProblem = ''; this.log('Core is answering again.'); } }
  /** What this machine has now (D-181): memory, disk where the service runs, processor cores, and the network and graphics card when the service can tell. */
  private async resources(): Promise<MachineReport> {
    const mb = (bytes: number) => Math.round(bytes / 1_048_576);
    let disk: MachineReport['disk'];
    try { const fs = await statfs(process.cwd()); disk = { freeMb: mb(Number(fs.bavail) * Number(fs.bsize)), totalMb: mb(Number(fs.blocks) * Number(fs.bsize)) }; } catch { disk = undefined; }
    const network = this.options.checkNetwork ? await this.options.checkNetwork().catch(() => false) : undefined;
    const graphics = this.options.graphics ? await this.options.graphics().catch(() => undefined) : undefined;
    return { memory: { freeMb: mb(freemem()), totalMb: mb(totalmem()) }, ...(disk ? { disk } : {}), processor: { cores: availableParallelism() }, ...(network !== undefined ? { network } : {}), ...(graphics !== undefined ? { graphics } : {}) };
  }

  /** Finds this service version's installation on this machine and records one instance for the whole wrapper. */
  private registering: Promise<string> | undefined;
  private ensureInstance() {
    if (this.instanceId) return Promise.resolve(this.instanceId);
    this.registering ??= (async () => {
      const { serviceKey, version } = this.options.service;
      const records = await this.call<Records>('GET', '/v1/core/capabilities/records');
      const capability = records.capabilities.find((item) => item.capabilityKey === this.options.contract.capabilityKey && item.version === this.options.contract.version);
      const service = capability && records.services.find((item) => item.serviceKey === serviceKey && item.version === version && item.capabilityVersionId === capability.id && !item.legacy);
      const installation = service && records.installations.find((item) => item.serviceVersionId === service.id);
      if (!installation) throw new Error(`${serviceKey} ${version} for ${this.options.contract.capabilityKey} ${this.options.contract.version} is not installed on this machine yet`);
      const recorded = await this.call<{ id: string }>('POST', '/v1/core/services/instances', { installationId: installation.id, capacity: this.capacity, resources: await this.resources(), ...(this.options.offers ? { offers: this.options.offers } : {}) });
      this.instanceId = recorded.id;
      this.log(`${serviceKey} ${version} is running as instance ${recorded.id}, taking up to ${this.capacity} job${this.capacity === 1 ? '' : 's'} at once.`);
      return recorded.id;
    })().finally(() => { this.registering = undefined; });
    return this.registering;
  }

  private async loop() {
    while (!this.stopping) {
      try {
        const instanceId = await this.ensureInstance();
        // Held by Core up to 25 s by default; the request itself allows longer, so a held request is not cut off.
        const { work } = await this.call<{ work: Work | null }>('POST', '/v1/core/services/instances/work', { instanceId, waitSeconds: this.options.workWaitSeconds ?? 25, resources: await this.resources() }, 45_000);
        this.cleared();
        if (!work) continue;
        const job = this.handle(instanceId, work).finally(() => this.running.delete(job));
        this.running.add(job);
        await job;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // Core no longer has this instance running (it was stopped, or recorded before Core knew its program): record a new one.
        if (/has stopped; start a new one|is not on this machine|was recorded before Core knew/.test(message)) this.instanceId = undefined;
        this.problem(`${this.options.service.serviceKey} cannot reach work yet: ${message}. It tries again.`);
        if (!this.stopping) await sleep(this.retryMs);
      }
    }
  }

  private async handle(instanceId: string, work: Work) {
    const answer = (body: Record<string, unknown>) => this.call('POST', '/v1/core/services/executions/answer', { instanceId, executionId: work.executionId, ...body });
    const handler = this.options.operations[work.operation];
    const decision: Decision = !handler ? `this service has no handler for ${work.operation}` : this.options.accept ? await this.options.accept(work) : true;
    if (typeof decision === 'string') { await answer({ answer: 'decline', reason: decision }); return; }
    if (decision !== true && 'defer' in decision) { await answer({ answer: 'defer', until: new Date(decision.defer.until).toISOString(), reason: decision.defer.reason }); return; }
    if (decision !== true) { await answer({ answer: 'unavailable', reasons: decision.unavailable }); return; }
    await answer({ answer: 'accept' });
    // While the handler runs, say every so often that the work is still going (D-180), with the latest progress given.
    let latest: { percent?: number; note?: string } = {};
    const tell = () => this.call('POST', '/v1/core/services/executions/progress', { instanceId, executionId: work.executionId, ...latest }).catch(() => undefined);
    const ticker = setInterval(() => { void tell(); }, (this.options.progressSeconds ?? 30) * 1000);
    const progress: Progress = (percent, note) => { latest = { ...(percent !== undefined ? { percent } : {}), ...(note !== undefined ? { note: note.slice(0, 200) } : {}) }; void tell(); };
    let report: Record<string, unknown>;
    try {
      const result = await handler!(work.input, work, progress).finally(() => clearInterval(ticker));
      if ('answer' in result) {
        const operation = this.options.contract.operations.find((item) => item.key === work.operation);
        const problems = operation?.output ? valueProblems(operation.output, result.answer, 'answer') : [];
        // A general capability's answer must also match the shape the caller asked for.
        if (!problems.length && operation?.answerShape) {
          const shape = (work.input as Record<string, JsonValue>)?.[operation.answerShape.input] as { [key: string]: JsonValue };
          problems.push(...valueProblems(shape, (result.answer as Record<string, JsonValue>)?.[operation.answerShape.output], `answer.${operation.answerShape.output}`));
        }
        report = problems.length
          ? { status: 'FAILED', error: `The service's answer does not match ${work.capabilityKey} ${work.version}: ${problems.join('; ')}` }
          : { status: 'SUCCESS', answer: result.answer, ...(result.outcome ? { outcome: result.outcome } : {}) };
      } else report = { status: 'SUCCESS', reference: result.reference, ...(result.outcome ? { outcome: result.outcome } : {}) };
    } catch (error) {
      report = { status: 'FAILED', error: (error instanceof Error ? error.message : String(error)).slice(0, 2000) || 'The service failed without saying why' };
    }
    try { await this.call('POST', '/v1/core/services/executions/report', { instanceId, executionId: work.executionId, ...report }); }
    catch (error) {
      // Core refused the answer (too large to carry inline, for example): report the failure so the execution does not hang.
      const message = error instanceof Error ? error.message : String(error);
      await this.call('POST', '/v1/core/services/executions/report', { instanceId, executionId: work.executionId, status: 'FAILED', error: message.slice(0, 2000) }).catch(() => undefined);
    }
  }
}
