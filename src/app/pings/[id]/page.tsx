import { notFound } from "next/navigation"
import { connection } from "next/server"
import { PingDetails } from "@/components/ping-details"
import { parsePingId } from "@/lib/ping-id"
import { findPingById } from "@/services/ping"

const PingPage = async ({ params }: PageProps<"/pings/[id]">) => {
  await connection()
  const pingId = parsePingId((await params).id)
  if (pingId === null) notFound()
  const ping = await findPingById(pingId)
  if (ping === null) notFound()
  return <PingDetails ping={ping} />
}

export default PingPage
