import { randomInt, randomUUID } from "node:crypto"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { logger } from "@/config/logger"
import { database } from "@/db/client"
import type { Ping, Prisma } from "@/db/generated/client"
import { reportIncidentForPing } from "@/services/incidents"
import { broadcastIncident } from "@/services/live-updates"
import { generateStructured, hasLlmBudget } from "@/services/llm"
import { deleteIncidentsByPingPayload, deletePingsByPayload } from "../support/database"

vi.mock("@/services/llm", () => ({ generateStructured: vi.fn(), hasLlmBudget: vi.fn() }))
vi.mock("@/services/live-updates", { spy: true })

const MILLISECONDS_PER_MINUTE = 60_000

const MILLISECONDS_PER_DAY = 24 * 60 * MILLISECONDS_PER_MINUTE

const NO_REPLY_FIELDS = { statusCode: null, responseKind: "failed" }

const WRITTEN_REPORT = {
  summary: "The ping took two and a half times as long as usual.",
  likelyCauses: ["httpbin was slow to answer", "The network path was congested"],
  recommendations: ["Watch the next few pings", "Check httpbin's status page"],
}

type SeededPing = { durationMs: number; payload?: Prisma.InputJsonObject; response?: Prisma.InputJsonObject }

const baseTime = new Date(Date.UTC(3000, 0, 2) + randomInt(0, 36_000) * MILLISECONDS_PER_DAY)

const runMarker = { seeded: true, suite: "tests/services/incidents", runId: randomUUID() }

const minuteOf = (minute: number) => new Date(baseTime.getTime() + minute * MILLISECONDS_PER_MINUTE)

const answeredFields = (minute: number) => ({
  statusCode: 200,
  response: { echoed: minute },
  responseKind: "echo_mismatch",
})

const baselineRow = (minute: number, durationMs: number, error: string | null) => ({
  createdAt: minuteOf(minute),
  payload: { ...runMarker, minute },
  durationMs,
  error,
  ...(error === null ? answeredFields(minute) : NO_REPLY_FIELDS),
})

const seedBaseline = (count: number, durationMs = 100, error: string | null = null) =>
  database.ping.createMany({
    data: Array.from({ length: count }, (_, minute) => baselineRow(minute, durationMs, error)),
  })

const seedPing = ({ durationMs, payload = {}, response = { echoed: 60 } }: SeededPing) =>
  database.ping.create({
    data: {
      createdAt: minuteOf(60),
      payload: { ...runMarker, minute: 60, ...payload },
      statusCode: 200,
      durationMs,
      response,
      responseKind: "echo_mismatch",
    },
  })

const seedFailedPing = (durationMs: number, error: string) =>
  database.ping.create({
    data: { createdAt: minuteOf(60), payload: { ...runMarker, minute: 60 }, durationMs, error, responseKind: "failed" },
  })

const answerWithReport = () =>
  vi.mocked(generateStructured).mockResolvedValue({
    output: WRITTEN_REPORT,
    usage: { inputTokens: 812, cachedInputTokens: 300, outputTokens: 96 },
  })

const findStoredIncident = (id: number) => database.incident.findUnique({ where: { id } })

const countIncidentsFor = (ping: Ping) => database.incident.count({ where: { pingId: ping.id } })

const readModelRequest = () => vi.mocked(generateStructured).mock.calls[0][0]

const readPromptLine = (prompt: string, label: string) => prompt.split("\n").find((line) => line.startsWith(label))

beforeEach(() => {
  vi.mocked(hasLlmBudget).mockResolvedValue(true)
  answerWithReport()
})

afterEach(async () => {
  await deleteIncidentsByPingPayload("runId", [runMarker.runId])
  await deletePingsByPayload("runId", [runMarker.runId])
})

