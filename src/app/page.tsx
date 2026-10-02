import { PingDashboard } from "@/components/ping-dashboard"
import { PING_INTERVAL_MS } from "@/config/env"
import { loadPingFilters } from "@/lib/ping-filters"
import { summarizeLlmUsage } from "@/services/llm"
import { listPingHistory } from "@/services/ping"
import { findLatestResponseSummary } from "@/services/response-analysis"

const Home = async ({ searchParams }: PageProps<"/">) => {
  const filters = await loadPingFilters(searchParams)
  const [pingPage, llmUsage, responseSummary] = await Promise.all([
    listPingHistory(filters),
    summarizeLlmUsage(),
    findLatestResponseSummary(),
  ])
  return (
    <PingDashboard
      pingPage={pingPage}
      pingIntervalMs={PING_INTERVAL_MS}
      llmUsage={llmUsage}
      responseSummary={responseSummary}
    />
  )
}

export default Home
