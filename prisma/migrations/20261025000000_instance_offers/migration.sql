-- The settings a running copy offers the organization, reported when it starts (D-203).
ALTER TABLE "sema_core_service_instances" ADD COLUMN "offers" JSONB NOT NULL DEFAULT '{}';
