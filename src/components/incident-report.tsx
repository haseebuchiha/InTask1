import type { Incident, Prisma } from "@/db/generated/browser"

const FAILED_REPORT_NOTE = "Report failed"

const MISSING_REPORT_NOTES: Partial<Record<string, string>> = {
  pending: "Report in progress",
  skipped_budget: "Report skipped: hourly model budget was spent",
  failed: FAILED_REPORT_NOTE,
}

type IncidentReportFields = Pick<Incident, "reportStatus" | "summary" | "likelyCauses" | "recommendations">

export const IncidentReport = ({ incident }: { incident: IncidentReportFields }) => {
  if (incident.reportStatus !== "written")
    return <p className="text-muted-foreground">{describeMissingReport(incident.reportStatus)}</p>
  return (
    <div className="flex flex-col gap-4">
      {incident.summary !== null && <p>{incident.summary}</p>}
      <ReportList title="Likely causes" json={incident.likelyCauses} />
      <ReportList title="Recommendations" json={incident.recommendations} />
    </div>
  )
}

const ReportList = ({ title, json }: { title: string; json: Prisma.JsonValue }) => (
  <div className="flex flex-col gap-1">
    <h3 className="font-medium">{title}</h3>
    <ul className="list-disc pl-5 text-muted-foreground">
      {readTextList(json).map((entry) => (
        <li key={entry}>{entry}</li>
      ))}
    </ul>
  </div>
)

const readTextList = (json: Prisma.JsonValue) =>
  Array.isArray(json) ? json.filter((entry) => typeof entry === "string") : []

const describeMissingReport = (reportStatus: string) => MISSING_REPORT_NOTES[reportStatus] ?? FAILED_REPORT_NOTE
