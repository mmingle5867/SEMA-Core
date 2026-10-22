-- The capability and service layer's four records (D-151): capability versions, service versions, installations on
-- this machine, and running instances. A published version never changes. Times are UTC.
CREATE TABLE "sema_core_capability_versions" (
  "id" TEXT NOT NULL,
  "capabilityKey" TEXT NOT NULL,
  "version" TEXT NOT NULL,
  "displayName" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "operations" JSONB NOT NULL DEFAULT '[]',
  "approved" BOOLEAN NOT NULL DEFAULT false,
  "legacy" BOOLEAN NOT NULL DEFAULT false,
  "status" TEXT NOT NULL DEFAULT 'ACTIVE',
  "createdAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "sema_core_capability_versions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "sema_core_capability_versions_capabilityKey_version_key" ON "sema_core_capability_versions"("capabilityKey", "version");

CREATE TABLE "sema_core_service_versions" (
  "id" TEXT NOT NULL,
  "serviceKey" TEXT NOT NULL,
  "version" TEXT NOT NULL,
  "capabilityVersionId" TEXT NOT NULL,
  "displayName" TEXT NOT NULL,
  "operations" JSONB NOT NULL DEFAULT '[]',
  "extensions" JSONB NOT NULL DEFAULT '[]',
  "declarations" JSONB NOT NULL DEFAULT '{}',
  "legacy" BOOLEAN NOT NULL DEFAULT false,
  "status" TEXT NOT NULL DEFAULT 'ACTIVE',
  "createdAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "sema_core_service_versions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "sema_core_service_versions_serviceKey_version_capabilityVersionId_key" ON "sema_core_service_versions"("serviceKey", "version", "capabilityVersionId");
CREATE INDEX "sema_core_service_versions_capabilityVersionId_idx" ON "sema_core_service_versions"("capabilityVersionId");

CREATE TABLE "sema_core_service_installations" (
  "id" TEXT NOT NULL,
  "serviceVersionId" TEXT NOT NULL,
  "machineNodeId" TEXT NOT NULL,
  "settingsRef" TEXT,
  "endpointUrl" TEXT,
  "installedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "sema_core_service_installations_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "sema_core_service_installations_serviceVersionId_key" ON "sema_core_service_installations"("serviceVersionId");

CREATE TABLE "sema_core_service_instances" (
  "id" TEXT NOT NULL,
  "installationId" TEXT NOT NULL,
  "startedAt" TIMESTAMP(3) NOT NULL,
  "lastCheckInAt" TIMESTAMP(3) NOT NULL,
  "capacity" INTEGER NOT NULL DEFAULT 1,
  "resources" JSONB NOT NULL DEFAULT '{}',
  "state" TEXT NOT NULL DEFAULT 'RUNNING',
  CONSTRAINT "sema_core_service_instances_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "sema_core_service_instances_installationId_idx" ON "sema_core_service_instances"("installationId");
