import { createLoader, type inferParserType, parseAsBoolean, parseAsInteger, parseAsIsoDateTime } from "nuqs/server"

export const PING_PAGE_SIZE = 20

export type PingHistoryFilters = inferParserType<typeof pingFilterParsers>

export const pingFilterParsers = {
  page: parseAsInteger.withDefault(1),
  from: parseAsIsoDateTime,
  to: parseAsIsoDateTime,
  failedOnly: parseAsBoolean.withDefault(false),
}

export const loadPingFilters = createLoader(pingFilterParsers)
