-- Each node keeps a list of its direct children, which replaces the child count.
-- The child's own pointer stays the truth. A list may hold too many entries, never too few.
-- lastSeenAt is for check-ins, which are not built yet.
CREATE TABLE IF NOT EXISTS "sema_local_node_children" (
  "parentId" TEXT NOT NULL,
  "childId" TEXT NOT NULL,
  "childType" TEXT NOT NULL,
  "childAddress" TEXT,
  "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSeenAt" TIMESTAMP(3),
  CONSTRAINT "sema_local_node_children_pkey" PRIMARY KEY ("parentId", "childId"),
  CONSTRAINT "sema_local_node_children_parent_fkey" FOREIGN KEY ("parentId") REFERENCES "sema_local_nodes"("id")
);

-- A node that had children cannot have them listed here, because nobody knew who they were. Such a node is
-- marked as having a list that may be incomplete, and is never treated as childless until an administrator says
-- its list is complete. A node with none is complete.
ALTER TABLE "sema_local_nodes" ADD COLUMN IF NOT EXISTS "childListComplete" BOOLEAN NOT NULL DEFAULT true;
UPDATE "sema_local_nodes" SET "childListComplete" = false WHERE "childCount" > 0;
ALTER TABLE "sema_local_nodes" DROP COLUMN "childCount";
