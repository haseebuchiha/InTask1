import { getDefaultNormalizer, render, screen, within } from "@testing-library/react"
import { describe, expect, test } from "vitest"
import { PingDetails } from "@/components/ping-details"
import type { Ping } from "@/db/generated/browser"

const PRETTY_PAYLOAD = `{
  "requestId": "details-test"
}`

const PRETTY_RESPONSE = `{
  "json": {
    "requestId": "details-test"
  },
  "origin": "203.0.113.7"
}`

const keepWhitespace = { normalizer: getDefaultNormalizer({ trim: false, collapseWhitespace: false }) }

const comesBefore = (earlier: Element, later: Element) =>
  Boolean(earlier.compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING)

const buildPing = (overrides: Partial<Ping> = {}): Ping => ({
  id: 7,
  createdAt: new Date("2026-09-30T12:00:00.000Z"),
  payload: { requestId: "details-test" },
  statusCode: 200,
  durationMs: 187,
  response: { json: { requestId: "details-test" }, origin: "203.0.113.7" },
  error: null,
  responseKind: "clean_echo",
  origin: "203.0.113.7",
  ...overrides,
})

describe("PingDetails", () => {
  test.each([
    { responseKind: "clean_echo", label: "Clean echo" },
    { responseKind: "echo_mismatch", label: "Echo mismatch" },
    { responseKind: "empty", label: "Empty body" },
    { responseKind: "client_error", label: "Client error" },
    { responseKind: "gateway_error", label: "Gateway error" },
    { responseKind: "failed", label: "No reply" },
  ])("shows the $responseKind response kind as a $label badge in the header", ({ responseKind, label }) => {
    render(<PingDetails ping={buildPing({ responseKind })} />)

    expect(within(screen.getByRole("banner")).getByText(label)).toBeDefined()
  })

  test("shows the payload sent and httpbin's response, each pretty-printed under its own title", () => {
    render(<PingDetails ping={buildPing()} />)
    const payloadTitle = screen.getByText("Payload sent")
    const payload = screen.getByText(PRETTY_PAYLOAD, keepWhitespace)
    const responseTitle = screen.getByText("httpbin’s response")
    const response = screen.getByText(PRETTY_RESPONSE, keepWhitespace)

    expect(comesBefore(payloadTitle, payload)).toBe(true)
    expect(comesBefore(payload, responseTitle)).toBe(true)
    expect(comesBefore(responseTitle, response)).toBe(true)
  })

  test("for a failed ping, says nothing was saved under httpbin's response and shows the error", () => {
    render(
      <PingDetails
        ping={buildPing({
          statusCode: null,
          response: null,
          error: "Request to httpbin failed: The operation was aborted due to timeout",
          responseKind: "failed",
          origin: null,
        })}
      />,
    )
    const responseTitle = screen.getByText("httpbin’s response")
    const emptyNote = screen.getByText("Nothing was saved. httpbin sent no readable body.")
    const errorLabel = screen.getByText("Error")
    const errorText = screen.getByText("Request to httpbin failed: The operation was aborted due to timeout")

    expect(comesBefore(responseTitle, emptyNote)).toBe(true)
    expect(comesBefore(errorLabel, errorText)).toBe(true)
  })
})
