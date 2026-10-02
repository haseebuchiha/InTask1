import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { type OnUrlUpdateFunction, withNuqsTestingAdapter } from "nuqs/adapters/testing"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import type { LlmUsage } from "@/components/llm-usage-card"
import { PingDashboard } from "@/components/ping-dashboard"
import type { PingHistoryPage, PingRow } from "@/lib/ping-row"
import type { LatestResponseSummary } from "@/lib/response-summary"
import { sendError, sendOpen, stubEventSource } from "../support/event-source"
import { buildPingRow } from "../support/ping-row"

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }))

beforeEach(stubEventSource)

afterEach(() => {
  vi.useRealTimers()
})

const successfulPing = buildPingRow(101, { durationMs: 1234 })

const failedPing = buildPingRow(102, {
  createdAt: "2026-09-30T11:55:00.000Z",
  statusCode: null,
  durationMs: 87,
  error: "Request to httpbin failed: The operation was aborted due to timeout",
  responseKind: "failed",
  origin: null,
})

const llmUsage: LlmUsage = {
  callsThisHour: 3,
  callsPerHour: 20,
  resetsAt: new Date("2026-09-30T12:40:00.000Z"),
  estimatedUsdToday: 0.04,
  cachedInputTokensToday: 0,
}

const responseSummary: LatestResponseSummary = {
  id: 4,
  createdAt: new Date("2026-09-30T00:05:00.000Z"),
  updatedAt: new Date("2026-09-30T00:05:04.000Z"),
  day: new Date("2026-09-29T00:00:00.000Z"),
  status: "written",
  summary: "All 288 pings succeeded, so there were no failures.",
  findings: ["Latency stayed under one second"],
  statistics: { totalPings: 288 },
  inputTokens: 412,
  cachedInputTokens: 0,
  outputTokens: 120,
  relativeDay: "yesterday",
}

const buildHistory = (pings: PingRow[], overrides: Partial<PingHistoryPage> = {}): PingHistoryPage => ({
  pings,
  totalCount: pings.length,
  page: 1,
  pageSize: 20,
  ...overrides,
})

const renderDashboard = (pingPage: PingHistoryPage, searchParams = "", pingIntervalMs = 300_000) => {
  const onUrlUpdate = vi.fn<OnUrlUpdateFunction>()
  render(
    <PingDashboard
      pingPage={pingPage}
      pingIntervalMs={pingIntervalMs}
      llmUsage={llmUsage}
      responseSummary={responseSummary}
    />,
    {
      wrapper: withNuqsTestingAdapter({ searchParams, onUrlUpdate }),
    },
  )
  return { onUrlUpdate }
}

const bodyRows = () => screen.getAllByRole("row").slice(1)

const lastUrlUpdate = (onUrlUpdate: ReturnType<typeof vi.fn<OnUrlUpdateFunction>>) => onUrlUpdate.mock.lastCall![0]

describe("PingDashboard ping interval", () => {
  test("names the real ping interval in the header", () => {
    renderDashboard(buildHistory([successfulPing]), "", 30_000)
    expect(within(screen.getByRole("banner")).getByText(/every 30 seconds and saves the reply/)).toBeDefined()
  })

  test("names the default 5-minute interval in the header", () => {
    renderDashboard(buildHistory([successfulPing]), "", 300_000)
    expect(within(screen.getByRole("banner")).getByText(/every 5 minutes and saves the reply/)).toBeDefined()
  })

  test("says when the first ping comes, using the real interval, while the table is empty", () => {
    renderDashboard(buildHistory([]), "", 30_000)
    expect(screen.getByText(/first ping 30 seconds after it starts/)).toBeDefined()
  })

  test("uses the singular unit for one minute", () => {
    renderDashboard(buildHistory([successfulPing]), "", 60_000)
    expect(within(screen.getByRole("banner")).getByText(/every 1 minute and saves the reply/)).toBeDefined()
  })
})

describe("PingDashboard model usage", () => {
  test("shows the model usage card with this hour's calls and today's estimated cost", () => {
    renderDashboard(buildHistory([successfulPing]))
    expect(screen.getByRole("heading", { name: "Model usage" })).toBeDefined()
    expect(screen.getByText("3 of 20 model calls this hour")).toBeDefined()
    expect(screen.getByText("About $0.04 estimated today")).toBeDefined()
  })
})

