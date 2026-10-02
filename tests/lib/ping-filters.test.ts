import { describe, expect, test } from "vitest"
import { loadPingFilters } from "@/lib/ping-filters"

const DEFAULT_FILTERS = { page: 1, from: null, to: null, failedOnly: false }

describe("ping filters", () => {
  test("reads a page from searchParams given as a promise, the way a Next page receives them", async () => {
    await expect(loadPingFilters(Promise.resolve({ page: "2", failedOnly: "false" }))).resolves.toStrictEqual({
      ...DEFAULT_FILTERS,
      page: 2,
    })
  })

  test("falls back to the defaults for invalid values outside strict mode", () => {
    expect(loadPingFilters("?page=abc&from=notadate&to=nope&failedOnly=maybe")).toStrictEqual(DEFAULT_FILTERS)
  })
})
