-- AlterTable
ALTER TABLE "ping" ADD COLUMN     "origin" TEXT,
ADD COLUMN     "response_kind" TEXT;

-- Backfill
UPDATE "ping"
SET
    "response_kind" = CASE
        WHEN "status_code" IS NULL THEN 'failed'
        WHEN "status_code" >= 500 THEN 'gateway_error'
        WHEN "status_code" >= 400 THEN 'client_error'
        WHEN "response" IS NULL OR jsonb_typeof("response") = 'null' THEN 'empty'
        WHEN "response" -> 'json' = "payload" THEN 'clean_echo'
        ELSE 'echo_mismatch'
    END,
    "origin" = CASE
        WHEN jsonb_typeof("response" -> 'origin') = 'string' THEN "response" ->> 'origin'
    END;

-- AlterTable
ALTER TABLE "ping" ALTER COLUMN "response_kind" SET NOT NULL;

-- CreateTable
CREATE TABLE "response_summary" (
    "id" SERIAL NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "day" DATE NOT NULL,
    "covers_until" TIMESTAMPTZ NOT NULL,
    "status" TEXT NOT NULL,
    "summary" TEXT,
    "findings" JSONB,
    "statistics" JSONB NOT NULL,
    "input_tokens" INTEGER NOT NULL DEFAULT 0,
    "output_tokens" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "response_summary_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "response_summary_day_key" ON "response_summary"("day");

-- CreateIndex
CREATE INDEX "response_summary_created_at_idx" ON "response_summary"("created_at");