describe("PingDashboard response summary", () => {
  test("shows yesterday's summary at the top, above the model usage card and the ping table", () => {
    renderDashboard(buildHistory([successfulPing]))
    const summaryHeading = screen.getByRole("heading", { name: "Yesterday's summary" })
    const usageHeading = screen.getByRole("heading", { name: "Model usage" })

    expect(screen.getByText("All 288 pings succeeded, so there were no failures.")).toBeDefined()
    expect(summaryHeading.compareDocumentPosition(usageHeading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(
      summaryHeading.compareDocumentPosition(screen.getByRole("table")) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
  })
})

describe("PingDashboard table", () => {
  test("shows each ping's response kind in its own column", () => {
    renderDashboard(buildHistory([successfulPing, failedPing]))
    const [successRow, failedRow] = bodyRows()

    expect(screen.getByRole("columnheader", { name: "Response" })).toBeDefined()
    expect(within(successRow).getByText("Clean echo")).toBeDefined()
    expect(within(failedRow).getByText("No reply")).toBeDefined()
  })

  test("renders one row per ping, each linking to its detail page", () => {
    renderDashboard(buildHistory([successfulPing, failedPing]))
    expect(bodyRows()).toHaveLength(2)
    expect(screen.getAllByRole("link").map((link) => link.getAttribute("href"))).toEqual(["/pings/101", "/pings/102"])
  })

  test("shows each ping's time as a machine-readable time element", () => {
    renderDashboard(buildHistory([successfulPing]))
    const timeElement = within(within(bodyRows()[0]).getByRole("link")).getByRole("time")
    expect(timeElement.getAttribute("dateTime")).toBe("2026-09-30T12:00:00.000Z")
  })

  test("marks successful pings with a Success badge and failed pings with a Failed badge", () => {
    renderDashboard(buildHistory([successfulPing, failedPing]))
    const [successRow, failedRow] = bodyRows()
    expect(within(successRow).getByText("Success")).toBeDefined()
    expect(within(successRow).queryByText("Failed")).toBeNull()
    expect(within(failedRow).getByText("Failed")).toBeDefined()
  })

  test("formats the duration in milliseconds and the HTTP status code, with a dash when there is none", () => {
    renderDashboard(buildHistory([successfulPing, failedPing]))
    const [successRow, failedRow] = bodyRows()
    expect(within(successRow).getByText("1,234 ms")).toBeDefined()
    expect(within(successRow).getByText("200")).toBeDefined()
    expect(within(failedRow).getByText("87 ms")).toBeDefined()
    expect(within(failedRow).getAllByText("—")).toHaveLength(1)
  })

  test("keeps the full error message in the error cell's title", () => {
    renderDashboard(buildHistory([failedPing]))
    const errorElement = screen.getByTitle(failedPing.error!)
    expect(errorElement.textContent).toBe(failedPing.error)
  })

  test("says no pings exist yet when the table is empty and no filter is set", () => {
    renderDashboard(buildHistory([]))
    expect(screen.queryByRole("table")).toBeNull()
    expect(screen.getByText("No pings yet")).toBeDefined()
  })

  test("says nothing matches when the table is empty because of a filter", () => {
    renderDashboard(buildHistory([]), "?failedOnly=true")
    expect(screen.getByText("No pings match these filters")).toBeDefined()
  })
})

describe("PingDashboard filters", () => {
  test("turning on Failed only writes failedOnly=true to the URL, resets the page and asks the server to re-render", async () => {
    const { onUrlUpdate } = renderDashboard(buildHistory([successfulPing], { page: 3, totalCount: 60 }), "?page=3")
    fireEvent.click(screen.getByRole("switch", { name: "Failed only" }))
    await waitFor(() => expect(onUrlUpdate).toHaveBeenCalledOnce())
    const urlUpdate = lastUrlUpdate(onUrlUpdate)
    expect(urlUpdate.searchParams.get("failedOnly")).toBe("true")
    expect(urlUpdate.searchParams.has("page")).toBe(false)
    expect(urlUpdate.options.shallow).toBe(false)
    expect(urlUpdate.options.history).toBe("push")
  })

  test("turning off Failed only removes it from the URL", async () => {
    const { onUrlUpdate } = renderDashboard(buildHistory([failedPing]), "?failedOnly=true")
    fireEvent.click(screen.getByRole("switch", { name: "Failed only" }))
    await waitFor(() => expect(onUrlUpdate).toHaveBeenCalledOnce())
    expect(lastUrlUpdate(onUrlUpdate).queryString).toBe("")
  })

  test("picking a From day writes the start of that day in the viewer's zone, Asia/Karachi here, to the URL", async () => {
    vi.useFakeTimers()
    const { onUrlUpdate } = renderDashboard(buildHistory([successfulPing]), "?page=2")
    fireEvent.change(screen.getByLabelText("From"), { target: { value: "2026-09-27" } })
    await act(() => vi.advanceTimersByTimeAsync(499))
    expect(onUrlUpdate).not.toHaveBeenCalled()
    await act(() => vi.runAllTimersAsync())
    expect(onUrlUpdate).toHaveBeenCalledOnce()
    const urlUpdate = lastUrlUpdate(onUrlUpdate)
    expect(urlUpdate.searchParams.get("from")).toBe("2026-09-26T19:00:00.000Z")
    expect(urlUpdate.searchParams.has("page")).toBe(false)
  })

  test("picking a To day writes the last moment of that day in the viewer's zone, Asia/Karachi here, to the URL", async () => {
    vi.useFakeTimers()
    const { onUrlUpdate } = renderDashboard(buildHistory([successfulPing]))
    fireEvent.change(screen.getByLabelText("To"), { target: { value: "2026-09-28" } })
    await act(() => vi.advanceTimersByTimeAsync(499))
    expect(onUrlUpdate).not.toHaveBeenCalled()
    await act(() => vi.runAllTimersAsync())
    expect(onUrlUpdate).toHaveBeenCalledOnce()
    expect(lastUrlUpdate(onUrlUpdate).searchParams.get("to")).toBe("2026-09-28T18:59:59.999Z")
  })

  test("Clear filters removes every filter from the URL", async () => {
    const { onUrlUpdate } = renderDashboard(
      buildHistory([failedPing]),
      "?failedOnly=true&from=2026-09-26T19:00:00.000Z",
    )
    expect((screen.getByLabelText("From") as HTMLInputElement).value).toBe("2026-09-27")
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }))
    await waitFor(() => expect(onUrlUpdate).toHaveBeenCalledOnce())
    expect(lastUrlUpdate(onUrlUpdate).queryString).toBe("")
  })

  test("hides Clear filters when no filter is set", () => {
    renderDashboard(buildHistory([successfulPing]))
    expect(screen.queryByRole("button", { name: "Clear filters" })).toBeNull()
  })
})

