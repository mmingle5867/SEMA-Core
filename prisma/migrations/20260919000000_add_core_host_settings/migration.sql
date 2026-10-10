CREATE TABLE "sema_core_host_settings" (
  "installationId" TEXT NOT NULL,
  "revision" INTEGER NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "updatedById" TEXT,
  "values" JSONB NOT NULL DEFAULT '{}',
  CONSTRAINT "sema_core_host_settings_pkey" PRIMARY KEY ("installationId")
);
