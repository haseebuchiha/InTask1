import "server-only"
import type { Instrumentation } from "next"
import { pino } from "pino"
import { LOG_LEVEL } from "@/config/env"

export const logRequestError: Instrumentation.onRequestError = (error, request, context) =>
  logger.error({ err: error, method: request.method, path: request.path, context }, "Uncaught server error")

export const logger = pino({ level: LOG_LEVEL })
