import { loadPingFilters } from "@/lib/ping-filters"
import { listPingHistory } from "@/services/ping"

const INVALID_FILTERS_MESSAGE =
  "Invalid filters: page must be a number, and from and to must be ISO 8601 dates or date-times like 2026-09-30 or 2026-09-30T12:00:00Z"

export const GET = async (request: Request) => {
  const filters = readFilters(request)
  if (filters === null) return Response.json({ error: INVALID_FILTERS_MESSAGE }, { status: 400 })
  return Response.json(await listPingHistory(filters))
}

const readFilters = (request: Request) => {
  try {
    return loadPingFilters(request, { strict: true })
  } catch {
    return null
  }
}