describe("PingDashboard pagination", () => {
  test("shows which pings are on screen and the total count", () => {
    renderDashboard(buildHistory([successfulPing], { totalCount: 45 }))
    expect(screen.getByText("Showing 1–20 of 45 pings")).toBeDefined()
    expect(screen.getByText("Page 1 of 3")).toBeDefined()
  })

  test("Next writes the next page number to the URL and keeps the filters", async () => {
    const { onUrlUpdate } = renderDashboard(buildHistory([failedPing], { totalCount: 45 }), "?failedOnly=true")
    fireEvent.click(screen.getByRole("button", { name: "Next" }))
    await waitFor(() => expect(onUrlUpdate).toHaveBeenCalledOnce())
    const urlUpdate = lastUrlUpdate(onUrlUpdate)
    expect(urlUpdate.searchParams.get("page")).toBe("2")
    expect(urlUpdate.searchParams.get("failedOnly")).toBe("true")
  })

  test("disables Previous on the first page and Next on the last page", () => {
    renderDashboard(buildHistory([successfulPing], { totalCount: 1 }))
    expect(screen.getByRole("button", { name: "Previous" }).hasAttribute("disabled")).toBe(true)
    expect(screen.getByRole("button", { name: "Next" }).hasAttribute("disabled")).toBe(true)
  })
})

describe("PingDashboard live updates", () => {
  test("shows the connection status in the header as text", () => {
    renderDashboard(buildHistory([successfulPing]))
    const header = screen.getByRole("banner")
    expect(within(header).getByRole("status").textContent).toBe("Live updates: Connecting…")
    act(() => void sendOpen())
    expect(within(header).getByRole("status").textContent).toBe("Live updates: Live")
    act(() => void sendError())
    expect(within(header).getByRole("status").textContent).toBe("Live updates: Reconnecting…")
  })
})
