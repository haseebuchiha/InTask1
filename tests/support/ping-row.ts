import type { PingRow } from "@/lib/ping-row"

export const buildPingRow = (id: number, overrides: Partial<PingRow> = {}): PingRow => ({
  id,
  createdAt: "2026-09-30T12:00:00.000Z",
  statusCode: 200,
  durationMs: 300,
  error: null,
  responseKind: "clean_echo",
  origin: "203.0.113.7",
  ...overrides,
})
