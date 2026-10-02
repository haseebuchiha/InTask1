# Ping Monitor

Ping Monitor sends a random JSON payload to [httpbin.org/anything](https://httpbin.org/anything) every 5 minutes, saves every reply in PostgreSQL, and shows the results on a dashboard that updates live.
When a ping fails or runs slow, it records an incident and asks a language model to explain it. A chat widget answers questions about the data through one read-only tool, and every reply is tagged in code and summarised once a day, all under an hourly model budget.
The dashboard at `/` is a table of pings, newest first, 20 to a page, with a date range and "Failed only" filter that live in the URL, a badge for the live connection, the Model usage card and yesterday's summary card. `/incidents` lists the 50 most recent incidents with the model's report, and `/pings/:id` and `/incidents/:id` show one row in full. The chat widget, a button bottom-right on every page, answers questions about the pings and incidents and shows the database queries behind each answer.

It's my answer to the BizScout full-stack take-home: one Next.js 16 app in one Node process, live at [ping-monitor.applyfast.tech](https://ping-monitor.applyfast.tech). The reasoning behind every choice is in [`docs/decisions.md`](docs/decisions.md), and this README links to it. The longer descriptions, of the API, the AI features, the costs and the deployment, are in [`docs/`](docs/) and listed under [More reading](#more-reading).

## The brief, and where it's built

| The brief asks for | Where it's built |
|---|---|
| A ping to httpbin.org/anything every 5 minutes, with a random JSON payload | `src/jobs/ping.ts`, a `setInterval` started from `src/instrumentation.ts`, runs `recordPing` in `src/services/ping.ts` |
| Store the responses | The `ping` table, through `src/models/ping.ts`. Failed pings are saved too |
| Broadcast to clients | `src/services/live-updates.ts`, served as server-sent events at `GET /api/pings/stream` |
| REST endpoints for historical data | `src/app/api/`: pings, incidents and the chat. See [`docs/api.md`](docs/api.md) |
| A responsive dashboard with live updates | `src/app/page.tsx` and `src/components/ping-dashboard.tsx`. Each new ping re-runs the page through `src/hooks/use-refresh-on-new-ping.ts` |
| A history table with filters and pages | `src/components/ping-table.tsx`, with the filters in the URL through nuqs (`src/lib/ping-filters.ts`) |
| AI, Option B: a chat widget over the data | `src/components/chat-widget.tsx`, `POST /api/chat` and `src/services/chat.ts`. See [Chat](docs/ai-features.md#chat) |
| AI: automatic incident reports | `src/services/incidents.ts` and the `/incidents` pages. See [Incidents](docs/ai-features.md#incidents) |
| AI: smart response analysis | Tags in `src/services/ping.ts`, the daily summary in `src/services/response-analysis.ts`. See [Response analysis](docs/ai-features.md#response-analysis) |
| AI: cost optimisation | `src/services/llm.ts`: token counts, the hourly cap, the answer cache, the usage card. See [Cost controls](docs/ai-features.md#cost-controls) and [`docs/cost-analysis.md`](docs/cost-analysis.md) |
| Tests and CI | `tests/` and `.github/workflows/ci.yml`. See [Testing](#testing) |
| README and database schema | This file, and [`prisma/schema.prisma`](prisma/schema.prisma) |
| Deployment | Live at [ping-monitor.applyfast.tech](https://ping-monitor.applyfast.tech): one `next start` under pm2, behind nginx with TLS and HTTP/2, on a VPS. See [Deployment](#deployment) and [`docs/deployment.md`](docs/deployment.md) |

## Running it locally

You need Node 24, pnpm 10 and PostgreSQL. CI uses Postgres 17, and the app was built on 17.4. `package.json` pins pnpm 10.6.5, so `corepack enable` gives you the right version.

```bash
pnpm install          # also generates the Prisma client
cp .env.example .env  # then set DATABASE_URL, like postgresql://USER:PASSWORD@localhost:5432/task1
createdb task1
pnpm db:migrate       # prisma migrate dev: applies prisma/migrations/
pnpm dev              # http://localhost:3000
```

Incident reports, chat answers and daily summaries need a model. There are two ways to reach one:

- **A local proxy, the default.** Any OpenAI-compatible endpoint at `LLM_BASE_URL` that serves the Responses API, `/v1/responses`. The default, `http://localhost:10531/v1`, is the `openai-oauth` proxy.
- **The Vercel AI Gateway.** Set `AI_GATEWAY_API_KEY`, and every call goes through the gateway to `openai/` plus `LLM_MODEL`. The startup log says which path is in use ([decision 55](docs/decisions.md#55-the-ai-gateway-when-its-key-is-set-the-proxy-otherwise)).

With neither, the app still runs. Incidents are still detected and saved, with the report marked `failed`. The chat answers "An error occurred." with a Retry button, and cached answers and refusals still work. The tests never call a model.

- **There's no ping at startup.** The first comes one interval after the server starts. Set `PING_INTERVAL_MS="30000"` to get one every 30 seconds.
- **Another port:** `PORT=3107 pnpm dev`. `pnpm dev --port 3107` doesn't work, because `pnpm dev` pipes Next's output through pino-pretty, and the flag lands there.
- **After changing a timer job,** restart `pnpm dev`. Next doesn't re-run its startup file on edits.

`src/config/env.ts` is the only file that reads these settings. It checks them with Zod at startup, and stops with a clear message if one is wrong.

| Setting | Default | What it does |
|---|---|---|
| `DATABASE_URL` | Required | The Postgres connection URL |
| `LOG_LEVEL` | `info` | pino's level, from `fatal` to `trace`, or `silent` |
| `PING_INTERVAL_MS` | `300000` | Time between pings, a whole number of milliseconds above 0 |
| `LLM_BASE_URL` | `http://localhost:10531/v1` | The OpenAI-compatible endpoint, used when `AI_GATEWAY_API_KEY` is empty |
| `LLM_API_KEY` | `not-needed` | The bearer token for `LLM_BASE_URL`. The proxy ignores it, but the AI SDK needs one |
| `LLM_MODEL` | `gpt-5.5` | The model for reports, chat answers and summaries |
| `LLM_CALLS_PER_HOUR` | `20` | The most model calls in any trailing hour, shared by all three |
| `AI_GATEWAY_API_KEY` | empty | When set, every model call goes through the Vercel AI Gateway instead |

| Command | What it does |
|---|---|
| `pnpm dev`, `pnpm build`, `pnpm start` | The dev server with readable logs, a production build, the production server |
| `pnpm test`, `pnpm test:coverage` | Every test once, and the same with a coverage report in `coverage/` |
| `pnpm lint` | ESLint, then the Prisma schema checks (`pnpm lint:prisma`). Every rule is an error |
| `pnpm format`, `pnpm format:check` | Formats with Biome, or only checks, as CI does |
| `pnpm exec next typegen && pnpm exec tsc --noEmit` | Type-checks, as CI does |
| `pnpm db:migrate` | Creates and applies migrations with `prisma migrate dev` |

## Architecture

```
prisma/                  schema.prisma, the five tables, and migrations/, their history
src/
  instrumentation.ts     Next's startup file: starts both timers, logs uncaught errors
  app/                   pages and API routes only
  jobs/                  the ping timer, and the daily summary check
  services/              every process and every decision
    ping.ts              recordPing: payload, httpbin, response kind, save, broadcast
    live-updates.ts      the better-sse channel every open tab listens on
    incidents.ts         detection, the incident row and its report
    response-analysis.ts the day's statistics and its summary
    chat.ts              sessions, the answer cache and the queryDatabase tool
    llm.ts               the only file that talks to the model: calls, tokens, budget, cost
  models/                database reads and writes, one file per table, the only importers of Prisma
  db/client.ts           the one Prisma client
  config/                env.ts, the only reader of settings, and logger.ts, the one pino logger
  lib/                   small shared pieces: the filters, id checks, the chat's query schema
  components/, hooks/    the screen, and browser state like the live connection
tests/                   the same folders as src/
```

**How a request flows.**

1. Something enters the app: a page, an API route or a timer job.
2. It calls one service function. That function is the whole process, written as a list of steps.
3. Each step is a helper in the same file, a model function for the database, or a function from another service.
4. Models only talk to the database. Pages, routes and jobs never call them directly.
5. The result goes back to the caller: a page passes it to components, a route returns it as JSON.

**Layers.** Folders are split by what the code does, the way Rails does it ([decisions 7](docs/decisions.md#7-organise-code-by-what-it-does-the-way-rails-does) and [8](docs/decisions.md#8-services-run-the-process-models-only-touch-the-database)). Calls only go down or sideways, ESLint enforces it ([decision 20](docs/decisions.md#20-lint-enforces-the-architecture)), and every server file starts with `import "server-only"`, so the build fails if browser code imports one. Pages read on the server: they call services directly, and nuqs keeps the filters in the URL, so there's no client data library and no global store ([decisions 9](docs/decisions.md#9-the-dashboard-reads-on-the-server-and-api-routes-are-for-outside-callers) and [10](docs/decisions.md#10-keep-the-tables-filters-and-pages-in-the-url-with-nuqs)). The chat widget is the one exception: it calls the chat routes from the browser ([decisions 40](docs/decisions.md#40-the-browser-calls-one-api-route-for-the-chat) and [53](docs/decisions.md#53-the-chat-is-a-floating-widget-not-a-page)).

**The timer.** A plain `setInterval`, started from Next's startup file, pings every `PING_INTERVAL_MS`, and a second one checks every 5 minutes whether yesterday has its summary; there's no scheduler and no worker ([decision 3](docs/decisions.md#3-start-the-5-minute-timer-from-instrumentationts)). Each run saves the ping first, then checks it for an incident in its own try/catch, so a broken check or model never loses a ping.

**The live stream.** `GET /api/pings/stream` holds a server-sent events stream open to each tab with better-sse, and each new ping or incident goes out as an event on that channel and makes the browser re-run the page, so the server re-renders it with its current filters and the browser never merges rows itself ([decisions 6](docs/decisions.md#6-push-live-updates-with-better-sse), [27](docs/decisions.md#27-refresh-the-page-on-every-new-ping) and [35](docs/decisions.md#35-send-incidents-as-an-incident-event-on-the-same-channel)). Saving comes first: a failed broadcast is logged, and the ping still succeeds ([decision 22](docs/decisions.md#22-a-broken-broadcast-never-fails-a-ping)).

**The database.** Five tables, in [`prisma/schema.prisma`](prisma/schema.prisma): `ping`, `incident`, `response_summary`, `chat_session` and `message`. Each has an `id` and an indexed `created_at`, and every database session runs in UTC ([decision 21](docs/decisions.md#21-run-every-database-session-in-utc)). The migrations are in [`prisma/migrations/`](prisma/migrations/): `pnpm db:migrate` applies them locally, and `prisma migrate deploy` in CI and production.

## Technology choices

| Tool | Why | Decision |
|---|---|---|
| Next.js 16 (App Router), React 19, TypeScript | The brief prefers React or Next.js. The dashboard, the API, the timer and the stream ship as one app | [1](docs/decisions.md#1-start-from-create-next-app) |
| One long-lived Node process, under pm2 and nginx on a VPS | The timer and the open streams need a process that stays up. pm2 restarts it, and nginx serves it over HTTP/2 | [2](docs/decisions.md#2-run-on-a-long-lived-server-not-serverless), [26](docs/decisions.md#26-on-shutdown-stop-the-timer-and-close-every-stream) |
| A plain `setInterval`, from `instrumentation.ts` | No worker or cron service to run. The request timeout keeps runs apart | [3](docs/decisions.md#3-start-the-5-minute-timer-from-instrumentationts) |
| PostgreSQL with Prisma 7 | Fixed fields in indexed columns, the payload and reply in `jsonb`, and every query plain SQL. Typed queries and migrations in the repo | [5](docs/decisions.md#5-prisma-with-postgresql), [14](docs/decisions.md#14-pin-prisma-to-version-7) |
| Server-sent events with better-sse | Data only flows to viewers. An ordinary route, and no client package. It replaced a Socket.IO plan | [4](docs/decisions.md#4-push-live-updates-with-socketio), [6](docs/decisions.md#6-push-live-updates-with-better-sse) |
| nuqs | Filters live in the URL, and one definition serves the page and the API | [10](docs/decisions.md#10-keep-the-tables-filters-and-pages-in-the-url-with-nuqs) |
| Zod | Checks the settings, ids, the chat's body, the model's reports and its query arguments | [11](docs/decisions.md#11-zod-for-checking-input-and-settings) |
| pino | One line of JSON per log, which pm2 captures | [12](docs/decisions.md#12-pino-for-logging) |
| The AI SDK 7 on the Responses API, and gpt-tokenizer | Schema-checked output, streaming, tools and a mock model for tests. The local proxy drops the schema on chat completions. gpt-tokenizer counts a prompt's tokens before it's sent | [29](docs/decisions.md#29-the-ai-sdk-for-model-calls), [30](docs/decisions.md#30-the-responses-api-not-chat-completions) |
| The Vercel AI Gateway, optional | A provider for a deployed app, used when its key is set | [55](docs/decisions.md#55-the-ai-gateway-when-its-key-is-set-the-proxy-otherwise) |
| A floating widget in the layout, with `useChat` and one streaming route | The brief asks for a chat widget, and in the layout it keeps its conversation across pages. The chat is the one feature with user input, and a route can be tested with curl | [40](docs/decisions.md#40-the-browser-calls-one-api-route-for-the-chat), [53](docs/decisions.md#53-the-chat-is-a-floating-widget-not-a-page) |
| AI Elements, shadcn and Streamdown | The chat's scroll, query blocks and streamed markdown. AI Elements' Radix-only parts are swapped for shadcn's Base UI ones | [43](docs/decisions.md#43-build-the-chat-screen-from-ai-elements-shadcn-and-streamdown) |
| Tailwind CSS 4, shadcn/ui on Base UI | We own the component code, and Base UI is shadcn's current default | [13](docs/decisions.md#13-shadcnui-on-base-ui) |
| Vitest, Testing Library and happy-dom | One runner for the server and the screen. happy-dom runs on our Node version, and jsdom doesn't | [17](docs/decisions.md#17-happy-dom-for-component-tests) |
| ESLint 9, strict | Naming, function size, no comments and the layer rules all fail lint | [15](docs/decisions.md#15-strict-lint-rules-checked-after-every-edit), [16](docs/decisions.md#16-the-code-style-rules), [19](docs/decisions.md#19-lint-the-database-schema-and-the-screens-too), [20](docs/decisions.md#20-lint-enforces-the-architecture), [51](docs/decisions.md#51-constants-in-capitals-at-the-top) |
| Biome, as the formatter only | One fast formatter on every edit. ESLint stays the one linter | [50](docs/decisions.md#50-biome-formats-the-code) |
| GitHub Actions | Format, lint, types, tests with coverage and a build, against a real Postgres | [24](docs/decisions.md#24-ci-with-github-actions) |

## Testing

**Strategy.** Server tests run against the real Postgres in `DATABASE_URL` and stub only `fetch`, so httpbin is never called. No test calls a model either: the model layer's and the chat's tests use the AI SDK's mock model, and the incident and summary tests mock the model layer. Tests that seed rows use far-off dates of their own, so they never meet real pings, and each deletes only what it wrote. Component tests run in happy-dom, with a fake `EventSource` and a stubbed `fetch`. There's no browser end-to-end test yet: one integration test covers the critical flow on the server, and the component tests cover what a viewer does.

**The core parts.** The brief asks to name the core parts and test one thoroughly. They are: recording a ping (`recordPing` and the broadcast), reading history (the filters, pages and REST endpoints), live delivery (the stream route and the browser hook), and the dashboard. **Recording a ping is the one tested thoroughly** ([decision 23](docs/decisions.md#23-the-ping-recording-process-is-the-core-component-we-test-thoroughly)). Everything else only reads what it writes, so if it saves the wrong thing, every other part shows wrong data. Its failures are quiet and hard to cause by hand: httpbin slow or down, a timeout, a reply that isn't JSON. Each must still produce a row, and tests force every case. An integration test runs one timer tick end to end: httpbin stubbed, the row in Postgres, the same row on an open stream. `src/services/ping.ts` and `src/services/live-updates.ts` are at 100% of lines and branches, and so is `src/services/llm.ts`, because it guards the budget.

**435 tests in 33 files**, grouped by area:

| Area | Files in `tests/` | Tests | What it covers |
|---|---|---|---|
| Recording a ping, the core | `services/ping`, `services/live-updates`, `jobs/ping`, `integration/ping-flow` | 57 | The payload, the request, every kind of failure, saving, response kinds and origin, the broadcast and broken viewers, the timer, one tick end to end |
| History and the database | `api/pings`, `api/incidents`, `lib/ping-filters`, `models/ping`, `models/incident`, `db/client` | 54 | Every filter and page against real Postgres, 400s and 404s, the 50-incident list, UTC sessions |
| The model layer and incidents | `services/llm`, `services/llm-provider`, `services/incidents` | 58 | Calls with a mock model, the step, time and token limits, one attempt only, the budget, prices with the cached rate, the provider the settings pick, the detection lines, every report status |
| The chat, on the server | `services/chat`, `lib/chat-query`, `lib/chat-session-id`, `api/chat`, `models/message` | 110 | The tool on real rows, accepted and rejected queries, the 8000-character cut, follow-ups, Stop and disconnects, forged token counts, the cache, both refusals, sessions, bad bodies |
| Response analysis | `services/response-analysis`, `jobs/response-summary`, `models/response-summary` | 34 | Every statistic on a seeded day, the prompt, each status, yesterday's check and its timer, saving and reading a day |
| The chat screen | `components/chat-screen`, `components/chat-widget` | 38 | Query blocks, token lines, Stop, Retry, suggestions, sessions with the real `useChat`, the history menu, the pulsing dot |
| The other screens | 9 files in `components/`, and `hooks/use-refresh-on-new-ping` | 84 | The dashboard and its date filters in a pinned non-UTC zone, the summary and usage cards, ping and incident pages, the nav, the error page, the live hook's refresh and retry |

Run them with `pnpm test`, or `pnpm test:coverage` for a report in `coverage/`. They need the migrated database from [Running it locally](#running-it-locally). The last coverage run covered 91.86% of lines and 86.81% of branches overall, and 100% of lines and branches in the services, models, API routes, jobs and `src/lib/`. What's left is mostly code only Next runs, like the server pages, the layout and `instrumentation.ts`, and files copied from shadcn and AI Elements.

**CI.** [`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs on every push and pull request. With Postgres 17 and Node 24, it runs `pnpm install --frozen-lockfile`, `pnpm format:check`, `pnpm exec prisma migrate deploy`, `pnpm lint`, `pnpm exec next typegen` and `pnpm exec tsc --noEmit`, `pnpm test:coverage` and `pnpm build`, then uploads `coverage/`.

## Assumptions

- **"Every 5 minutes" counts from server start.** There's no ping at startup, so restarts and deploys don't add pings off the schedule. A restart drops a ping in flight, and the new process pings one interval after it starts ([decision 26](docs/decisions.md#26-on-shutdown-stop-the-timer-and-close-every-stream)).
- **The payload goes as the JSON body of a POST**, which httpbin's `/anything` echoes back. Each has a random UUID, three random words, one to three tags, a priority from 1 to 5, a yes/no flag and a nested sensor reading.
- **"Store the response data" means the whole reply**: httpbin's body as JSON, the status code, the duration until the reply is fully read, any error, and the payload we sent.
- **A ping fails on an error status, a 30-second timeout or a network error**, and failed pings are saved as rows, so gaps show on the dashboard.
- **"Historical data" means a paged list and a single ping.** Filters weren't asked for. We added a date range and "failed only", because that's what someone reading ping history needs.
- **Nobody needs to log in.** The dashboard only shows data, and the payloads are random test data ([decision 18](docs/decisions.md#18-no-login)). So anyone who can reach the site can spend the hour's model calls, and incident reports in that hour are then skipped ([decision 40](docs/decisions.md#40-the-browser-calls-one-api-route-for-the-chat)).
- **One server is enough** for a ping every 5 minutes and a handful of viewers, and it runs as exactly one instance. The timer and every open stream live in one process's memory, so a second copy would ping twice and each viewer would only hear from the copy they connected to. Times are stored in UTC and shown in each viewer's time zone.
- **"Deploy to any free platform" allows a VPS.** A serverless free tier can't keep a timer running or hold streams open. See [Deployment](#deployment).
- **A cached answer can be an hour old.** Asked again within the hour, "how many pings failed in the last hour?" gets the earlier answer, even if the numbers have moved.
- **The tests share your database.** They clean up after themselves, but they run against whatever `DATABASE_URL` points at, so use a development database.

## Future improvements

- **The open points of the AI work**, listed in [`docs/plan-llm-insights.md`](docs/plan-llm-insights.md): a usage endpoint, tuning the 6000-token limit, checking the gateway and prompt caching with a real key ([decision 55](docs/decisions.md#55-the-ai-gateway-when-its-key-is-set-the-proxy-otherwise)), closing the cap's gap for parallel chats, which pass the check together because an answer is only counted once it's saved ([decision 32](docs/decisions.md#32-keep-the-model-budget-in-tables-not-memory)), refreshing the Incidents page only on `incident` events, fixing the usage card, which says the budget resets now when the hour had no calls, and retrying yesterday's summary after `skipped_budget` or `failed`, among others.
- **The git repo and a pre-commit hook**, with `simple-git-hooks` running `pnpm lint` before each commit ([decision 24](docs/decisions.md#24-ci-with-github-actions)).
- **A browser end-to-end test**, for example with Playwright: open the dashboard, watch a live row arrive, filter, open a ping.
- **Keeping the tables small**, by deleting or summarising old rows. They only grow today, by 288 pings a day at the default interval.
- **Alerts** when pings keep failing.
- **More than one instance**, by moving the timer to one scheduler and passing new rows between instances, for example with Postgres `LISTEN`/`NOTIFY`.

## Deployment

The app is live at [https://ping-monitor.applyfast.tech](https://ping-monitor.applyfast.tech), on a VPS that already hosts other things, so it shares the box's nginx, Postgres 17 and the `openai-oauth` proxy. It runs as one `next start` under pm2, in fork mode with exactly one instance, behind nginx with TLS and HTTP/2, and Postgres is reached over loopback on the same machine. It's a VPS and not a serverless free tier because the timer and the open streams need a process that stays up ([decision 2](docs/decisions.md#2-run-on-a-long-lived-server-not-serverless)). The install commands, the nginx and pm2 settings and the update procedure are in [`docs/deployment.md`](docs/deployment.md).

## More reading

- [`docs/decisions.md`](docs/decisions.md): every choice, why we made it, and what we turned down.
- [`docs/api.md`](docs/api.md): every endpoint, its parameters and errors, and how to ask the chat with curl.
- [`docs/ai-features.md`](docs/ai-features.md): how incidents, the chat, response analysis and the cost controls work.
- [`docs/cost-analysis.md`](docs/cost-analysis.md): measured model calls and their estimated cost, the ceilings at the cap, and provider prompt caching.
- [`docs/deployment.md`](docs/deployment.md): the runbook for the VPS, from the install commands to the nginx and pm2 settings.
- [`docs/plan-llm-insights.md`](docs/plan-llm-insights.md): what's still open from the AI work.
- [`AGENTS.md`](AGENTS.md): how the code is organised and written. It's the working instructions for the AI coding agent used on the project, so it reads as rules, not as a guide.
- [`.claude/rules/`](.claude/rules/): the agent's rules for each area, from the database to the model layer.
