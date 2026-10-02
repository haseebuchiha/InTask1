import { ArrowLeftIcon } from "lucide-react"
import Link from "next/link"
import type { ReactNode } from "react"
import { IncidentReport } from "@/components/incident-report"
import { LocalTime } from "@/components/local-time"
import {
  formatCachedTokens,
  formatDurationComparison,
  IncidentSeverityBadge,
  wholeNumberFormat,
} from "@/components/ping-formatting"
import { buttonVariants } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import type { Incident } from "@/db/generated/browser"
import { cn } from "@/lib/utils"

export const IncidentDetails = ({ incident }: { incident: Incident }) => (
  <div className="flex flex-col gap-6">
    <Link href="/incidents" className={cn(buttonVariants({ variant: "ghost", size: "sm", className: "self-start" }))}>
      <ArrowLeftIcon data-icon="inline-start" />
      All incidents
    </Link>
    <header className="flex flex-wrap items-center gap-3">
      <h1 className="text-2xl font-semibold tracking-tight">Incident #{incident.id}</h1>
      <IncidentSeverityBadge severity={incident.severity} />
    </header>
    <Card>
      <CardContent>
        <dl className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <IncidentField label="Time">
            <LocalTime isoTime={incident.createdAt.toISOString()} />
          </IncidentField>
          <IncidentField label="Ping">
            <Link href={`/pings/${incident.pingId}`} className="underline-offset-4 hover:underline">
              Ping #{incident.pingId}
            </Link>
          </IncidentField>
          <IncidentField label="Duration">{formatDurationComparison(incident)}</IncidentField>
          <IncidentField label="Input tokens">
            {`${wholeNumberFormat.format(incident.inputTokens)}${formatCachedTokens(incident.cachedInputTokens)}`}
          </IncidentField>
          <IncidentField label="Output tokens">{wholeNumberFormat.format(incident.outputTokens)}</IncidentField>
        </dl>
      </CardContent>
    </Card>
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>Report</h2>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <IncidentReport incident={incident} />
      </CardContent>
    </Card>
  </div>
)

const IncidentField = ({ label, children }: { label: string; children: ReactNode }) => (
  <div className="flex flex-col gap-1">
    <dt className="text-muted-foreground">{label}</dt>
    <dd className="font-medium">{children}</dd>
  </div>
)
