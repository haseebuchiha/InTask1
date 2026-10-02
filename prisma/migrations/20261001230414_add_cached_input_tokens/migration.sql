-- AlterTable
ALTER TABLE "incident" ADD COLUMN     "cached_input_tokens" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "message" ADD COLUMN     "cached_input_tokens" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "response_summary" ADD COLUMN     "cached_input_tokens" INTEGER NOT NULL DEFAULT 0;
