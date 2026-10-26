import { PrismaClient } from '@prisma/client';
import type { CoreLifecycleStatus } from '../core/types.js';
import type { CommandResult, NotNow, WorkAnswer, WorkExecution, WorkStore } from './work.js';

type ExecutionRow = { id: string; commandId: string; providerId: string; status: CoreLifecycleStatus; startedAt: Date | null; completedAt: Date | null; context: { instanceId?: string; offeredAt?: string; notNow?: NotNow; deferred?: WorkExecution['deferred']; progress?: WorkExecution['progress'] } | null; error: { message?: string } | null; createdAt: Date };
const iso = (value: Date) => new Date(value).toISOString();
const toExecution = (row: ExecutionRow): WorkExecution => ({
  id: row.id, commandId: row.commandId, serviceVersionId: row.providerId, status: row.status,
  ...(row.context?.instanceId ? { instanceId: row.context.instanceId } : {}), ...(row.context?.offeredAt ? { offeredAt: row.context.offeredAt } : {}),
  ...(row.startedAt ? { startedAt: iso(row.startedAt) } : {}), ...(row.completedAt ? { completedAt: iso(row.completedAt) } : {}),
  ...(row.context?.notNow ? { notNow: row.context.notNow } : {}), ...(row.context?.deferred ? { deferred: row.context.deferred } : {}), ...(row.context?.progress ? { progress: row.context.progress } : {}),
  ...(row.error?.message ? { error: row.error.message } : {}),
  createdAt: iso(row.createdAt),
});
const EXECUTION = `"id", "commandId", "providerId", "status", "startedAt", "completedAt", "context", "error", "createdAt"`;

/**
 * PostgreSQL store for capability commands' executions and results, in Core's existing execution and result tables:
 * an execution's service version is its provider; the instance it was offered to, when, and a "not now" answer are in
 * its context. Plain SQL, like the node store. Times are UTC.
 */
export class PrismaWorkStore implements WorkStore {
  constructor(private readonly prisma: PrismaClient) {}

