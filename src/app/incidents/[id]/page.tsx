import { notFound } from "next/navigation"
import { connection } from "next/server"
import { IncidentDetails } from "@/components/incident-details"
import { parseIncidentId } from "@/lib/incident-id"
import { findIncidentById } from "@/services/incidents"

const IncidentPage = async ({ params }: PageProps<"/incidents/[id]">) => {
  await connection()
  const incidentId = parseIncidentId((await params).id)
  if (incidentId === null) notFound()
  const incident = await findIncidentById(incidentId)
  if (incident === null) notFound()
  return <IncidentDetails incident={incident} />
}

export default IncidentPage
