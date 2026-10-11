-- The machine's own node becomes the source of its ID prefix and counter. Seeded from the existing
-- identity state, so the prefix and the next number are exactly what they were. Safe to repeat.
INSERT INTO "sema_local_nodes" ("id", "parentId", "parentAddress", "basis", "issued", "childCount", "status", "createdAt", "updatedAt")
SELECT s."installationId", NULL, NULL, s."installationId", s."nextLocalId" - 1, 0, 'ACTIVE', NOW(), NOW()
FROM "sema_core_identity_state" s
WHERE s."stateKey" = 'PRIMARY'
ON CONFLICT ("id") DO NOTHING;
