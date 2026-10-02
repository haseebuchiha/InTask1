import { LARGEST_PING_ID, parsePingId } from "@/lib/ping-id"
import { findPingById } from "@/services/ping"

const INVALID_PING_ID_MESSAGE = `Ping id must be a whole number from 1 to ${LARGEST_PING_ID}`

export const GET = async (_request: Request, context: RouteContext<"/api/pings/[id]">) => {
  const pingId = parsePingId((await context.params).id)
  if (pingId === null) return Response.json({ error: INVALID_PING_ID_MESSAGE }, { status: 400 })
  const ping = await findPingById(pingId)
  if (ping === null) return Response.json({ error: `No ping with id ${pingId}` }, { status: 404 })
  return Response.json(ping)
}
