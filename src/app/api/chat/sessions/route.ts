import { listRecentChatSessions, startChatSession } from "@/services/chat"

export const dynamic = "force-dynamic"

export const GET = async () => Response.json({ sessions: await listRecentChatSessions() })

export const POST = async () => Response.json(await startChatSession(), { status: 201 })
