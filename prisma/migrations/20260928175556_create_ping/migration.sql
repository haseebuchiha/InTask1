-- CreateTable
CREATE TABLE "ping" (
    "id" SERIAL NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "payload" JSONB NOT NULL,
    "status_code" INTEGER,
    "duration_ms" INTEGER NOT NULL,
    "response" JSONB,
    "error" TEXT,

    CONSTRAINT "ping_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ping_created_at_idx" ON "ping"("created_at");
