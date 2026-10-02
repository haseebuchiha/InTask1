-- CreateTable
CREATE TABLE "incident" (
    "id" SERIAL NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ping_id" INTEGER NOT NULL,
    "severity" TEXT NOT NULL,
    "duration_ms" INTEGER NOT NULL,
    "average_duration_ms" INTEGER NOT NULL,
    "report_status" TEXT NOT NULL,
    "summary" TEXT,
    "likely_causes" JSONB,
    "recommendations" JSONB,
    "input_tokens" INTEGER NOT NULL DEFAULT 0,
    "output_tokens" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "incident_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chat_session" (
    "id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "title" TEXT,

    CONSTRAINT "chat_session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "message" (
    "id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "session_id" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "parts" JSONB NOT NULL,
    "question_hash" TEXT,
    "input_tokens" INTEGER NOT NULL DEFAULT 0,
    "output_tokens" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "message_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "incident_created_at_idx" ON "incident"("created_at");

-- CreateIndex
CREATE INDEX "chat_session_created_at_idx" ON "chat_session"("created_at");

-- CreateIndex
CREATE INDEX "message_created_at_idx" ON "message"("created_at");

-- CreateIndex
CREATE INDEX "message_question_hash_idx" ON "message"("question_hash");

-- AddForeignKey
ALTER TABLE "incident" ADD CONSTRAINT "incident_ping_id_fkey" FOREIGN KEY ("ping_id") REFERENCES "ping"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message" ADD CONSTRAINT "message_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "chat_session"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
