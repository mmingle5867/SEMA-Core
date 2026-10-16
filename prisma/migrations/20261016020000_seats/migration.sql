-- Seats on organization nodes: named users and devices, in use and allowed. Existing nodes start at zero in use and
-- no limit; a recount sets the true numbers.
ALTER TABLE "sema_local_nodes"
  ADD COLUMN "usersUsed" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "machinesUsed" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "usersAllowed" INTEGER,
  ADD COLUMN "machinesAllowed" INTEGER;
