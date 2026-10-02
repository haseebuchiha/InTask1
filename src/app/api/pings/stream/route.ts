import { openPingStream } from "@/services/live-updates"

export const dynamic = "force-dynamic"

export const GET = async (request: Request) => openPingStream(request)