describe("reportIncidentForPing: deciding", () => {
  test("returns null and saves nothing when fewer than 12 successful pings came in the 24 hours before", async () => {
    await seedBaseline(11)
    const ping = await seedPing({ durationMs: 1000 })

    expect(await reportIncidentForPing(ping)).toBeNull()
    expect(await countIncidentsFor(ping)).toBe(0)
    expect(hasLlmBudget).not.toHaveBeenCalled()
    expect(generateStructured).not.toHaveBeenCalled()
    expect(broadcastIncident).not.toHaveBeenCalled()
  })

  test("doesn't count failed pings toward the 12", async () => {
    await seedBaseline(11)
    await database.ping.create({ data: baselineRow(30, 100, "Seeded failure") })
    const ping = await seedPing({ durationMs: 1000 })

    expect(await reportIncidentForPing(ping)).toBeNull()
  })

  test("doesn't count pings from more than 24 hours before", async () => {
    await seedBaseline(11)
    await database.ping.create({
      data: { ...baselineRow(30, 100, null), createdAt: new Date(minuteOf(60).getTime() - MILLISECONDS_PER_DAY - 1) },
    })
    const ping = await seedPing({ durationMs: 1000 })

    expect(await reportIncidentForPing(ping)).toBeNull()
  })

  test("returns null for a failed ping too when the baseline is too small", async () => {
    await seedBaseline(5)
    const ping = await seedFailedPing(30_000, "Request to httpbin failed: fetch failed")

    expect(await reportIncidentForPing(ping)).toBeNull()
    expect(await countIncidentsFor(ping)).toBe(0)
  })

  test("returns null for a ping just under twice the average", async () => {
    await seedBaseline(12)
    const ping = await seedPing({ durationMs: 199 })

    expect(await reportIncidentForPing(ping)).toBeNull()
    expect(await countIncidentsFor(ping)).toBe(0)
    expect(generateStructured).not.toHaveBeenCalled()
  })

  test.each([
    { durationMs: 200, severity: "warning" },
    { durationMs: 499, severity: "warning" },
    { durationMs: 500, severity: "critical" },
    { durationMs: 5000, severity: "critical" },
  ])("a $durationMs ms ping against a 100 ms average is a $severity incident", async ({ durationMs, severity }) => {
    await seedBaseline(12)
    const ping = await seedPing({ durationMs })

    const incident = await reportIncidentForPing(ping)

    expect(incident).toMatchObject({ pingId: ping.id, severity, durationMs, averageDurationMs: 100 })
  })

  test("a failed ping is critical even when it was fast", async () => {
    await seedBaseline(12)
    const ping = await seedFailedPing(120, "Request to httpbin failed: fetch failed")

    const incident = await reportIncidentForPing(ping)

    expect(incident).toMatchObject({
      pingId: ping.id,
      severity: "critical",
      durationMs: 120,
      averageDurationMs: 100,
      reportStatus: "written",
    })
  })

  test("rounds the average it saves", async () => {
    await database.ping.createMany({
      data: Array.from({ length: 12 }, (_, minute) => baselineRow(minute, minute < 7 ? 101 : 100, null)),
    })
    const ping = await seedPing({ durationMs: 300 })

    const incident = await reportIncidentForPing(ping)

    expect(incident).toMatchObject({ averageDurationMs: 101 })
  })
})

