-- Retiring a user or machine that cannot be reached: its parent keeps the entry, marked retired, as the record that
-- refuses it if it comes back. All columns may be empty: nothing is retired that way.
ALTER TABLE "sema_local_node_children"
  ADD COLUMN "retiredReason" TEXT,
  ADD COLUMN "retiredBy" TEXT,
  ADD COLUMN "retiredAt" TIMESTAMP(3);
