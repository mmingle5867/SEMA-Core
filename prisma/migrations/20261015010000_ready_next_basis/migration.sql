-- A basis fetched early from an ancestor, ready to take over when the counter would pass switchAt.
ALTER TABLE "sema_local_nodes" ADD COLUMN "nextBasis" TEXT;
ALTER TABLE "sema_local_nodes" ADD COLUMN "switchAt" BIGINT;
