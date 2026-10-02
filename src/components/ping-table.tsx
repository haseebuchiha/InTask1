import { ActivityIcon, SearchXIcon } from "lucide-react"
import Link from "next/link"
import { LocalTime } from "@/components/local-time"
import {
  formatDuration,
  formatPingInterval,
  formatStatusCode,
  PingStatusBadge,
  ResponseKindBadge,
} from "@/components/ping-formatting"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import type { PingRow } from "@/lib/ping-row"

type PingTableProps = { pings: PingRow[]; isFiltered: boolean; pingIntervalMs: number }

export const PingTable = ({ pings, isFiltered, pingIntervalMs }: PingTableProps) => {
  if (pings.length === 0) return <PingEmptyState isFiltered={isFiltered} pingIntervalMs={pingIntervalMs} />
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Time</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>HTTP</TableHead>
          <TableHead>Duration</TableHead>
          <TableHead>Response</TableHead>
          <TableHead>Error</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {pings.map((ping) => (
          <PingTableRow key={ping.id} ping={ping} />
        ))}
      </TableBody>
    </Table>
  )
}

const PingTableRow = ({ ping }: { ping: PingRow }) => (
  <TableRow className="relative">
    <TableCell>
      <Link
        href={`/pings/${ping.id}`}
        className="font-medium underline-offset-4 after:absolute after:inset-0 hover:underline"
      >
        <LocalTime isoTime={ping.createdAt} />
      </Link>
    </TableCell>
    <TableCell>
      <PingStatusBadge error={ping.error} />
    </TableCell>
    <TableCell>
      <span className="tabular-nums">{formatStatusCode(ping.statusCode)}</span>
    </TableCell>
    <TableCell>
      <span className="tabular-nums">{formatDuration(ping.durationMs)}</span>
    </TableCell>
    <TableCell>
      <ResponseKindBadge responseKind={ping.responseKind} />
    </TableCell>
    <TableCell>
      <span title={ping.error ?? undefined} className="block max-w-xs truncate text-muted-foreground">
        {ping.error ?? "—"}
      </span>
    </TableCell>
  </TableRow>
)

const PingEmptyState = ({ isFiltered, pingIntervalMs }: { isFiltered: boolean; pingIntervalMs: number }) => (
  <Empty>
    <EmptyHeader>
      <EmptyMedia variant="icon">{isFiltered ? <SearchXIcon /> : <ActivityIcon />}</EmptyMedia>
      <EmptyTitle>{isFiltered ? "No pings match these filters" : "No pings yet"}</EmptyTitle>
      <EmptyDescription>
        {isFiltered
          ? "Try a wider date range or turn off “Failed only”."
          : `The server sends its first ping ${formatPingInterval(pingIntervalMs)} after it starts. It will show up here.`}
      </EmptyDescription>
    </EmptyHeader>
  </Empty>
)
