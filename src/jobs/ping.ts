import "server-only"
import { PING_INTERVAL_MS } from "@/config/env"
import { logger } from "@/config/logger"
import type { Incident, Ping } from "@/db/generated/client"
import { reportIncidentForPing } from "@/services/incidents"
import { shutDownPingStreams } from "@/services/live-updates"
import { recordPing } from "@/services/ping"

export const startPingTimer = () => {
  clearInterval(timerGlobals.pingTimer)
  timerGlobals.pingTimer = setInterval(runPingJob, PING_INTERVAL_MS)
  logger.info({ intervalMs: PING_INTERVAL_MS }, "Ping timer started")
}

const runPingJob = async () => {
  try {
    await recordAndReportPing()
  } catch (error) {
    logger.error({ err: error }, "Ping job failed, trying again at the next tick")
  }
}

const recordAndReportPing = async () => {
  const ping = await recordPing()
  logPing(ping)
  await reportIncidentWithoutFailingPing(ping)
}

const logPing = (ping: Ping) => {
  const summary = { pingId: ping.id, statusCode: ping.statusCode, durationMs: ping.durationMs }
  if (ping.error !== null) return logger.warn({ ...summary, error: ping.error }, "Ping failed")
  logger.info(summary, "Ping succeeded")
}

const reportIncidentWithoutFailingPing = async (ping: Ping) => {
  try {
    logIncident(await reportIncidentForPing(ping))
  } catch (error) {
    logger.error({ err: error, pingId: ping.id }, "Ping was saved but its incident check failed")
  }
}

const logIncident = (incident: Incident | null) => {
  if (incident === null) return
  const { id: incidentId, pingId, severity, reportStatus } = incident
  logger.warn({ incidentId, pingId, severity, reportStatus }, "Incident recorded")
}

export const stopPingTimerAndStreamsOnShutdown = () => {
  process.once("SIGTERM", stopPingTimerAndStreams)
  process.once("SIGINT", stopPingTimerAndStreams)
}

const stopPingTimerAndStreams = () => {
  clearInterval(timerGlobals.pingTimer)
  shutDownPingStreams()
  logger.info("Ping timer stopped and live streams closed for shutdown")
}

const timerGlobals = globalThis as unknown as { pingTimer?: NodeJS.Timeout }
