-- Which tree a node sits in: PEOPLE (the organization tree) or ASSET (the physical or network tree).
-- Set once when the node is recorded and never changed.
-- Every node that exists before this change is a machine's own node, so existing rows become ASSET.
-- The default is then removed: from here on a node cannot be recorded without naming its kind.
ALTER TABLE "sema_local_nodes" ADD COLUMN IF NOT EXISTS "kind" TEXT NOT NULL DEFAULT 'ASSET';
ALTER TABLE "sema_local_nodes" ALTER COLUMN "kind" DROP DEFAULT;
