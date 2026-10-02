import { act, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { useRefreshOnNewPing } from "@/hooks/use-refresh-on-new-ping"
import {
  countCreatedEventSources,
  latestEventSource,
  sendError,
  sendIncident,
  sendOpen,
  sendPing,
  stubEventSource,
} from "../support/event-source"
import { buildPingRow } from "../support/ping-row"

const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }))

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }))

const RECONNECT_DELAY_MS = 5000

const renderRefreshOnNewPing = () => renderHook(() => useRefreshOnNewPing())

const failAndWaitForReconnect = () => {
  act(() => void sendError())
  act(() => void vi.advanceTimersByTime(RECONNECT_DELAY_MS))
}

beforeEach(() => {
  stubEventSource()
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe("useRefreshOnNewPing", () => {
  test("opens one EventSource on the stream route and starts as connecting", () => {
    const hook = renderRefreshOnNewPing()
    expect(countCreatedEventSources()).toBe(1)
    expect(latestEventSource().url).toBe("/api/pings/stream")
    expect(hook.result.current).toBe("connecting")
  })

  test("goes live when the stream opens, without refreshing the page", () => {
    const hook = renderRefreshOnNewPing()
    act(() => void sendOpen())
    expect(hook.result.current).toBe("live")
    expect(refresh).not.toHaveBeenCalled()
  })

  test("refreshes the page on every ping", () => {
    renderRefreshOnNewPing()
    act(() => void sendOpen())
    act(() => void sendPing(buildPingRow(101)))
    act(() => void sendPing(buildPingRow(102)))
    expect(refresh).toHaveBeenCalledTimes(2)
  })

  test("refreshes the page on every incident too", () => {
    renderRefreshOnNewPing()
    act(() => void sendOpen())
    act(() => void sendIncident(9))
    act(() => void sendPing(buildPingRow(103)))
    act(() => void sendIncident(10))
    expect(refresh).toHaveBeenCalledTimes(3)
  })

  test("on an error, closes the EventSource and shows reconnecting, then opens a new one after the delay", () => {
    const hook = renderRefreshOnNewPing()
    act(() => void sendOpen())
    const droppedEventSource = latestEventSource()
    act(() => void sendError())
    expect(droppedEventSource.close).toHaveBeenCalledOnce()
    expect(hook.result.current).toBe("reconnecting")
    act(() => void vi.advanceTimersByTime(RECONNECT_DELAY_MS - 1))
    expect(countCreatedEventSources()).toBe(1)
    act(() => void vi.advanceTimersByTime(1))
    expect(countCreatedEventSources()).toBe(2)
    expect(latestEventSource().url).toBe("/api/pings/stream")
    expect(hook.result.current).toBe("reconnecting")
  })

  test("refreshes the page and goes live when the new EventSource opens", () => {
    const hook = renderRefreshOnNewPing()
    act(() => void sendOpen())
    failAndWaitForReconnect()
    expect(refresh).not.toHaveBeenCalled()
    act(() => void sendOpen())
    expect(hook.result.current).toBe("live")
    expect(refresh).toHaveBeenCalledOnce()
  })

  test("keeps trying once per delay while the stream fails, and refreshes once when it is back", () => {
    renderRefreshOnNewPing()
    failAndWaitForReconnect()
    failAndWaitForReconnect()
    expect(countCreatedEventSources()).toBe(3)
    act(() => void sendOpen())
    expect(refresh).toHaveBeenCalledOnce()
  })

  test("closes the EventSource on unmount", () => {
    const hook = renderRefreshOnNewPing()
    hook.unmount()
    expect(latestEventSource().close).toHaveBeenCalledOnce()
  })

  test("opens nothing when it unmounts during the reconnect delay", () => {
    const hook = renderRefreshOnNewPing()
    act(() => void sendError())
    hook.unmount()
    act(() => void vi.advanceTimersByTime(RECONNECT_DELAY_MS))
    expect(countCreatedEventSources()).toBe(1)
  })

  test("keeps no listener for a replaced EventSource, so unmount closes each one only once", () => {
    const hook = renderRefreshOnNewPing()
    const firstEventSource = latestEventSource()
    failAndWaitForReconnect()
    const secondEventSource = latestEventSource()
    failAndWaitForReconnect()
    hook.unmount()
    expect(firstEventSource.close).toHaveBeenCalledOnce()
    expect(secondEventSource.close).toHaveBeenCalledOnce()
    expect(latestEventSource().close).toHaveBeenCalledOnce()
  })
})
