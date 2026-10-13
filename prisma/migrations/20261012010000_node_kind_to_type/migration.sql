-- A node's kind (PEOPLE or ASSET) becomes its type: ORGANIZATION, GROUP, USER or MACHINE.
-- Core needs the finer type to count seats and to find the organization a node belongs to.
-- The kind existed for less than a day. Every node recorded with one is a machine's own node (ASSET),
-- which becomes MACHINE. No PEOPLE node was ever created; any that exists becomes USER.
ALTER TABLE "sema_local_nodes" RENAME COLUMN "kind" TO "type";
UPDATE "sema_local_nodes" SET "type" = CASE WHEN "type" = 'PEOPLE' THEN 'USER' ELSE 'MACHINE' END WHERE "type" IN ('PEOPLE', 'ASSET');
