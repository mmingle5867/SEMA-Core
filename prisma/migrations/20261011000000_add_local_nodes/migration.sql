-- Nodes held by this Core: its own machine node and the user nodes placed on this machine.
-- Additive: no existing table is changed.

CREATE TABLE "sema_local_nodes" (
  "id" TEXT NOT NULL,
  "parentId" TEXT,
  "basis" TEXT NOT NULL,
  "issued" BIGINT NOT NULL DEFAULT 0,
  "childCount" INTEGER NOT NULL DEFAULT 0,
  "status" TEXT NOT NULL DEFAULT 'ACTIVE',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "sema_local_nodes_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "sema_local_nodes_parentId_idx" ON "sema_local_nodes"("parentId");
