import { LoaderCircleIcon, RadioIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import type { LiveConnectionStatus } from "@/hooks/use-refresh-on-new-ping"

const STATUS_LABELS: Record<LiveConnectionStatus, string> = {
  connecting: "Connecting…",
  live: "Live",
  reconnecting: "Reconnecting…",
}

const BADGE_VARIANTS = {
  connecting: "outline",
  live: "secondary",
  reconnecting: "destructive",
} as const satisfies Record<LiveConnectionStatus, string>

export const LiveStatusBadge = ({ connectionStatus }: { connectionStatus: LiveConnectionStatus }) => (
  <Badge role="status" variant={BADGE_VARIANTS[connectionStatus]}>
    {connectionStatus === "live" ? (
      <RadioIcon data-icon="inline-start" />
    ) : (
      <LoaderCircleIcon data-icon="inline-start" className="animate-spin" />
    )}
    <span className="sr-only">Live updates: </span>
    {STATUS_LABELS[connectionStatus]}
  </Badge>
)
