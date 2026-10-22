-- Commands to a capability (phase 2, D-160 to D-167).
-- The ways of choosing a capability permits (D-162); empty for records moved from the old ones.
ALTER TABLE "sema_core_capability_versions" ADD COLUMN "choosing" JSONB NOT NULL DEFAULT '[]';
-- The program that started an instance; it can never issue a capability command (D-160).
ALTER TABLE "sema_core_service_instances" ADD COLUMN "applicationKey" TEXT;
CREATE INDEX "sema_core_service_instances_applicationKey_idx" ON "sema_core_service_instances"("applicationKey");
-- A command's one result belongs to the command, not to one execution.
ALTER TABLE "sema_core_results" ALTER COLUMN "executionId" DROP NOT NULL;
ALTER TABLE "sema_core_results" ADD COLUMN "commandId" TEXT;
CREATE UNIQUE INDEX "sema_core_results_one_per_command" ON "sema_core_results"("commandId") WHERE "resultType" = 'capability.result';
-- Instances find their waiting work by service version and state.
CREATE INDEX "sema_core_executions_providerId_status_idx" ON "sema_core_executions"("providerId", "status");
