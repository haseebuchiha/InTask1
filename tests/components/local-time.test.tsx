import { render, screen, within } from "@testing-library/react"
import { renderToString } from "react-dom/server"
import { describe, expect, test } from "vitest"
import { LocalTime } from "@/components/local-time"

const renderOnServer = (isoTime: string) => {
  const container = document.createElement("div")
  container.innerHTML = renderToString(<LocalTime isoTime={isoTime} />)
  return within(container).getByRole("time")
}

describe("LocalTime", () => {
  test("on the server, shows the time in UTC with a UTC suffix", () => {
    const timeElement = renderOnServer("2026-09-30T12:00:00.000Z")

    expect(timeElement.textContent).toBe("Sep 30, 2026, 12:00:00 PM UTC")
    expect(timeElement.getAttribute("dateTime")).toBe("2026-09-30T12:00:00.000Z")
  })

  test("in the browser, shows the viewer's own time, 5 PM in Asia/Karachi, without the UTC suffix", () => {
    render(<LocalTime isoTime="2026-09-30T12:00:00.000Z" />)
    const timeElement = screen.getByRole("time")

    expect(timeElement.textContent).toMatch(/\b(?:5|17):00:00\b/)
    expect(timeElement.textContent).not.toMatch(/UTC$/)
    expect(timeElement.getAttribute("dateTime")).toBe("2026-09-30T12:00:00.000Z")
  })
})
