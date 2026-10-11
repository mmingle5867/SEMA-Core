-- Where to reach the parent's Core, kept beside the parent pointer. Additive and safe to repeat.
ALTER TABLE "sema_local_nodes" ADD COLUMN IF NOT EXISTS "parentAddress" TEXT;
