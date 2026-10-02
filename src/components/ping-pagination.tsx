import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react"
import { wholeNumberFormat } from "@/components/ping-formatting"
import { Button } from "@/components/ui/button"
import type { PingHistoryPage } from "@/lib/ping-row"

type Paging = Omit<PingHistoryPage, "pings">

type PingPaginationProps = {
  paging: Paging
  onPageChange: (page: number) => void
}

export const PingPagination = ({ paging, onPageChange }: PingPaginationProps) => {
  const { page } = paging
  const pageCount = countPages(paging)
  const goToPreviousPage = () => onPageChange(page - 1)
  const goToNextPage = () => onPageChange(page + 1)
  return (
    <nav aria-label="Pagination" className="flex flex-wrap items-center justify-between gap-2 text-sm">
      <p className="text-muted-foreground">{describeShownPings(paging)}</p>
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={goToPreviousPage} disabled={page <= 1}>
          <ChevronLeftIcon data-icon="inline-start" />
          Previous
        </Button>
        <span className="tabular-nums">
          Page {page} of {pageCount}
        </span>
        <Button variant="outline" size="sm" onClick={goToNextPage} disabled={page >= pageCount}>
          Next
          <ChevronRightIcon data-icon="inline-end" />
        </Button>
      </div>
    </nav>
  )
}

const countPages = ({ pageSize, totalCount }: Paging) => Math.max(1, Math.ceil(totalCount / pageSize))

const describeShownPings = ({ page, pageSize, totalCount }: Paging) => {
  const firstShown = (page - 1) * pageSize + 1
  if (firstShown > totalCount) return `${formatPingCount(totalCount)} in total`
  const lastShown = Math.min(page * pageSize, totalCount)
  return `Showing ${formatCount(firstShown)}–${formatCount(lastShown)} of ${formatPingCount(totalCount)}`
}

const formatPingCount = (count: number) => `${formatCount(count)} ${count === 1 ? "ping" : "pings"}`

const formatCount = (count: number) => wholeNumberFormat.format(count)
