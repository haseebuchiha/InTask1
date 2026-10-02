import { connection } from "next/server"
import { IncidentList } from "@/components/incident-list"
import { listRecentIncidents } from "@/services/incidents"

const IncidentsPage = async () => {
  await connection()
  const incidents = await listRecentIncidents()
  return <IncidentList incidents={incidents} />
}

export default IncidentsPage
