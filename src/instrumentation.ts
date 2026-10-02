import type { Instrumentation } from "next"

export const register = async () => {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startPingTimer, stopPingTimerAndStreamsOnShutdown } = await import("@/jobs/ping")
    const { startResponseSummaryTimer, stopResponseSummaryTimerOnShutdown } = await import("@/jobs/response-summary")
    startPingTimer()
    stopPingTimerAndStreamsOnShutdown()
    startResponseSummaryTimer()
    stopResponseSummaryTimerOnShutdown()
  }
}

export const onRequestError: Instrumentation.onRequestError = async (error, request, context) => {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { logRequestError } = await import("@/config/logger")
    logRequestError(error, request, context)
  }
}
