import type { Ping } from "@/db/generated/browser"

export type PingRow = Omit<Ping, "payload" | "response" | "createdAt"> & { createdAt: string }

export type PingHistoryPage = { pings: PingRow[]; totalCount: number; page: number; pageSize: number }
