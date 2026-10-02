"use client"

import { ArrowRightIcon, ShieldCheckIcon } from "lucide-react"
import Link from "next/link"
import { IncidentReport } from "@/components/incident-report"
import { LiveStatusBadge } from "@/components/live-status-badge"
import { LocalTime } from "@/components/local-time"
import { formatDurationComparison, IncidentSeverityBadge } from "@/components/ping-formatting"
import { buttonVariants } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import type { Incident, Ping } from "@/db/generated/browser"
import { useRefreshOnNewPing } from "@/hooks/use-refresh-on-new-ping"
import { cn } from "@/lib/utils"

export type IncidentListEntry = Incident & { ping: Pick<Ping, "id" | "createdAt" | "statusCode" | "error"> }

export const IncidentList = ({ incidents }: { incidents: IncidentListEntry[] }) => {
  const connectionStatus = useRefreshOnNewPing()

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight">Incidents</h1>
          <p className="text-sm text-muted-foreground">
            Pings that failed or took at least twice their 24-hour average, each with a short report written by a
            language model. Newest first.
          </p>
        </div>
        <LiveStatusBadge connectionStatus={connectionStatus} />
      </header>
      <section aria-label="Incident history" className="flex flex-col gap-4">
        {incidents.length === 0 ? (
          <IncidentEmptyState />
        ) : (
          incidents.map((incident) => <IncidentCard key={incident.id} incident={incident} />)
        )}
      </section>
    </div>
  )
}

const IncidentCard = ({ incident }: { incident: IncidentListEntry }) => (
  <Card>
    <CardHeader>
      <CardTitle>
        <h2>
          <LocalTime isoTime={incident.createdAt.toISOString()} />
        </h2>
      </CardTitle>
      <CardDescription>{formatDurationComparison(incident)}</CardDescription>
      <CardAction>
        <IncidentSeverityBadge severity={incident.severity} />
      </CardAction>
    </CardHeader>
    <CardContent>
      <div className="flex flex-col gap-4">
        {incident.ping.error !== null && (
          <p className="wrap-break-word text-destructive">{`Ping failed: ${incident.ping.error}`}</p>
        )}
        <IncidentReport incident={incident} />
      </div>
    </CardContent>
    <CardFooter>
      <div className="flex flex-wrap gap-2">
        <Link href={`/incidents/${incident.id}`} className={cn(buttonVariants({ variant: "outline", size: "sm" }))}>
          Incident details
          <ArrowRightIcon data-icon="inline-end" />
        </Link>
        <Link href={`/pings/${incident.pingId}`} className={cn(buttonVariants({ variant: "ghost", size: "sm" }))}>
          Ping #{incident.pingId}
        </Link>
      </div>
    </CardFooter>
  </Card>
)

const IncidentEmptyState = () => (
  <Empty>
    <EmptyHeader>
      <EmptyMedia variant="icon">
        <ShieldCheckIcon />
      </EmptyMedia>
      <EmptyTitle>No incidents yet</EmptyTitle>
      <EmptyDescription>When a ping fails or runs slow, it shows up here with its report.</EmptyDescription>
    </EmptyHeader>
  </Empty>
)
