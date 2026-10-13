-- The counter that assigns the first ID of each new system (3 up to zzzzz are reserved).
-- One row, created the first time an install code is issued. Additive: no existing table is changed.
CREATE TABLE IF NOT EXISTS "sema_top_level_counter" (
  "counterKey" TEXT NOT NULL,
  "issued" BIGINT NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "sema_top_level_counter_pkey" PRIMARY KEY ("counterKey")
);
