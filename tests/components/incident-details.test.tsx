import { render, screen } from "@testing-library/react"
import { describe, expect, test } from "vitest"
import { IncidentDetails } from "@/components/incident-details"
import type { Incident } from "@/db/generated/browser"

const buildIncident = (overrides: Partial<Incident> = {}): Incident => ({
  id: 3,
  createdAt: new Date("2026-09-30T12:00:01.000Z"),
  pingId: 7,
  severity: "warning",
  durationMs: 420,
  averageDurationMs: 180,
  reportStatus: "written",
  summary: "The ping took more than twice as long as usual.",
  likelyCauses: ["httpbin was slow", "The network was congested"],
  recommendations: ["Watch the next pings", "Check httpbin's status"],
  inputTokens: 1812,
  cachedInputTokens: 0,
  outputTokens: 96,
  ...overrides,
})

describe("IncidentDetails", () => {
  test("shows the report call's input and output tokens", () => {
    render(<IncidentDetails incident={buildIncident()} />)

    expect(screen.getByText("Input tokens").nextElementSibling?.textContent).toBe("1,812")
    expect(screen.getByText("Output tokens").nextElementSibling?.textContent).toBe("96")
  })

  test("says how many input tokens came from the provider's prompt cache", () => {
    render(<IncidentDetails incident={buildIncident({ cachedInputTokens: 1024 })} />)

    expect(screen.getByText("Input tokens").nextElementSibling?.textContent).toBe("1,812 (1,024 cached)")
  })
})