  async addExecution(execution: WorkExecution) {
    await this.prisma.$executeRaw`
      INSERT INTO "sema_core_executions" ("id", "commandId", "providerId", "status", "context", "createdAt")
      VALUES (${execution.id}, ${execution.commandId}, ${execution.serviceVersionId}, ${execution.status}, '{}'::jsonb, ${execution.createdAt}::timestamp)`;
  }
  async getExecution(id: string) {
    const rows = await this.prisma.$queryRawUnsafe<ExecutionRow[]>(`SELECT ${EXECUTION} FROM "sema_core_executions" WHERE "id" = $1`, id);
    return rows[0] ? toExecution(rows[0]) : undefined;
  }
  async listExecutions(commandId: string) {
    return (await this.prisma.$queryRawUnsafe<ExecutionRow[]>(`SELECT ${EXECUTION} FROM "sema_core_executions" WHERE "commandId" = $1 ORDER BY "createdAt", "id"`, commandId)).map(toExecution);
  }
  /** One statement: the row is locked while it is offered, and a row another Core process holds is skipped. */
  async claim(serviceVersionId: string, instanceId: string, now: string, staleBefore: string) {
    const rows = await this.prisma.$queryRawUnsafe<ExecutionRow[]>(`
      UPDATE "sema_core_executions" SET "status" = 'WAITING', "context" = COALESCE("context", '{}'::jsonb) || jsonb_build_object('instanceId', $2::text, 'offeredAt', $3::text)
      WHERE "id" = (
        SELECT "id" FROM "sema_core_executions"
        WHERE "providerId" = $1 AND (("status" = 'PENDING' AND COALESCE("context"->'deferred'->>'until', '') <= $3) OR ("status" = 'WAITING' AND "context"->>'offeredAt' < $4))
        ORDER BY "createdAt", "id" LIMIT 1 FOR UPDATE SKIP LOCKED)
      RETURNING ${EXECUTION}`, serviceVersionId, instanceId, now, staleBefore);
    return rows[0] ? toExecution(rows[0]) : undefined;
  }
  async change(id: string, expected: { status: CoreLifecycleStatus; instanceId: string }, change: Partial<Pick<WorkExecution, 'status' | 'startedAt' | 'completedAt' | 'notNow' | 'error' | 'deferred' | 'progress'>>) {
    // The answer, deferral and progress live in the context; each given one replaces what was there.
    const patch = { ...(change.notNow ? { notNow: change.notNow } : {}), ...(change.deferred ? { deferred: change.deferred } : {}), ...(change.progress ? { progress: change.progress } : {}) };
    const changed = await this.prisma.$executeRawUnsafe(`
      UPDATE "sema_core_executions" SET
        "status" = COALESCE($4, "status"),
        "startedAt" = COALESCE($5::timestamp, "startedAt"),
        "completedAt" = COALESCE($6::timestamp, "completedAt"),
        "context" = COALESCE("context", '{}'::jsonb) || $7::jsonb,
        "error" = COALESCE($8::jsonb, "error")
      WHERE "id" = $1 AND "status" = $2 AND "context"->>'instanceId' = $3`,
    id, expected.status, expected.instanceId, change.status ?? null, change.startedAt ?? null, change.completedAt ?? null,
    JSON.stringify(patch), change.error ? JSON.stringify({ message: change.error }) : null);
    return changed === 1;
  }
  async cancelPending(commandId: string, now: string) {
    await this.prisma.$executeRaw`UPDATE "sema_core_executions" SET "status" = 'CANCELLED', "completedAt" = ${now}::timestamp WHERE "commandId" = ${commandId} AND "status" = 'PENDING'`;
  }
  async listRunning() {
    return (await this.prisma.$queryRawUnsafe<ExecutionRow[]>(`SELECT ${EXECUTION} FROM "sema_core_executions" WHERE "status" = 'RUNNING' ORDER BY "createdAt"`)).map(toExecution);
  }
  async addAnswer(id: string, answer: WorkAnswer) {
    await this.prisma.$executeRaw`
      INSERT INTO "sema_core_results" ("id", "executionId", "resultType", "subjectIds", "data", "createdAt")
      VALUES (${id}, ${answer.executionId}, 'capability.answer', '[]'::jsonb, ${JSON.stringify(answer)}::jsonb, ${answer.recordedAt}::timestamp)`;
  }
  async getAnswer(executionId: string) {
    const rows = await this.prisma.$queryRaw<Array<{ data: WorkAnswer }>>`SELECT "data" FROM "sema_core_results" WHERE "executionId" = ${executionId} AND "resultType" = 'capability.answer' LIMIT 1`;
    return rows[0]?.data;
  }
  async recentAnswers(serviceVersionIds: string[], limit: number) {
    if (!serviceVersionIds.length) return [];
    const rows = await this.prisma.$queryRawUnsafe<Array<{ providerId: string; data: WorkAnswer }>>(
      `SELECT e."providerId", r."data" FROM "sema_core_results" r JOIN "sema_core_executions" e ON e."id" = r."executionId"
       WHERE r."resultType" = 'capability.answer' AND e."providerId" = ANY($1::text[]) ORDER BY r."createdAt" DESC LIMIT $2`, serviceVersionIds, limit);
    return rows.map((row) => ({ serviceVersionId: row.providerId, answer: row.data }));
  }
  async addResult(result: CommandResult) {
    const added = await this.prisma.$executeRaw`
      INSERT INTO "sema_core_results" ("id", "commandId", "resultType", "subjectIds", "data", "createdAt")
      VALUES (${result.id}, ${result.commandId}, 'capability.result', '[]'::jsonb, ${JSON.stringify({ entries: result.entries })}::jsonb, ${result.recordedAt}::timestamp)
      ON CONFLICT DO NOTHING`;
    return added === 1;
  }
  async getResult(commandId: string) {
    const rows = await this.prisma.$queryRaw<Array<{ id: string; data: { entries: CommandResult['entries'] }; createdAt: Date }>>`SELECT "id", "data", "createdAt" FROM "sema_core_results" WHERE "commandId" = ${commandId} AND "resultType" = 'capability.result' LIMIT 1`;
    return rows[0] ? { id: rows[0].id, commandId, entries: rows[0].data.entries, recordedAt: iso(rows[0].createdAt) } : undefined;
  }
}
