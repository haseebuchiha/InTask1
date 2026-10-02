import { CircleCheckIcon, CircleXIcon, OctagonAlertIcon, TriangleAlertIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"

const RESPONSE_KIND_LABELS: Partial<Record<string, string>> = {
  clean_echo: "Clean echo",
  echo_mismatch: "Echo mismatch",
  empty: "Empty body",
  client_error: "Client error",
  gateway_error: "Gateway error",
  failed: "No reply",
}

export const PingStatusBadge = ({ error }: { error: string | null }) => {
  if (error !== null) {
    return (
      <Badge variant="destructive">
        <CircleXIcon data-icon="inline-start" />
        Failed
      </Badge>
    )
  }
  return (
    <Badge variant="secondary">
      <CircleCheckIcon data-icon="inline-start" />
      Success
    </Badge>
  )
}

export const IncidentSeverityBadge = ({ severity }: { severity: string }) => {
  if (severity === "critical") {
    return (
      <Badge variant="destructive">
        <OctagonAlertIcon data-icon="inline-start" />
        Critical
      </Badge>
    )
  }
  return (
    <Badge variant="outline">
      <TriangleAlertIcon data-icon="inline-start" />
      Warning
    </Badge>
  )
}

export const ResponseKindBadge = ({ responseKind }: { responseKind: string }) => (
  <Badge variant={responseKind === "clean_echo" ? "secondary" : "outline"}>
    {RESPONSE_KIND_LABELS[responseKind] ?? responseKind}
  </Badge>
)

export const formatDuration = (durationMs: number) => `${wholeNumberFormat.format(durationMs)} ms`

export const formatDurationComparison = ({
  durationMs,
  averageDurationMs,
}: {
  durationMs: number
  averageDurationMs: number
}) =>
  `${formatDuration(durationMs)} vs ${formatDuration(averageDurationMs)} average, ${multipleFormat.format(durationMs / averageDurationMs)}x`

export const formatStatusCode = (statusCode: number | null) => statusCode?.toString() ?? "—"

export const formatCachedTokens = (cachedInputTokens: number) =>
  cachedInputTokens > 0 ? ` (${wholeNumberFormat.format(cachedInputTokens)} cached)` : ""

export const formatPingInterval = (pingIntervalMs: number) => {
  const pingIntervalSeconds = pingIntervalMs / 1000
  if (pingIntervalSeconds % 60 === 0) return minutesFormat.format(pingIntervalSeconds / 60)
  return secondsFormat.format(pingIntervalSeconds)
}

export const wholeNumberFormat = new Intl.NumberFormat("en-US")

const multipleFormat = new Intl.NumberFormat("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 })

const minutesFormat = new Intl.NumberFormat("en-US", { style: "unit", unit: "minute", unitDisplay: "long" })

const secondsFormat = new Intl.NumberFormat("en-US", { style: "unit", unit: "second", unitDisplay: "long" })
