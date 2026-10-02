---
paths:
  - "src/app/api/pings/stream/**"
  - "src/services/**"
  - "src/hooks/**"
  - "src/jobs/**"
  - "src/instrumentation.ts"
---

# Live update rules

These cover how new pings and incidents reach open dashboards. The main rules are in `AGENTS.md`, including "Running in production".

- New pings and incidents reach the browser as server-sent events: a one-way stream from one API route, `src/app/api/pings/stream/route.ts`, built with better-sse. The browser listens with its built-in `EventSource`. There's no client package.
- Keep the better-sse channel on `globalThis`, never in a module-level export. Next loads `instrumentation.ts` and route code as separate copies of the same module. An exported channel would give each copy its own channel, and broadcasts would reach nobody.
- Only the broadcasting service sends events. Only one hook listens for them: `useRefreshOnNewPing` in `src/hooks/use-refresh-on-new-ping.ts`.
- The one channel carries two event names, `ping` and `incident`. A `ping` event's data is one `PingRow` from `src/lib/ping-row.ts`: the same seven fields as a row from `GET /api/pings`, including `responseKind` and `origin`. A new daily summary isn't broadcast: the next ping's refresh shows it. An `incident` event's data is the saved `Incident` row, sent by `broadcastIncident` once its report is written, skipped or failed. Our dashboard ignores the data. It's there for outside callers.
- `recordPing` saves the row before it broadcasts. A broadcast that throws is logged with the ping's id and never fails the ping. `reportIncidentForPing` does the same with an incident: it saves the row and its report first, and a broadcast that throws is logged with the incident's id.
- One viewer's broken connection must not reach the others. Each viewer's stream gets its own end signal, which fires only after better-sse has started the session, so writes to a viewer who left can't turn into unhandled rejections. `tests/services/live-updates.test.ts` guards this.
- That means we own the cleanup when a viewer disconnects, because better-sse doesn't handle it. A small `pnpm patch` of better-sse, plus an issue upstream, could replace our workaround later.
- Keep-alive stays on. Pings arrive 5 minutes apart, and nginx closes a connection that goes quiet for too long. better-sse sends one every 10 seconds.
- The stream route sets `X-Accel-Buffering: no` itself. better-sse sends it by default, and we set it explicitly anyway.
- Streams send `Connection: close`. Without it, Chrome reused the kept-alive connection for its reconnect after a restart, reached the dying server, and the page refresh after it hit a dead server.
- On shutdown, `shutDownPingStreams()` sets `isShuttingDown` on `globalThis` and ends every session in the channel's `activeSessions`. After that, a stream request gets a 503 with `Connection: close`. Open tabs show Reconnecting…, then go Live once the new process answers. The timer side is in `.claude/rules/timed-jobs.md`.
- The stream route exports `dynamic = "force-dynamic"`, or `next build` tries to prerender it. If Cache Components is turned on, swap it for `await connection()`.
- On every `ping` or `incident` event, the hook calls `router.refresh()`, and the server re-renders the page with the current filters and page. The browser never inserts, filters or dedupes rows itself. The dashboard never calls the history endpoint.
- On any stream error, the hook closes the `EventSource`, shows Reconnecting, and opens a new one after 5 seconds (`RECONNECT_DELAY_MS`). When that one opens, it calls `router.refresh()` to fill any gap, and shows Live. This also covers an HTTP error, like nginx's 502 during a restart, after which a plain `EventSource` gives up for good.
- The hook returns only the connection status. `LiveStatusBadge` shows it as Connecting, Live or Reconnecting.
- Restarting `next dev` reloads the whole page, so in development you can only see the reconnect path by cutting the network while the server stays up.
- better-sse is small and still before 1.0 (0.16.1). We use a small part of it: `createChannel`, `createResponse`, `register`, `broadcast`, the channel's `activeSessions`, and a session's `getResponse` and `state`. Each session's `state` holds its viewer connection, so shutdown can end it. If it stalls, replacing it is about 20 lines.
