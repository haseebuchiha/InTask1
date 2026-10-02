import { act, render, screen, within } from "@testing-library/react"
import { beforeEach, describe, expect, test, vi } from "vitest"
import { IncidentList, type IncidentListEntry } from "@/components/incident-list"
import { sendOpen, stubEventSource } from "../support/event-source"

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }))

const EMPTY_REPORT = { summary: null, likelyCauses: null, recommendations: null }

beforeEach(stubEventSource)

const buildIncident = (id: number, overrides: Partial<IncidentListEntry> = {}): IncidentListEntry => ({
  id,
  createdAt: new Date("2026-09-30T12:00:00.000Z"),
  pingId: id + 100,
  severity: "warning",
  durationMs: 2853,
  averageDurationMs: 300,
  reportStatus: "written",
  summary: "The ping took far longer than usual.",
  likelyCauses: ["httpbin was under heavy load", "A slow network route"],
  recommendations: ["Watch the next few pings", "Check httpbin's status page"],
  inputTokens: 900,
  cachedInputTokens: 0,
  outputTokens: 120,
  ping: { id: id + 100, createdAt: new Date("2026-09-30T12:00:00.000Z"), statusCode: 200, error: null },
  ...overrides,
})

const renderIncidents = (incidents: IncidentListEntry[]) => render(<IncidentList incidents={incidents} />)

const incidentHistory = () => screen.getByRole("region", { name: "Incident history" })

describe("IncidentList", () => {
  test("renders one card per incident, each linking to its details and its ping", () => {
    renderIncidents([buildIncident(1), buildIncident(2)])
    const links = within(incidentHistory()).getAllByRole("link")
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      "/incidents/1",
      "/pings/101",
      "/incidents/2",
      "/pings/102",
    ])
    expect(screen.getByRole("link", { name: "Ping #101" })).toBeDefined()
    expect(screen.getAllByRole("link", { name: "Incident details" })).toHaveLength(2)
  })

  test("titles each card with the incident's time as a machine-readable time element", () => {
    renderIncidents([buildIncident(1)])
    const timeElement = within(screen.getAllByRole("heading", { level: 2 })[0]).getByRole("time")
    expect(timeElement.getAttribute("dateTime")).toBe("2026-09-30T12:00:00.000Z")
  })

  test("shows the severity as a Warning or Critical badge", () => {
    renderIncidents([buildIncident(1), buildIncident(2, { severity: "critical" })])
    expect(screen.getByText("Warning")).toBeDefined()
    expect(screen.getByText("Critical")).toBeDefined()
  })

  test("compares the ping's duration with the 24-hour average", () => {
    renderIncidents([buildIncident(1), buildIncident(2, { durationMs: 600, averageDurationMs: 300 })])
    expect(screen.getByText("2,853 ms vs 300 ms average, 9.5x")).toBeDefined()
    expect(screen.getByText("600 ms vs 300 ms average, 2.0x")).toBeDefined()
  })

  test("shows a written report's summary, likely causes and recommendations as lists", () => {
    renderIncidents([buildIncident(1)])
    expect(screen.getByText("The ping took far longer than usual.")).toBeDefined()
    expect(screen.getByRole("heading", { name: "Likely causes" })).toBeDefined()
    expect(screen.getByRole("heading", { name: "Recommendations" })).toBeDefined()
    const [causes, recommendations] = screen.getAllByRole("list")
    expect(
      within(causes)
        .getAllByRole("listitem")
        .map((entry) => entry.textContent),
    ).toEqual(["httpbin was under heavy load", "A slow network route"])
    expect(
      within(recommendations)
        .getAllByRole("listitem")
        .map((entry) => entry.textContent),
    ).toEqual(["Watch the next few pings", "Check httpbin's status page"])
  })

  test.each([
    ["pending", "Report in progress"],
    ["skipped_budget", "Report skipped: hourly model budget was spent"],
    ["failed", "Report failed"],
  ])("shows a one-line note instead of a report when the status is %s", (reportStatus, note) => {
    renderIncidents([buildIncident(1, { reportStatus, ...EMPTY_REPORT })])
    expect(screen.getByText(note)).toBeDefined()
    expect(screen.queryByRole("heading", { name: "Likely causes" })).toBeNull()
    expect(screen.queryByRole("list")).toBeNull()
  })

  test("shows the ping's error when the ping failed", () => {
    const failedPing = {
      id: 101,
      createdAt: new Date("2026-09-30T12:00:00.000Z"),
      statusCode: null,
      error: "httpbin timed out",
    }
    renderIncidents([buildIncident(1, { severity: "critical", ping: failedPing })])
    expect(screen.getByText("Ping failed: httpbin timed out")).toBeDefined()
  })

  test("says there are no incidents yet when the list is empty", () => {
    renderIncidents([])
    expect(screen.getByText("No incidents yet")).toBeDefined()
    expect(screen.queryByRole("link")).toBeNull()
  })

  test("shows the live connection status next to the heading", () => {
    renderIncidents([buildIncident(1)])
    const header = screen.getByRole("banner")
    expect(within(header).getByRole("heading", { level: 1, name: "Incidents" })).toBeDefined()
    expect(within(header).getByRole("status").textContent).toBe("Live updates: Connecting…")
    act(() => void sendOpen())
    expect(within(header).getByRole("status").textContent).toBe("Live updates: Live")
  })
})
