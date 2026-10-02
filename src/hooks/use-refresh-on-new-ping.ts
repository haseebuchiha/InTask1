import { useRouter } from "next/navigation"
import { useEffect, useEffectEvent, useState } from "react"

const PING_STREAM_PATH = "/api/pings/stream"

const REFRESH_EVENT_NAMES = ["ping", "incident"]

const RECONNECT_DELAY_MS = 5000

export type LiveConnectionStatus = "connecting" | "live" | "reconnecting"

type PingStreamCallbacks = {
  refreshPage: () => void
  showStatus: (status: LiveConnectionStatus) => void
}

export const useRefreshOnNewPing = () => {
  const router = useRouter()
  const [connectionStatus, setConnectionStatus] = useState<LiveConnectionStatus>("connecting")
  const refreshPage = useEffectEvent(() => router.refresh())
  useEffect(() => listenToPingStream({ refreshPage, showStatus: setConnectionStatus }), [])
  return connectionStatus
}

const listenToPingStream = (callbacks: PingStreamCallbacks) => {
  const stopController = new AbortController()
  connectToPingStream(callbacks, stopController.signal, () => callbacks.showStatus("live"))
  return () => stopController.abort()
}

const connectToPingStream = (callbacks: PingStreamCallbacks, stopSignal: AbortSignal, onOpen: () => void) => {
  const eventSource = new EventSource(PING_STREAM_PATH)
  const closeEventSource = () => eventSource.close()
  stopSignal.addEventListener("abort", closeEventSource)
  eventSource.addEventListener("open", onOpen)
  REFRESH_EVENT_NAMES.forEach((eventName) => eventSource.addEventListener(eventName, callbacks.refreshPage))
  eventSource.addEventListener("error", () => reconnectAfterDelay(closeEventSource, callbacks, stopSignal))
}

const reconnectAfterDelay = (closeEventSource: () => void, callbacks: PingStreamCallbacks, stopSignal: AbortSignal) => {
  stopSignal.removeEventListener("abort", closeEventSource)
  closeEventSource()
  callbacks.showStatus("reconnecting")
  setTimeout(() => reconnectToPingStream(callbacks, stopSignal), RECONNECT_DELAY_MS)
}

const reconnectToPingStream = (callbacks: PingStreamCallbacks, stopSignal: AbortSignal) => {
  if (stopSignal.aborted) return
  connectToPingStream(callbacks, stopSignal, () => refreshAndGoLive(callbacks))
}

const refreshAndGoLive = ({ refreshPage, showStatus }: PingStreamCallbacks) => {
  refreshPage()
  showStatus("live")
}
