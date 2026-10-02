import "server-only"
import { type Channel, createChannel, createResponse, type DefaultChannelState, type Session } from "better-sse"
import type { Incident } from "@/db/generated/client"
import type { PingRow } from "@/lib/ping-row"

const SESSION_OPTIONS = { headers: { "X-Accel-Buffering": "no", Connection: "close" } }

type ViewerConnection = {
  viewerDisconnectSignal: AbortSignal
  sessionEndController: AbortController
  relay: TransformStream<Uint8Array, Uint8Array>
}

type PingChannel = Channel<DefaultChannelState, ViewerConnection>

export const broadcastPing = (row: PingRow) => {
  getOrCreatePingChannel().broadcast(row, "ping")
}

export const broadcastIncident = (incident: Incident) => {
  getOrCreatePingChannel().broadcast(incident, "incident")
}

export const openPingStream = (request: Request) => {
  if (liveUpdateGlobals.isShuttingDown) return new Response(null, { status: 503, headers: { Connection: "close" } })
  const connection = buildViewerConnection(request)
  const sessionRequest = new Request(request, { signal: connection.sessionEndController.signal })
  const sessionResponse = createResponse(sessionRequest, { ...SESSION_OPTIONS, state: connection }, (session) =>
    joinPingChannel(session, connection),
  )
  return new Response(connection.relay.readable, sessionResponse)
}

export const shutDownPingStreams = () => {
  liveUpdateGlobals.isShuttingDown = true
  getOrCreatePingChannel().activeSessions.forEach((session) => session.state.sessionEndController.abort())
}

const buildViewerConnection = (request: Request): ViewerConnection => ({
  viewerDisconnectSignal: request.signal,
  sessionEndController: new AbortController(),
  relay: new TransformStream(),
})

const joinPingChannel = (session: Session<ViewerConnection>, connection: ViewerConnection) => {
  getOrCreatePingChannel().register(session)
  relayEventsToViewer(session, connection)
  endSessionWhenViewerLeaves(connection)
}

const relayEventsToViewer = (session: Session, { relay, sessionEndController }: ViewerConnection) =>
  session
    .getResponse()
    .body?.pipeTo(relay.writable, { preventCancel: true })
    .catch(() => sessionEndController.abort())

const endSessionWhenViewerLeaves = ({ viewerDisconnectSignal, sessionEndController }: ViewerConnection) => {
  viewerDisconnectSignal.addEventListener("abort", () => sessionEndController.abort())
  if (viewerDisconnectSignal.aborted) sessionEndController.abort()
}

const getOrCreatePingChannel = () => {
  liveUpdateGlobals.pingChannel ??= createChannel<DefaultChannelState, ViewerConnection>()
  return liveUpdateGlobals.pingChannel
}

const liveUpdateGlobals = globalThis as unknown as { pingChannel?: PingChannel; isShuttingDown?: boolean }
