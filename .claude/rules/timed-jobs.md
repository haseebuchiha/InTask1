---
paths:
  - "src/jobs/**"
  - "src/instrumentation.ts"
---

# Timed job rules

These cover the 5-minute ping timer, the daily summary check and Next's startup file. The main rules are in `AGENTS.md`.

- `instrumentation.ts` is Next's required name for its startup file. It only calls clearly named functions, like `startPingTimer` from `jobs/`.
- Its `register()` does nothing unless `process.env.NEXT_RUNTIME === "nodejs"`, because Next also calls it for the edge runtime. Next swaps that check in at build time, so it stays in `instrumentation.ts` and doesn't go through `config/env.ts`.
- Its `onRequestError` sends every uncaught server error to the logger.
- The timer is a plain `setInterval` running every `PING_INTERVAL_MS`, which defaults to 5 minutes. There's no scheduling library.
- Each run has two steps. `recordPing` saves the ping and logs it. Then `reportIncidentForPing(ping)` from `services/incidents.ts` checks the saved ping for an incident and, when it finds one, asks the model for a report.
- The second step is isolated. It runs in its own try/catch, so a failed incident check is logged with the ping's id and never touches the saved ping or its log line. If `recordPing` throws, there's no incident check. Never call the model inside `recordPing`. The incident rules are in `.claude/rules/llm.md`.
- The httpbin request has a 30-second timeout, and the report's model call a 20-second one, so a run takes at most about 50 seconds and one run can't overlap the next. That only holds while `PING_INTERVAL_MS` is above 50000.
- There's no ping at startup. The first one comes one interval after the server starts.
- `register()` also calls `stopPingTimerAndStreamsOnShutdown()`. It listens once for `SIGTERM` and `SIGINT`, clears the timer and calls `shutDownPingStreams()` from `services/live-updates.ts`. The app then exits within milliseconds.
- A restart drops a ping that's still in flight, and nothing is saved for it. See decision 26 in `docs/decisions.md`.
- Each run catches its own errors. An unhandled error inside the interval would crash the whole app.
- The interval handle lives on `globalThis`. When `startPingTimer` runs again, it clears the old interval and starts a new one, so there's never a second timer. Next calls `register()` once per server, so in practice this only matters in tests.
- In development, `next dev` doesn't re-run `register()` when you edit a file. The timer keeps running the code it started with, so restart `pnpm dev` after changing the ping job or anything it calls.
- The ping job logs every run: status and duration when it works, the error when it doesn't. It also logs every incident it records, as a warning with the incident's id, its severity and its report status.
- A failed request is saved as a row too, so gaps and errors show up on the dashboard.
- Run exactly one instance of the app. A second copy would ping httpbin twice.

## The daily summary check

- `src/jobs/response-summary.ts` exports `startResponseSummaryTimer` and `stopResponseSummaryTimerOnShutdown`. `register()` calls both, after the ping timer's two.
- Every 5 minutes (`CHECK_INTERVAL_MS`, a constant, not a setting) it calls `summarizePreviousDayIfMissing()` from `services/response-analysis.ts`. That writes yesterday's UTC summary, covering the whole day, unless yesterday already has a `written`, `skipped_budget` or `failed` row. So the summary comes within 5 minutes after midnight UTC, and within 5 minutes of a restart that missed it. A `pending` row left by a crash is tried again. The job is the only writer of summaries.
- There's no check at startup, like the ping. When yesterday's row exists, the check only reads it.
- Each run catches its own errors and logs them. It logs a written summary as info, and a skipped or failed one as a warning, with the day and the tokens.
- The interval handle lives on `globalThis`, as `responseSummaryTimer`. Starting it again replaces the old interval. On `SIGTERM` or `SIGINT` it's cleared.
- A run makes at most one model call, bounded by the 20-second timeout, so runs never overlap.
