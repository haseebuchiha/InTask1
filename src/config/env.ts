import "server-only"
import * as zod from "zod"

const readEnvironment = () => {
  const environmentCheck = environmentSchema.safeParse(process.env)
  if (environmentCheck.success) return environmentCheck.data
  throw new Error(`Invalid environment variables:\n${zod.prettifyError(environmentCheck.error)}`)
}

const environmentSchema = zod.object({
  DATABASE_URL: zod.url({
    error: "DATABASE_URL must be set to a valid URL, like postgresql://USER:PASSWORD@localhost:5432/DATABASE",
  }),
  LOG_LEVEL: zod.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  PING_INTERVAL_MS: zod.coerce.number().int().positive().default(300_000),
  LLM_BASE_URL: zod
    .url({ error: "LLM_BASE_URL must be a valid URL, like http://localhost:10531/v1" })
    .default("http://localhost:10531/v1"),
  LLM_API_KEY: zod.string().min(1).default("not-needed"),
  LLM_MODEL: zod.string().min(1).default("gpt-5.5"),
  LLM_CALLS_PER_HOUR: zod.coerce.number().int().positive().default(20),
  AI_GATEWAY_API_KEY: zod.string().trim().default(""),
})

const environment = readEnvironment()

export const DATABASE_URL = environment.DATABASE_URL

export const LOG_LEVEL = environment.LOG_LEVEL

export const PING_INTERVAL_MS = environment.PING_INTERVAL_MS

export const LLM_BASE_URL = environment.LLM_BASE_URL

export const LLM_API_KEY = environment.LLM_API_KEY

export const LLM_MODEL = environment.LLM_MODEL

export const LLM_CALLS_PER_HOUR = environment.LLM_CALLS_PER_HOUR

export const AI_GATEWAY_API_KEY = environment.AI_GATEWAY_API_KEY
