"use client"

import { LocalTime } from "@/components/local-time"
import { formatCachedTokens, wholeNumberFormat } from "@/components/ping-formatting"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import type { Prisma } from "@/db/generated/browser"
import type { LatestResponseSummary, RelativeDay } from "@/lib/response-summary"

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000

const NO_SUMMARY_HEADING = "Daily summary"

const HEADINGS: Record<RelativeDay, string> = {
  yesterday: "Yesterday's summary",
  earlier: NO_SUMMARY_HEADING,
}

const FAILED_NOTE = "Not written: the model call failed."

const UNWRITTEN_NOTES: Partial<Record<string, string>> = {
  pending: "Being written…",
  skipped_budget: "Not written: the hour's model budget was spent.",
  failed: FAILED_NOTE,
}

type SummaryProps = { summary: LatestResponseSummary }

export const ResponseSummaryCard = ({ summary }: { summary: LatestResponseSummary | null }) => (
  <Card>
    <CardHeader>
      <CardTitle>
        <h2>{summary === null ? NO_SUMMARY_HEADING : HEADINGS[summary.relativeDay]}</h2>
      </CardTitle>
      {summary !== null && <SummaryWindow summary={summary} />}
    </CardHeader>
    <CardContent>
      {summary === null ? (
        <p className="text-muted-foreground">No summary yet. The first one is written after midnight UTC.</p>
      ) : (
        <SummaryBody summary={summary} />
      )}
    </CardContent>
  </Card>
)

const SummaryWindow = ({ summary }: SummaryProps) => (
  <CardDescription>
    From <LocalTime isoTime={summary.day.toISOString()} /> to <LocalTime isoTime={formatDayEnd(summary.day)} />
  </CardDescription>
)

const SummaryBody = ({ summary }: SummaryProps) => {
  if (summary.status !== "written") return <p className="text-muted-foreground">{describeUnwrittenSummary(summary)}</p>
  return (
    <div className="flex flex-col gap-3">
      {summary.summary !== null && <p>{summary.summary}</p>}
      <FindingList json={summary.findings} />
      <p className="text-sm text-muted-foreground tabular-nums">
        {`${wholeNumberFormat.format(summary.inputTokens)} input tokens${formatCachedTokens(summary.cachedInputTokens)}, ${wholeNumberFormat.format(summary.outputTokens)} output tokens`}
      </p>
    </div>
  )
}

const FindingList = ({ json }: { json: Prisma.JsonValue }) => {
  const findings = readTextList(json)
  if (findings.length === 0) return null
  return (
    <ul className="list-disc pl-5">
      {findings.map((finding) => (
        <li key={finding}>{finding}</li>
      ))}
    </ul>
  )
}

const formatDayEnd = (day: Date) => new Date(day.getTime() + MILLISECONDS_PER_DAY).toISOString()

const readTextList = (json: Prisma.JsonValue) =>
  Array.isArray(json) ? json.filter((entry) => typeof entry === "string") : []

const describeUnwrittenSummary = (summary: LatestResponseSummary) => UNWRITTEN_NOTES[summary.status] ?? FAILED_NOTE
