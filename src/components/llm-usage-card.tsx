import { LocalTime } from "@/components/local-time"
import { wholeNumberFormat } from "@/components/ping-formatting"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"

export type LlmUsage = {
  callsThisHour: number
  callsPerHour: number
  resetsAt: Date
  estimatedUsdToday: number
  cachedInputTokensToday: number
}

export const LlmUsageCard = ({ usage }: { usage: LlmUsage }) => (
  <Card size="sm">
    <CardHeader>
      <CardTitle>
        <h2>Model usage</h2>
      </CardTitle>
    </CardHeader>
    <CardContent>
      <div className="flex flex-col gap-1 sm:flex-row sm:flex-wrap sm:gap-x-6">
        <p className="font-medium tabular-nums">{`${usage.callsThisHour} of ${usage.callsPerHour} model calls this hour`}</p>
        {usage.callsThisHour > 0 && (
          <p className="text-muted-foreground">
            Resets at <LocalTime isoTime={usage.resetsAt.toISOString()} />
          </p>
        )}
        <p className="text-muted-foreground tabular-nums">{`About ${usdFormat.format(usage.estimatedUsdToday)} estimated today`}</p>
        {usage.cachedInputTokensToday > 0 && (
          <p className="text-muted-foreground tabular-nums">{`${wholeNumberFormat.format(usage.cachedInputTokensToday)} cached input tokens today`}</p>
        )}
      </div>
    </CardContent>
  </Card>
)

const usdFormat = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 4 })
