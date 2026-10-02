import "server-only"
import { logger } from "@/config/logger"
import type { ResponseSummary } from "@/db/generated/client"
import { summarizePreviousDayIfMissing } from "@/services/response-analysis"

const CHECK_INTERVAL_MS = 5 * 60 * 1000

export const startResponseSummaryTimer = () => {
  clearInterval(timerGlobals.responseSummaryTimer)
  timerGlobals.responseSummaryTimer = setInterval(runResponseSummaryJob, CHECK_INTERVAL_MS)
  logger.info({ intervalMs: CHECK_INTERVAL_MS }, "Response summary timer started")
}

const runResponseSummaryJob = async () => {
  try {
    logSummary(await summarizePreviousDayIfMissing())
  } catch (error) {
    logger.error({ err: error }, "Response summary job failed, trying again at the next check")
  }
}

const logSummary = (summary: ResponseSummary | null) => {
  if (summary === null) return
  const { id: responseSummaryId, status, inputTokens, cachedInputTokens, outputTokens } = summary
  const day = summary.day.toISOString().slice(0, 10)
  const details = { responseSummaryId, day, status, inputTokens, cachedInputTokens, outputTokens }
  if (status === "written") return logger.info(details, "Response summary written")
  logger.warn(details, "Response summary not written")
}

export const stopResponseSummaryTimerOnShutdown = () => {
  process.once("SIGTERM", stopResponseSummaryTimer)
  process.once("SIGINT", stopResponseSummaryTimer)
}

const stopResponseSummaryTimer = () => {
  clearInterval(timerGlobals.responseSummaryTimer)
  logger.info("Response summary timer stopped for shutdown")
}

const timerGlobals = globalThis as unknown as { responseSummaryTimer?: NodeJS.Timeout }
