import { render, screen } from "@testing-library/react"
import { describe, expect, test } from "vitest"
import { type LlmUsage, LlmUsageCard } from "@/components/llm-usage-card"

const buildUsage = (overrides: Partial<LlmUsage> = {}): LlmUsage => ({
  callsThisHour: 12,
  callsPerHour: 20,
  resetsAt: new Date("2026-09-30T14:35:00.000Z"),
  estimatedUsdToday: 0.04,
  cachedInputTokensToday: 0,
  ...overrides,
})

describe("LlmUsageCard", () => {
  test("shows this hour's model calls against the hourly cap", () => {
    render(<LlmUsageCard usage={buildUsage()} />)
    expect(screen.getByRole("heading", { name: "Model usage" })).toBeDefined()
    expect(screen.getByText("12 of 20 model calls this hour")).toBeDefined()
  })

  test("shows when the budget resets as a machine-readable time", () => {
    render(<LlmUsageCard usage={buildUsage()} />)
    const resetLine = screen.getByText(/Resets at/)
    expect(resetLine.querySelector("time")?.getAttribute("dateTime")).toBe("2026-09-30T14:35:00.000Z")
  })

  test("shows today's estimated spend in dollars", () => {
    render(<LlmUsageCard usage={buildUsage()} />)
    expect(screen.getByText("About $0.04 estimated today")).toBeDefined()
  })

  test("keeps small amounts visible instead of rounding them to zero", () => {
    render(<LlmUsageCard usage={buildUsage({ estimatedUsdToday: 0.0135 })} />)
    expect(screen.getByText("About $0.0135 estimated today")).toBeDefined()
  })

  test("shows zero calls and zero spend when the model has not been used", () => {
    render(<LlmUsageCard usage={buildUsage({ callsThisHour: 0, estimatedUsdToday: 0 })} />)
    expect(screen.getByText("0 of 20 model calls this hour")).toBeDefined()
    expect(screen.getByText("About $0.00 estimated today")).toBeDefined()
  })

  test("hides the reset time when nothing has been called this hour", () => {
    render(<LlmUsageCard usage={buildUsage({ callsThisHour: 0 })} />)
    expect(screen.queryByText(/Resets at/)).toBeNull()
  })

  test("shows how many of today's input tokens came from the provider's prompt cache", () => {
    render(<LlmUsageCard usage={buildUsage({ cachedInputTokensToday: 1200 })} />)
    expect(screen.getByText("1,200 cached input tokens today")).toBeDefined()
  })

  test("hides the cached line when no input tokens came from the prompt cache today", () => {
    render(<LlmUsageCard usage={buildUsage()} />)
    expect(screen.queryByText(/cached/)).toBeNull()
  })
})
