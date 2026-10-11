-- Node topology: one parent pointer per node, one counter per basis, one holder per issued value.
-- Additive: no existing table is changed.

CREATE TABLE "sema_topology_nodes" (
  "id" TEXT NOT NULL,
  "parentId" TEXT,
  "basis" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'ACTIVE',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "sema_topology_nodes_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "sema_topology_nodes_parentId_idx" ON "sema_topology_nodes"("parentId");

CREATE TABLE "sema_topology_counters" (
  "basis" TEXT NOT NULL,
  "lastValue" BIGINT NOT NULL DEFAULT 0,
  CONSTRAINT "sema_topology_counters_pkey" PRIMARY KEY ("basis")
);

CREATE TABLE "sema_topology_holders" (
  "value" TEXT NOT NULL,
  "holderId" TEXT NOT NULL,
  "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "sema_topology_holders_pkey" PRIMARY KEY ("value")
);
CREATE INDEX "sema_topology_holders_holderId_idx" ON "sema_topology_holders"("holderId");