describe("reportIncidentForPing: the report", () => {
  test("saves the written report with its token counts, cached ones included, on a warning", async () => {
    await seedBaseline(12)
    const ping = await seedPing({ durationMs: 250 })

    const incident = await reportIncidentForPing(ping)

    expect(incident).toMatchObject({
      pingId: ping.id,
      severity: "warning",
      durationMs: 250,
      averageDurationMs: 100,
      reportStatus: "written",
      ...WRITTEN_REPORT,
      inputTokens: 812,
      cachedInputTokens: 300,
      outputTokens: 96,
    })
    expect(await findStoredIncident(incident!.id)).toStrictEqual(incident)
    expect(generateStructured).toHaveBeenCalledOnce()
    expect(readModelRequest().promptCacheKey).toBe("ping-monitor-incident")
  })

  test("saves the incident as pending before asking the model", async () => {
    await seedBaseline(12)
    const ping = await seedPing({ durationMs: 250 })
    const incidentsWhileAsking: unknown[] = []
    vi.mocked(generateStructured).mockImplementation(async () => {
      incidentsWhileAsking.push(await database.incident.findFirst({ where: { pingId: ping.id } }))
      return { output: WRITTEN_REPORT, usage: { inputTokens: 812, cachedInputTokens: 300, outputTokens: 96 } }
    })

    await reportIncidentForPing(ping)

    expect(incidentsWhileAsking).toStrictEqual([
      expect.objectContaining({
        reportStatus: "pending",
        severity: "warning",
        durationMs: 250,
        averageDurationMs: 100,
        summary: null,
        inputTokens: 0,
      }),
    ])
  })

  test("gives the model the endpoint, the ping, the average, the multiple and the recent durations", async () => {
    await seedBaseline(12)
    const ping = await seedPing({ durationMs: 250 })

    await reportIncidentForPing(ping)
    const { prompt, instructions } = readModelRequest()

    expect(prompt.split("\n").slice(0, 8)).toStrictEqual([
      "Endpoint: POST https://httpbin.org/anything",
      `Ping time: ${minuteOf(60).toISOString()}`,
      "Duration: 250 ms",
      "Status code: 200",
      "Error: none",
      "Severity, set by the monitor: warning",
      "Average duration of successful pings in the 24 hours before this one: 100 ms",
      "This ping took 2.5 times that average",
    ])
    expect(readPromptLine(prompt, "Durations of the 12 most recent pings")).toMatch(
      /^Durations of the 12 most recent pings, newest first: (\d+ ms( \(failed\))?, ){11}\d+ ms( \(failed\))?$/,
    )
    expect(instructions).toContain("Your only job is to explain it.")
  })

  test("describes a failed ping's missing status and its error", async () => {
    await seedBaseline(12)
    const ping = await seedFailedPing(30_000, "Request to httpbin failed: The operation was aborted due to timeout")

    await reportIncidentForPing(ping)
    const { prompt } = readModelRequest()

    expect(readPromptLine(prompt, "Status code:")).toBe("Status code: none, no reply arrived")
    expect(readPromptLine(prompt, "Error:")).toBe(
      "Error: Request to httpbin failed: The operation was aborted due to timeout",
    )
    expect(readPromptLine(prompt, "Severity")).toBe("Severity, set by the monitor: critical")
    expect(readPromptLine(prompt, "Response received")).toBe("Response received, as JSON cut to 2000 characters: null")
  })

  test("gives the model the payload and the response as JSON, each cut to 2000 characters", async () => {
    await seedBaseline(12)
    const ping = await seedPing({
      durationMs: 250,
      payload: { filler: "p".repeat(5000) },
      response: { echoed: "r".repeat(5000) },
    })

    await reportIncidentForPing(ping)
    const { prompt } = readModelRequest()
    const payloadJson = readPromptLine(prompt, "Payload sent")?.replace(
      "Payload sent, as JSON cut to 2000 characters: ",
      "",
    )

    expect(payloadJson).toHaveLength(2000)
    expect(payloadJson).toContain('"filler":"p')
    expect(payloadJson?.at(-1)).toBe("p")
    expect(readPromptLine(prompt, "Response received")).toBe(
      `Response received, as JSON cut to 2000 characters: {"echoed":"${"r".repeat(1989)}`,
    )
  })

  test("asks for a summary and 2 to 4 causes and recommendations", async () => {
    await seedBaseline(12)
    await reportIncidentForPing(await seedPing({ durationMs: 250 }))
    const { schema } = readModelRequest()

    expect(schema.safeParse(WRITTEN_REPORT).success).toBe(true)
    expect(schema.safeParse({ ...WRITTEN_REPORT, likelyCauses: ["one"] }).success).toBe(false)
    expect(schema.safeParse({ ...WRITTEN_REPORT, recommendations: ["1", "2", "3", "4", "5"] }).success).toBe(false)
    expect(
      schema.safeParse({ likelyCauses: WRITTEN_REPORT.likelyCauses, recommendations: WRITTEN_REPORT.recommendations })
        .success,
    ).toBe(false)
  })

  test("saves the incident as skipped_budget, without calling the model, when the budget is spent", async () => {
    vi.mocked(hasLlmBudget).mockResolvedValue(false)
    await seedBaseline(12)
    const ping = await seedPing({ durationMs: 250 })

    const incident = await reportIncidentForPing(ping)

    expect(incident).toMatchObject({
      pingId: ping.id,
      severity: "warning",
      reportStatus: "skipped_budget",
      summary: null,
      inputTokens: 0,
      outputTokens: 0,
    })
    expect(await findStoredIncident(incident!.id)).toStrictEqual(incident)
    expect(generateStructured).not.toHaveBeenCalled()
  })

  test("saves the incident as failed, and logs the error, when the model call throws", async () => {
    const modelFailure = new Error("The model call timed out")
    vi.mocked(generateStructured).mockRejectedValue(modelFailure)
    const errorLog = vi.spyOn(logger, "error")
    await seedBaseline(12)
    const ping = await seedPing({ durationMs: 250 })

    const incident = await reportIncidentForPing(ping)

    expect(incident).toMatchObject({
      pingId: ping.id,
      severity: "warning",
      reportStatus: "failed",
      summary: null,
      likelyCauses: null,
      inputTokens: 0,
    })
    expect(await findStoredIncident(incident!.id)).toStrictEqual(incident)
    expect(errorLog).toHaveBeenCalledExactlyOnceWith(
      { err: modelFailure, incidentId: incident!.id, pingId: ping.id },
      expect.any(String),
    )
  })

  test("saves the incident as failed when checking the budget throws", async () => {
    vi.mocked(hasLlmBudget).mockRejectedValue(new Error("database is down"))
    await seedBaseline(12)
    const ping = await seedPing({ durationMs: 250 })

    const incident = await reportIncidentForPing(ping)

    expect(incident).toMatchObject({ reportStatus: "failed" })
    expect(generateStructured).not.toHaveBeenCalled()
  })
})

