import type { ResponseSummary } from "@/db/generated/browser"

export type RelativeDay = "yesterday" | "earlier"

export type LatestResponseSummary = ResponseSummary & { relativeDay: RelativeDay }
