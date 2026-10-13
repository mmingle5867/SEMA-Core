-- First IDs are assigned from blocks, so more than one Core can assign them without ever giving the same
-- value twice, and losing one Core loses only the unused part of its own block.
-- A row that exists already belongs to the original system and is block 0 (values up to 999,999).
ALTER TABLE "sema_top_level_counter" ADD COLUMN IF NOT EXISTS "block" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "sema_top_level_counter" ADD COLUMN IF NOT EXISTS "blockEnd" BIGINT NOT NULL DEFAULT 1000000;
ALTER TABLE "sema_top_level_counter" ALTER COLUMN "block" DROP DEFAULT;
ALTER TABLE "sema_top_level_counter" ALTER COLUMN "blockEnd" DROP DEFAULT;
