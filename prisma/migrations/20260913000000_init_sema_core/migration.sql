-- SEMA Core v0.1.0 PostgreSQL contract.
-- An adapter must reserve IDs in one database transaction and must never reuse
-- either RESERVED or ISSUED LocalIDs.

CREATE TABLE "sema_core_identity_state" (
  "stateKey" TEXT PRIMARY KEY,
  "installationId" TEXT NOT NULL UNIQUE,
  "nextLocalId" BIGINT NOT NULL DEFAULT 1,
  "status" TEXT NOT NULL DEFAULT 'ACTIVE',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);

CREATE TABLE "sema_identifier_reservations" (
  "id" TEXT PRIMARY KEY,
  "installationId" TEXT NOT NULL,
  "firstLocalValue" BIGINT NOT NULL,
  "count" INTEGER NOT NULL CHECK ("count" > 0),
  "typeCode" TEXT,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "sema_identifier_reservations_installationId_firstLocalValue_idx"
  ON "sema_identifier_reservations"("installationId", "firstLocalValue");

CREATE TABLE "sema_issued_identifiers" (
  "semaId" TEXT PRIMARY KEY,
  "reservationId" TEXT NOT NULL,
  "installationId" TEXT NOT NULL,
  "localValue" BIGINT NOT NULL,
  "localCode" TEXT NOT NULL,
  "typeCode" TEXT,
  "status" TEXT NOT NULL DEFAULT 'RESERVED',
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "consumedAt" TIMESTAMP(3),
  CONSTRAINT "sema_issued_identifiers_installationId_localValue_key" UNIQUE ("installationId", "localValue")
);
CREATE INDEX "sema_issued_identifiers_reservationId_status_idx" ON "sema_issued_identifiers"("reservationId", "status");
CREATE INDEX "sema_issued_identifiers_typeCode_idx" ON "sema_issued_identifiers"("typeCode");

CREATE TABLE "sema_core_commands" (
  "id" TEXT PRIMARY KEY, "commandType" TEXT NOT NULL, "actorId" TEXT, "workspaceId" TEXT,
  "subjectIds" JSONB NOT NULL DEFAULT '[]', "context" JSONB NOT NULL DEFAULT '{}',
  "payload" JSONB NOT NULL DEFAULT '{}', "status" TEXT NOT NULL DEFAULT 'PENDING',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE "sema_core_executions" (
  "id" TEXT PRIMARY KEY, "commandId" TEXT NOT NULL, "providerId" TEXT,
  "status" TEXT NOT NULL DEFAULT 'PENDING', "startedAt" TIMESTAMP(3), "completedAt" TIMESTAMP(3),
  "context" JSONB NOT NULL DEFAULT '{}', "error" JSONB, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE "sema_core_results" (
  "id" TEXT PRIMARY KEY, "executionId" TEXT NOT NULL, "resultType" TEXT NOT NULL,
  "subjectIds" JSONB NOT NULL DEFAULT '[]', "data" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE "sema_core_events" (
  "id" TEXT PRIMARY KEY, "eventType" TEXT NOT NULL, "commandId" TEXT, "executionId" TEXT,
  "subjectIds" JSONB NOT NULL DEFAULT '[]', "data" JSONB NOT NULL DEFAULT '{}',
  "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE "sema_core_audit_entries" (
  "id" TEXT PRIMARY KEY, "action" TEXT NOT NULL, "actorId" TEXT, "commandId" TEXT, "executionId" TEXT,
  "subjectIds" JSONB NOT NULL DEFAULT '[]', "evidence" JSONB NOT NULL DEFAULT '{}',
  "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE "sema_core_capabilities" (
  "id" TEXT PRIMARY KEY, "capabilityKey" TEXT NOT NULL UNIQUE, "displayName" TEXT NOT NULL,
  "description" TEXT NOT NULL, "providerKey" TEXT NOT NULL, "version" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'ACTIVE', "metadata" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL
);

CREATE INDEX "sema_core_commands_commandType_createdAt_idx" ON "sema_core_commands"("commandType", "createdAt");
CREATE INDEX "sema_core_executions_commandId_createdAt_idx" ON "sema_core_executions"("commandId", "createdAt");
CREATE INDEX "sema_core_results_executionId_createdAt_idx" ON "sema_core_results"("executionId", "createdAt");
CREATE INDEX "sema_core_events_eventType_occurredAt_idx" ON "sema_core_events"("eventType", "occurredAt");
CREATE INDEX "sema_core_audit_entries_action_occurredAt_idx" ON "sema_core_audit_entries"("action", "occurredAt");
CREATE INDEX "sema_core_capabilities_status_displayName_idx" ON "sema_core_capabilities"("status", "displayName");
