import { LARGEST_INCIDENT_ID, parseIncidentId } from "@/lib/incident-id"
import { findIncidentById } from "@/services/incidents"

const INVALID_INCIDENT_ID_MESSAGE = `Incident id must be a whole number from 1 to ${LARGEST_INCIDENT_ID}`

export const GET = async (_request: Request, context: RouteContext<"/api/incidents/[id]">) => {
  const incidentId = parseIncidentId((await context.params).id)
  if (incidentId === null) return Response.json({ error: INVALID_INCIDENT_ID_MESSAGE }, { status: 400 })
  const incident = await findIncidentById(incidentId)
  if (incident === null) return Response.json({ error: `No incident with id ${incidentId}` }, { status: 404 })
  return Response.json(incident)
}
