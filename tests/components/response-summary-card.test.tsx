import { render, screen } from "@testing-library/react"
import { describe, expect, test } from "vitest"
import { ResponseSummaryCard } from "@/components/response-summary-card"
import type { LatestResponseSummary } from "@/lib/response-summary"

const buildSummary = (overrides: Partial<LatestResponseSummary> = {}): LatestResponseSummary => ({
  id: 4,
  createdAt: new Date("2026-10-02T00:05:00.000Z"),
  updatedAt: new Date("2026-10-02T00:05:04.000Z"),
  day: new Date("2026-10-01T00:00:00.000Z"),
  status: "written",
  summary: "Of 288 pings, 3 failed, 2 of them around 03:00 UTC.",
  findings: ["Failures clustered at 03:00 UTC", "The caller IP never changed"],
  statistics: { totalPings: 288 },
  inputTokens: 412,
  cachedInputTokens: 0,
  outputTokens: 120,
  relativeDay: "yesterday",
  ...overrides,
})

describe("ResponseSummaryCard headings", () => {
  test.each([
    { relativeDay: "yesterday", heading: "Yesterday's summary" },
    { relativeDay: "earlier", heading: "Daily summary" },
  ] as const)("names a summary from $relativeDay as $heading", ({ relativeDay, heading }) => {
    render(<ResponseSummaryCard summary={buildSummary({ relativeDay })} />)

    expect(screen.getByRole("heading", { name: heading })).toBeDefined()
  })

  test("shows the whole UTC day it covers, from midnight to midnight, as machine-readable times", () => {
    render(<ResponseSummaryCard summary={buildSummary()} />)

    const times = [...screen.getByText(/^From/).querySelectorAll("time")].map((time) => time.getAttribute("dateTime"))
    expect(times).toStrictEqual(["2026-10-01T00:00:00.000Z", "2026-10-02T00:00:00.000Z"])
  })
})

describe("ResponseSummaryCard content", () => {
  test("shows the written summary, its findings and its tokens", () => {
    render(<ResponseSummaryCard summary={buildSummary()} />)

    expect(screen.getByText("Of 288 pings, 3 failed, 2 of them around 03:00 UTC.")).toBeDefined()
    expect(screen.getAllByRole("listitem").map((item) => item.textContent)).toStrictEqual([
      "Failures clustered at 03:00 UTC",
      "The caller IP never changed",
    ])
    expect(screen.getByText("412 input tokens, 120 output tokens")).toBeDefined()
  })

  test("says how many input tokens came from the provider's prompt cache", () => {
    render(<ResponseSummaryCard summary={buildSummary({ cachedInputTokens: 300 })} />)

    expect(screen.getByText("412 input tokens (300 cached), 120 output tokens")).toBeDefined()
  })

  test("leaves out the findings list when there are none", () => {
    render(<ResponseSummaryCard summary={buildSummary({ findings: [] })} />)

    expect(screen.queryByRole("list")).toBeNull()
  })

  test.each([
    { status: "skipped_budget", note: "Not written: the hour's model budget was spent." },
    { status: "failed", note: "Not written: the model call failed." },
    { status: "pending", note: "Being written…" },
  ])("says why a $status summary has no text, without a token line", ({ status, note }) => {
    render(
      <ResponseSummaryCard
        summary={buildSummary({ status, summary: null, findings: null, inputTokens: 0, outputTokens: 0 })}
      />,
    )

    expect(screen.getByText(note)).toBeDefined()
    expect(screen.queryByText(/tokens/)).toBeNull()
  })

  test("says when the first summary comes while there is none", () => {
    render(<ResponseSummaryCard summary={null} />)

    expect(screen.getByRole("heading", { name: "Daily summary" })).toBeDefined()
    expect(screen.getByText("No summary yet. The first one is written after midnight UTC.")).toBeDefined()
    expect(screen.queryByText(/^From/)).toBeNull()
  })
})
