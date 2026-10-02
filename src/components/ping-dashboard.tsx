"use client"

import { type Options, useQueryStates } from "nuqs"
import { useTransition } from "react"
import { LiveStatusBadge } from "@/components/live-status-badge"
import { type LlmUsage, LlmUsageCard } from "@/components/llm-usage-card"
import { PingFilterBar, type PingFilterChanges } from "@/components/ping-filter-bar"
import { formatPingInterval } from "@/components/ping-formatting"
import { PingPagination } from "@/components/ping-pagination"
import { PingTable } from "@/components/ping-table"
import { ResponseSummaryCard } from "@/components/response-summary-card"
import { Spinner } from "@/components/ui/spinner"
import { useRefreshOnNewPing } from "@/hooks/use-refresh-on-new-ping"
import { type PingHistoryFilters, pingFilterParsers } from "@/lib/ping-filters"
import type { PingHistoryPage } from "@/lib/ping-row"
import type { LatestResponseSummary } from "@/lib/response-summary"

type PingDashboardProps = {
  pingPage: PingHistoryPage
  pingIntervalMs: number
  llmUsage: LlmUsage
  responseSummary: LatestResponseSummary | null
}

export const PingDashboard = ({ pingPage, pingIntervalMs, llmUsage, responseSummary }: PingDashboardProps) => {
  const [isLoadingPings, startTransition] = useTransition()
  const [filters, setFilters] = useQueryStates(pingFilterParsers, { shallow: false, history: "push", startTransition })
  const changeFilters = (filterChanges: PingFilterChanges, urlUpdateOptions?: Options) =>
    setFilters({ ...filterChanges, page: 1 }, urlUpdateOptions)
  const changePage = (page: number) => setFilters({ page })
  const connectionStatus = useRefreshOnNewPing()
  const isFiltered = hasActiveFilters(filters)

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight">Ping Monitor</h1>
          <p className="text-sm text-muted-foreground">
            {`The server sends a random JSON payload to httpbin.org every ${formatPingInterval(pingIntervalMs)} and saves the reply. Newest first.`}
          </p>
        </div>
        <LiveStatusBadge connectionStatus={connectionStatus} />
      </header>
      <ResponseSummaryCard summary={responseSummary} />
      <LlmUsageCard usage={llmUsage} />
      <div className="flex flex-wrap items-end justify-between gap-4">
        <PingFilterBar filters={filters} isFiltered={isFiltered} onFiltersChange={changeFilters} />
        {isLoadingPings && (
          <p className="flex h-8 items-center gap-2 text-sm text-muted-foreground">
            <Spinner />
            Loading pings…
          </p>
        )}
      </div>
      <section
        aria-label="Ping history"
        aria-busy={isLoadingPings}
        className="flex flex-col gap-4 transition-opacity aria-busy:opacity-60"
      >
        <PingTable pings={pingPage.pings} isFiltered={isFiltered} pingIntervalMs={pingIntervalMs} />
        <PingPagination paging={pingPage} onPageChange={changePage} />
      </section>
    </div>
  )
}

const hasActiveFilters = ({ from, to, failedOnly }: PingHistoryFilters) => failedOnly || from !== null || to !== null
