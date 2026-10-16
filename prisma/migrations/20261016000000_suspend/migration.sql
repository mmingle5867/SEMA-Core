-- Suspending a node: the node's own record says it is shut down (itself, or because an ancestor is), and its
-- parent's entry for it carries the mark every other Core sees. All columns may be empty: nothing is shut down.
ALTER TABLE "sema_local_nodes"
  ADD COLUMN "shutdownNodeId" TEXT,
  ADD COLUMN "shutdownReason" TEXT,
  ADD COLUMN "shutdownBy" TEXT,
  ADD COLUMN "shutdownAt" TIMESTAMP(3),
  ADD COLUMN "shutdownVia" TEXT;

ALTER TABLE "sema_local_node_children"
  ADD COLUMN "suspendedReason" TEXT,
  ADD COLUMN "suspendedBy" TEXT,
  ADD COLUMN "suspendedAt" TIMESTAMP(3);