describe("reportIncidentForPing: the broadcast", () => {
  test("broadcasts the incident once its report is saved", async () => {
    await seedBaseline(12)
    const ping = await seedPing({ durationMs: 250 })

    const incident = await reportIncidentForPing(ping)

    expect(broadcastIncident).toHaveBeenCalledExactlyOnceWith(incident)
    expect(vi.mocked(broadcastIncident).mock.calls[0][0]).toMatchObject({
      reportStatus: "written",
      summary: WRITTEN_REPORT.summary,
    })
  })

  test("broadcasts a skipped report too", async () => {
    vi.mocked(hasLlmBudget).mockResolvedValue(false)
    await seedBaseline(12)

    const incident = await reportIncidentForPing(await seedPing({ durationMs: 250 }))

    expect(broadcastIncident).toHaveBeenCalledExactlyOnceWith(incident)
  })

  test("still returns the saved incident, and logs, when the broadcast throws", async () => {
    vi.mocked(broadcastIncident).mockImplementationOnce(() => {
      throw new Error("stream exploded")
    })
    const errorLog = vi.spyOn(logger, "error")
    await seedBaseline(12)

    const incident = await reportIncidentForPing(await seedPing({ durationMs: 250 }))

    expect(incident).toMatchObject({ reportStatus: "written" })
    expect(await findStoredIncident(incident!.id)).toStrictEqual(incident)
    expect(errorLog).toHaveBeenCalledExactlyOnceWith(
      { err: new Error("stream exploded"), incidentId: incident!.id },
      expect.any(String),
    )
  })
})
