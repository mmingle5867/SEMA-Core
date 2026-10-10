-- Indexes declared in schema.prisma that the initial migration did not create.
-- Additive and idempotent: the applied initial migration is left unchanged.

CREATE INDEX IF NOT EXISTS "sema_core_commands_actorId_createdAt_idx" ON "sema_core_commands"("actorId", "createdAt");
CREATE INDEX IF NOT EXISTS "sema_core_executions_status_createdAt_idx" ON "sema_core_executions"("status", "createdAt");
CREATE INDEX IF NOT EXISTS "sema_core_events_commandId_occurredAt_idx" ON "sema_core_events"("commandId", "occurredAt");
CREATE INDEX IF NOT EXISTS "sema_core_audit_entries_actorId_occurredAt_idx" ON "sema_core_audit_entries"("actorId", "occurredAt");
