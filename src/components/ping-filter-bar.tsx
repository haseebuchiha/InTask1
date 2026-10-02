import { debounce, type Options } from "nuqs"
import type { ChangeEvent } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import type { PingHistoryFilters } from "@/lib/ping-filters"

export type PingFilterChanges = Partial<PingHistoryFilters>

type PingFilterBarProps = {
  filters: PingHistoryFilters
  isFiltered: boolean
  onFiltersChange: (changes: PingFilterChanges, options?: Options) => void
}

export const PingFilterBar = ({ filters, isFiltered, onFiltersChange }: PingFilterBarProps) => {
  const changeFrom = (event: ChangeEvent<HTMLInputElement>) =>
    onFiltersChange({ from: startOfLocalDay(event.target.value) }, whileTyping)
  const changeTo = (event: ChangeEvent<HTMLInputElement>) =>
    onFiltersChange({ to: endOfLocalDay(event.target.value) }, whileTyping)
  const changeFailedOnly = (isChecked: boolean) => onFiltersChange({ failedOnly: isChecked })
  const clearFilters = () => onFiltersChange({ from: null, to: null, failedOnly: false })
  const fromDay = toDateInputValue(filters.from)
  const toDay = toDateInputValue(filters.to)
  return (
    <div className="flex flex-wrap items-end gap-4">
      <div className="flex flex-col gap-2">
        <Label htmlFor="ping-filter-from">From</Label>
        <Input
          id="ping-filter-from"
          type="date"
          value={fromDay}
          max={toDay || undefined}
          onChange={changeFrom}
          className="w-40"
        />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="ping-filter-to">To</Label>
        <Input
          id="ping-filter-to"
          type="date"
          value={toDay}
          min={fromDay || undefined}
          onChange={changeTo}
          className="w-40"
        />
      </div>
      <div className="flex h-8 items-center gap-2">
        <Switch id="ping-filter-failed-only" checked={filters.failedOnly} onCheckedChange={changeFailedOnly} />
        <Label htmlFor="ping-filter-failed-only">Failed only</Label>
      </div>
      {isFiltered && (
        <Button variant="ghost" onClick={clearFilters}>
          Clear filters
        </Button>
      )}
    </div>
  )
}

const startOfLocalDay = (day: string) => (day ? new Date(`${day}T00:00:00.000`) : null)

const endOfLocalDay = (day: string) => (day ? new Date(`${day}T23:59:59.999`) : null)

const toDateInputValue = (date: Date | null) => (date ? formatLocalDay(date) : "")

const formatLocalDay = (date: Date) =>
  `${padDigits(date.getFullYear(), 4)}-${padDigits(date.getMonth() + 1, 2)}-${padDigits(date.getDate(), 2)}`

const padDigits = (part: number, length: number) => String(part).padStart(length, "0")

const whileTyping: Options = { limitUrlUpdates: debounce(500) }
