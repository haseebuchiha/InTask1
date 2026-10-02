import { vi } from "vitest"
import type { PingRow } from "@/lib/ping-row"

const READY_STATES = { CONNECTING: 0, OPEN: 1, CLOSED: 2 }

type StubEventSource = EventTarget & { url: string; readyState: number; close: () => void }

const createdEventSources: StubEventSource[] = []

export const stubEventSource = () => {
  createdEventSources.splice(0)
  vi.stubGlobal(
    "EventSource",
    new Proxy(EventTarget, {
      construct: (_target, [url]: [string]) => createStubEventSource(url),
      get: (_target, readyStateName) => Reflect.get(READY_STATES, readyStateName),
    }),
  )
}

export const countCreatedEventSources = () => createdEventSources.length

export const latestEventSource = () => createdEventSources.at(-1)!

export const sendOpen = () => dispatchInReadyState(new Event("open"), READY_STATES.OPEN)

export const sendError = () => dispatchInReadyState(new Event("error"), READY_STATES.CONNECTING)

export const sendPing = (row: PingRow) =>
  dispatchInReadyState(new MessageEvent("ping", { data: JSON.stringify(row) }), READY_STATES.OPEN)

export const sendIncident = (incidentId: number) =>
  dispatchInReadyState(new MessageEvent("incident", { data: JSON.stringify({ id: incidentId }) }), READY_STATES.OPEN)

const dispatchInReadyState = (event: Event, readyState: number) => {
  const eventSource = latestEventSource()
  if (eventSource.readyState === READY_STATES.CLOSED)
    throw new Error(`The latest EventSource is closed and fires no "${event.type}" event`)
  eventSource.readyState = readyState
  return eventSource.dispatchEvent(event)
}

const createStubEventSource = (url: string) => {
  const eventSource: StubEventSource = Object.assign(new EventTarget(), {
    url,
    readyState: READY_STATES.CONNECTING,
    close: vi.fn(() => {
      eventSource.readyState = READY_STATES.CLOSED
    }),
  })
  createdEventSources.push(eventSource)
  return eventSource
}
