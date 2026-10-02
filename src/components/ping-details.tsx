import { ArrowLeftIcon } from "lucide-react"
import Link from "next/link"
import type { ReactNode } from "react"
import { LocalTime } from "@/components/local-time"
import { formatDuration, formatStatusCode, PingStatusBadge, ResponseKindBadge } from "@/components/ping-formatting"
import { buttonVariants } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import type { Ping, Prisma } from "@/db/generated/browser"
import { cn } from "@/lib/utils"

export const PingDetails = ({ ping }: { ping: Ping }) => (
  <div className="flex flex-col gap-6">
    <Link href="/" className={cn(buttonVariants({ variant: "ghost", size: "sm", className: "self-start" }))}>
      <ArrowLeftIcon data-icon="inline-start" />
      All pings
    </Link>
    <header className="flex flex-wrap items-center gap-3">
      <h1 className="text-2xl font-semibold tracking-tight">Ping #{ping.id}</h1>
      <PingStatusBadge error={ping.error} />
      <ResponseKindBadge responseKind={ping.responseKind} />
    </header>
    <Card>
      <CardContent>
        <dl className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <PingField label="Time">
            <LocalTime isoTime={ping.createdAt.toISOString()} />
          </PingField>
          <PingField label="HTTP status">{formatStatusCode(ping.statusCode)}</PingField>
          <PingField label="Duration">{formatDuration(ping.durationMs)}</PingField>
          {ping.error !== null && (
            <div className="flex flex-col gap-1 sm:col-span-3">
              <dt className="text-muted-foreground">Error</dt>
              <dd className="font-medium wrap-break-word text-destructive">{ping.error}</dd>
            </div>
          )}
        </dl>
      </CardContent>
    </Card>
    <JsonCard title="Payload sent" json={ping.payload} />
    <JsonCard title="httpbin’s response" json={ping.response} />
  </div>
)

const PingField = ({ label, children }: { label: string; children: ReactNode }) => (
  <div className="flex flex-col gap-1">
    <dt className="text-muted-foreground">{label}</dt>
    <dd className="font-medium">{children}</dd>
  </div>
)

const JsonCard = ({ title, json }: { title: string; json: Prisma.JsonValue }) => (
  <Card>
    <CardHeader>
      <CardTitle>{title}</CardTitle>
    </CardHeader>
    <CardContent>
      {json === null ? (
        <p className="text-muted-foreground">Nothing was saved. httpbin sent no readable body.</p>
      ) : (
        <pre className="overflow-x-auto rounded-lg bg-muted p-4 font-mono text-xs">{JSON.stringify(json, null, 2)}</pre>
      )}
    </CardContent>
  </Card>
)
