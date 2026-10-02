import { listRecentIncidents } from "@/services/incidents"

export const dynamic = "force-dynamic"

export const GET = async () => Response.json({ incidents: await listRecentIncidents() })
