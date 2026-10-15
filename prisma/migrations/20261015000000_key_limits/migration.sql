-- Optional key limits an organization sets on the IDs issued inside it. Null means no limit.
ALTER TABLE "sema_local_nodes" ADD COLUMN "maxSegments" INTEGER;
ALTER TABLE "sema_local_nodes" ADD COLUMN "maxSegmentLength" INTEGER;
ALTER TABLE "sema_local_nodes" ADD COLUMN "maxLastSegmentLength" INTEGER;
