<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# How this project is built

This app pings httpbin.org every 5 minutes, saves each response, and shows the results on a live dashboard. Each response is tagged in code by what came back, like a clean echo or a gateway error, and once a day the model writes a short summary of the day's responses from counts the code works out. When a ping fails or runs slow, it records an incident and asks a language model to explain it. A chat widget, on every page, answers questions about the pings and incidents, with the model reading the database through one read-only tool. This file records how the code is organised and written. Follow it for every change.

## Rules for specific areas

More rules live in `.claude/rules/`, one file per area. Before you create or edit files in an area, read its rule file. Claude Code loads a rule file by itself only when it reads a matching file, not when it creates a new one, and subagents may not get them at all.

- `.claude/rules/database.md`: the Prisma schema, models and the database client
- `.claude/rules/api-routes.md`: the REST endpoints
- `.claude/rules/timed-jobs.md`: the 5-minute ping timer and the startup file
- `.claude/rules/live-updates.md`: the live stream, from the broadcast to the browser hook
- `.claude/rules/screens.md`: pages, components, hooks and styling
- `.claude/rules/testing.md`: tests and test setup. Anyone writing a test, subagents included, loads the `mattpocock-skills:tdd` skill first, and proves each new, changed or deleted test by breaking the code on purpose
- `.claude/rules/llm.md`: the model layer, incident reports, the chat and the hourly budget

The reasons behind every choice are in `docs/decisions.md`.

## Tools

- Next.js 16 (App Router), React 19, TypeScript
- Tailwind CSS 4 and shadcn/ui (built on Base UI, not Radix) for the interface
- Prisma with PostgreSQL for the database
- Zod for checking environment variables, the ping and incident ids in the API routes and pages, the shape of the model's incident report, the chat's request body and session id, and the query arguments the model writes for the chat. The table's filters use nuqs's built-in parsers, so the filters ship no Zod to the browser.
- pino for logging
- nuqs for the table's filters and pages. They live in the URL, and the same definitions are read by the page and checked by the API route.
- A plain `setInterval` for the 5-minute timer, no scheduling library. The httpbin request has a timeout, so one run can't overlap the next.
- better-sse for live updates, sent as server-sent events from an API route
- The AI SDK (`ai` 7 with `@ai-sdk/openai` 4 and `@ai-sdk/gateway` 4) for model calls. With `AI_GATEWAY_API_KEY` set, calls go through Vercel's AI Gateway to `openai/` plus `LLM_MODEL`. Without it, they go to the Responses API of an OpenAI-compatible endpoint at `LLM_BASE_URL`, which locally is the `openai-oauth` proxy. See decision 55.
- gpt-tokenizer to count a prompt's tokens before it's sent
- `@ai-sdk/react` 4 for `useChat`, the chat's browser hook, and its `Chat` class, which holds one conversation outside React so an answer keeps streaming while the panel is closed
- Streamdown for the markdown in chat answers, and shiki for the JSON in the chat's query blocks
- Vercel's AI Elements for parts of the chat screen: `conversation` (on `use-stick-to-bottom`), `tool`, `loader` and `code-block`, copied into `src/components/ai-elements/`. AI Elements is written for shadcn on Radix, and ours is on Base UI. So only Radix-free components were taken, and `tool.tsx` is patched for Base UI's `data-open`, `data-closed` and `data-panel-open` attributes. AI Elements' `message` and `prompt-input` use Radix's `asChild` and weren't taken: shadcn's own `message` and `bubble` cover them. See decision 43.
- pnpm for packages
- ESLint for linting
- Biome for formatting, with its linter off
- Vitest, Testing Library and happy-dom for tests, and GitHub Actions for CI
- pm2 and nginx to run it in production

## Folders

Each kind of code has one home, the way Rails does it. Folders are split by what the code does, not by feature.

```
prisma/
  schema.prisma      the database tables
  migrations/        the history of changes to those tables
prisma.config.ts     Prisma's connection settings
ecosystem.config.js  pm2's settings for production
deploy.sh            what CI runs on the server for each push to main: reset, install, migrate, build aside, swap, restart
biome.json           Biome's formatting settings, and the files it skips
docs/
  decisions.md       what we chose and why
  api.md             the REST endpoints, their parameters and errors, and the chat with curl
  ai-features.md     how incidents, the chat, response analysis and the cost controls work, for readers
  cost-analysis.md   measured model calls and their estimated cost, and the ceilings at the cap
  deployment.md      how the live copy runs on the VPS, and how to update it
  plan-llm-insights.md  what's still open from the AI work, which is built
tests/               tests, in the same folders as src/
src/
  app/               pages and API routes only
    layout.tsx       the root layout: the nav, the chat widget, the fonts
    page.tsx         the dashboard: the ping table with its filters, the summary card and the usage card
    pings/[id]/      one ping's page, with its payload and response
    incidents/       the Incidents page, and one incident at incidents/[id]
    error.tsx, global-error.tsx, not-found.tsx  Next's error and 404 pages
    api/pings/       GET /api/pings, GET /api/pings/:id, and GET /api/pings/stream, the live stream
    api/incidents/   GET /api/incidents and GET /api/incidents/:id
    api/chat/        POST /api/chat, the chat's streaming route; GET and POST /api/chat/sessions; GET /api/chat/sessions/:id
  services/          what the app does: every process and every decision
    ping.ts          the ping: builds the payload, calls httpbin, tags the response, saves the row, lists the history
    live-updates.ts  the server-sent events channel: broadcasts pings and incidents, opens and shuts down streams
    llm.ts           the only file that talks to the model: calls, token counts, budget, cost
    incidents.ts     spots a failed or slow ping, saves the incident, asks the model to explain it
    chat.ts          answers a chat question: sessions, the answer cache, the queryDatabase tool, saving the exchange
    response-analysis.ts  works out a day's response statistics in code and asks the model for the daily summary
  models/            database reads and writes, one file per table
    ping.ts          the ping table: create, list a page, averages, and the chat's read queries
    incident.ts      the incident table
    message.ts       the message table: the chat's questions and answers. The budget counts answers that reached the model
    chat-session.ts  the chat_session table, one row per conversation
    response-summary.ts  the response_summary table, one row per UTC day
  jobs/              work that runs on a timer
    ping.ts          the 5-minute ping timer, and the shutdown that clears it and ends the streams
    response-summary.ts  the check that writes yesterday's summary when it's missing
  db/
    client.ts        the one shared Prisma client
    generated/       code Prisma generates, not committed, not linted
  config/
    env.ts           the only file that reads environment variables
    logger.ts        the one shared pino logger
  components/        our own interface pieces
    ping-*.tsx       the dashboard, the ping table, its filter bar and pagination, one ping's details, and the shared badges and formatters
    local-time.tsx   shows a time in the browser's timezone, in UTC until the page hydrates
    live-status-badge.tsx  the Connecting, Live or Reconnecting badge
    incident-*.tsx   the incident list, one incident's page, and the report they share
    chat-*.tsx       the floating chat widget, the chat screen inside it, one message with its query blocks, and the recent-chats menu
    llm-usage-card.tsx  the dashboard card: model calls this hour and the estimated spend
    response-summary-card.tsx  the card at the top of the dashboard: the latest daily summary
    site-nav.tsx     the Dashboard and Incidents links, shown by the layout
    ui/              shadcn components, added with the shadcn CLI
    ai-elements/     components copied from Vercel's AI Elements, patched for Base UI. Vendored like ui/
  hooks/             browser-side state, including the live updates
    use-refresh-on-new-ping.ts  listens to the stream, re-runs the page on each event, and reports the connection status
    use-chat-conversation.ts  the widget's conversation: the stored session id, starting a session on the first question, loading and switching chats
  lib/               small helpers with no server or browser dependencies
    ping-filters.ts  the nuqs parsers for the table's filters and page, read by the page and the API route
    ping-id.ts       reads a ping id with Zod, shared by the route and the page
    ping-row.ts      the ping row type the table shows, and the history page type
    incident-id.ts   reads an incident id with Zod, shared by the route and the page
    chat-query.ts    the strict Zod schema for the model's query arguments, and a plain-words description of a query
    chat-request.ts  reads the chat route's body, and the chat's message and session types
    chat-session-id.ts  reads a chat session id: a plain token of 1 to 64 characters
    response-summary.ts  the latest summary's type for the card, with its `relativeDay`
  instrumentation.ts Next's required name for its startup file. It only calls clearly named functions, like `startPingTimer` from `jobs/`
```

## How a request flows

1. Something enters the app: an API route, a page, or a timed job.
2. It calls one service function. That function is the whole process.
3. The service runs its steps in order. Each step is one of these:
   - a small helper in the same service file, for a decision that belongs to this process
   - a model function, for anything that touches the database
   - a function from another service, for work that is reused elsewhere, like broadcasting
4. The result goes back to whatever called the service.

Code only calls downward or sideways, never upward:

- Pages, API routes and jobs call services. They never call models directly. They may read settings from `config/`, like the ping interval the dashboard shows.
- Models only talk to the database. They make no decisions and never call services.
- Only files in `models/` import the Prisma client.
- Services hold every decision. Nothing about the interface goes in services.
- Lint enforces these import rules. A page importing a model, or a component importing a server folder, fails `pnpm lint`.

## Model calls

- Only `services/llm.ts` talks to the model. It's the only file that imports the AI SDK providers or the tokenizer. Other services call its exports.
- `services/llm.ts` picks the provider once, when it loads: the AI Gateway when `AI_GATEWAY_API_KEY` is set, the endpoint at `LLM_BASE_URL` otherwise. No other file knows which one is active. Every call sends one shared set of OpenAI options plus its caller's `promptCacheKey`, like `ping-monitor-chat`. See decisions 55 and 56.
- Every model call's tokens are stored on the row it produced: `inputTokens`, `cachedInputTokens` (the part the provider's prompt cache served) and `outputTokens`. The cost estimate charges cached input at the cached price. See decision 56.
- Never call the model inside `recordPing`. The ping job runs `reportIncidentForPing` as a second step, in its own try/catch, so a slow or broken model can't lose or fail a ping.
- The incident row is saved, as `pending`, before the model is asked. A failed or slow ping always leaves an incident, even when the model is down or the hourly budget is spent.
- Severity is arithmetic. `services/incidents.ts` decides from the ping and its 24-hour average whether there's an incident and how bad it is. The model only explains.
- A ping's `responseKind` (`clean_echo`, `echo_mismatch`, `empty`, `client_error`, `gateway_error` or `failed`) and `origin` are decided in code inside `recordPing`. No model is asked about one ping's response.
- The daily summary is one model call a day. `services/response-analysis.ts` works out the day's statistics in code, as counts and percentiles, never rows, saves the row as `pending`, and only then asks the model to put the numbers into words. A summary always covers one whole UTC day, and only the job writes one. The dashboard page reads the latest one through the service, and no route serves summaries. See decision 54.
- The chat's model reads the database through one tool, `queryDatabase`. The model writes Prisma query arguments as JSON, never SQL. `execute` checks them with the strict schema in `src/lib/chat-query.ts`, and only the three read methods, `findMany`, `aggregate` and `groupBy`, exist to dispatch to. Never add a write method, raw SQL or a free-form string to the tool. See decision 39.
- The details, including the budget, the chat's rules and how tests stand in for the model, are in `.claude/rules/llm.md`.

## Writing a service

A service function reads like a list of steps. Each line's output feeds the next line.

```ts
export const recordPing = async () => {
  const payload = buildRandomPayload()
  const measurement = await measureHttpbinRequest(payload)
  const ping = await createPing({ payload, ...measurement, ...tagResponse(payload, measurement) })
  broadcastSavedPing(ping)
  return ping
}
```

`buildRandomPayload`, `measureHttpbinRequest`, `tagResponse` and `broadcastSavedPing` are helpers in the same file. `createPing` comes from `models/ping.ts`. `broadcastSavedPing` calls `broadcastPing` from another service. If the broadcast fails, it logs the error and the ping still succeeds, because the row is already saved.

Services are long modules. One service file holds a whole area of work: the few functions it exports, plus every small helper those functions use. Keep adding helpers to the same file. Don't split them out into new files. Export only what other code calls, and keep the rest private to the file. A long file with a small list of exports is the goal.

When a page or route needs a model read exactly as it is, the service re-exports it under its own name, like `export { findPingById } from "@/models/ping"` in `services/ping.ts`. Don't wrap it in a function that only forwards the call. A service function earns its place when it adds something, like the limit `listRecentIncidents` passes to `listIncidents`.

## Server code and browser code

- Every file in `services/`, `models/`, `jobs/`, `db/` and `config/` starts with `import "server-only"`. If browser code imports one of these files, the build fails.
- `config/env.ts` is the only file in `src/` that reads environment variables. It checks them with Zod when it loads and stops the app with a clear message if one is wrong. The exceptions are root config files like `prisma.config.ts`, and the `NEXT_RUNTIME` check in `instrumentation.ts`.
- Settings: `DATABASE_URL` (required), `LOG_LEVEL` (optional, defaults to `info`, and `silent` turns logs off), `PING_INTERVAL_MS` (optional, a whole number of milliseconds above 0, defaults to `300000`, which is 5 minutes), `LLM_BASE_URL` (optional, defaults to `http://localhost:10531/v1`), `LLM_API_KEY` (optional, defaults to `not-needed`, because the local proxy ignores it), `LLM_MODEL` (optional, defaults to `gpt-5.5`), `LLM_CALLS_PER_HOUR` (optional, a whole number above 0, defaults to `20`) and `AI_GATEWAY_API_KEY` (optional, empty by default; set, every model call goes through the AI Gateway). Add a new setting to both `config/env.ts` and `.env.example`.
- Pages run on the server. They get data by calling a service and pass it down to components.
- There's no client data library, like TanStack Query. The browser never fetches table data itself. Pages load rows on the server, filter and page changes re-run the page through nuqs, and each new ping or incident makes the browser re-run the page with `router.refresh()`.
- The chat widget is the one exception. It lives in the layout and fetches from the browser: `POST /api/chat/sessions` to start a session just before the first question, `GET /api/chat/sessions/:id` to load the stored conversation when the panel opens, `GET /api/chat/sessions` when the history menu opens, and `POST /api/chat`, through `useChat`, for every answer. The current session's id is kept in `localStorage` under `chat-session-id`. See decision 53.
- Interface logic stays on the browser side:
  - Components draw the screen.
  - Hooks hold browser state, like the live connection status.
  - Small display helpers, like turning `123` into `"123 ms"`, sit next to the component that uses them. Helpers that several components share live in `components/ping-formatting.tsx`.
- There's no login. The dashboard only shows data, and the brief doesn't ask for one. Anyone who can reach the chat can spend the model budget, and the hourly cap is what bounds it.

## API routes, not server actions

- The brief asks for REST endpoints for historical data. So we have API routes for pings and incidents, plus one route that streams new pings and incidents to open pages (see `.claude/rules/live-updates.md`).
- Our own pages don't call these. `page.tsx` calls the same services directly on the server. The endpoints are for outside callers, like a reviewer using curl, and for tests.
- The chat routes are the ones the browser calls. The chat is the one feature with user input, which is the revisit decision 9 asked for. `useChat` needs an HTTP endpoint that streams, and a route can also be called with curl and tested like the others. See decision 40.
- The chat widget calls all four: `POST /api/chat` for each answer, `POST /api/chat/sessions` to start a session before the first question, `GET /api/chat/sessions/:id` to load a conversation, and `GET /api/chat/sessions` for the history menu. There's no chat page, so nothing loads the chat on the server. See decision 53.
- An API route file stays thin: read the request, call one service, return the result.
- We don't use server actions. Most of the app only shows data, and the chat's one input goes through `POST /api/chat`.

## Running in production

- The app runs with plain `next start --hostname 127.0.0.1` under pm2, on the port in `PORT` (3210 on the live box, 3000 by default). There's no custom server. The pm2 settings are in `ecosystem.config.js`. The live copy is at https://ping-monitor.applyfast.tech, in `/opt/task1` on the VPS, with Postgres and the `openai-oauth` proxy on the same machine.
- Run exactly one instance of the app, in pm2's fork mode. The 5-minute timer and every open stream live in its memory.
- nginx must not buffer any route. A buffered stream sends events late and in batches. Pages stream their HTML, and the chat streams its answers, too. Set `proxy_buffering off` for the whole site.
- nginx serves the site over HTTP/2. Over HTTP/1.1 a browser allows only 6 connections to one site, and each open dashboard tab holds one.
- On `SIGTERM` or `SIGINT`, `stopPingTimerAndStreamsOnShutdown` in `jobs/ping.ts` clears the timer and calls `shutDownPingStreams`. That ends every open stream, and any later stream request gets a 503. Streams and the 503 send `Connection: close`, so a browser's reconnect opens a fresh connection to the new process. Next then finishes the page requests in flight, and the app exits in well under a second.
- pm2's `kill_timeout`, 10 seconds, is only a safety net.
- Pushes to `main` deploy through CI and `deploy.sh`: the workflow's `deploy` job runs it over SSH with a forced command. The build goes to `.next-build`, with `NEXT_DIST_DIR`, so the old `.next` keeps serving, and is swapped in before the restart. See decision 57.
- A restart drops a ping that's still in flight. Nothing is saved for it. The new process pings again one interval after it starts. Open tabs show Reconnecting…, then go Live.

## Logging

- pino is the one logger, in `src/config/logger.ts`. Server code imports it from there. `console` is banned by lint.
- Each of our logs is one line of JSON written to standard output. pm2 captures it into log files, so pino never touches files itself.
- For an uncaught server error, Next also prints its own multi-line `⨯ Error` block next to our JSON line. So not every line in the log is JSON.
- In development, `pnpm dev` pipes the output through pino-pretty to make it readable. Don't use pino's `transport` option. It runs in a separate thread that breaks under Next's bundler.
- Because of that pipe, `pnpm dev --port 3107` sends the port to pino-pretty, not Next. Use `PORT=3107 pnpm dev` instead.
- `onRequestError` in `src/instrumentation.ts` sends every uncaught server error to the logger.
- The ping job logs every run: status and duration when it works, the error when it doesn't. It also logs every incident it records, and a report that couldn't be written.
- The response summary job logs each summary it saves: as info when it's written, as a warning when it's skipped for the budget or failed. A check that finds yesterday already summarized logs nothing.

## Code style

- No comments. Names and small functions explain the code.
- Clear names. No single letters, no abbreviations, no vague names like `data` or `tmp`.
- The vague-name ban covers names we declare: variables, functions and parameters. Object keys are free, because libraries set some of them, like the `data` key in Prisma's `create`.
- Functions have 8 statements at most. Lines aren't counted, so a long Prisma query or an object spread over many lines is fine.
- Components are the exception. They can run up to 300 lines. Split them into sections where it makes the screen easier to follow, not just to make them shorter.
- Use arrow functions everywhere.
- No classes. Using a library's class with `new` is fine, like `new PrismaClient()`. For errors, use `new Error("httpbin timed out", { cause })` instead of a custom error class.
- Import Zod as `import * as zod from "zod"`. The short-name rule rejects `z`.
- Constants that hold a plain value are written in capitals, like `HTTPBIN_URL` or `RECENT_INCIDENT_LIMIT`, and go at the top of the file, right after the imports. In tests they go after the `vi.mock` calls. A plain value is a string, number or boolean, a sum or template built from those and other constants, or a list or object made only of them.
- Everything else at the top level keeps its camelCase name: Zod schemas, `new` instances like `new Intl.NumberFormat()`, `globalThis` holders, functions, components, and values worked out by calling a function, like `environment = readEnvironment()`. Next's own export names, like `dynamic` and `metadata`, stay as Next spells them.
- Lint checks the capitals by type: every top-level `const` that holds a string, number or boolean must be in capitals. So a value worked out when the file loads is in capitals too when it's one of those, like `DATABASE_URL = environment.DATABASE_URL`, or `RUN_ID = randomUUID()` in a test.
- Processes are built step by step, as shown in "Writing a service".

## Formatting

- Biome formats the code, and ESLint lints it. Biome's linter is off, so ESLint stays the one linter. The settings are in `biome.json`.
- Lines are up to 120 characters, with 2-space indents, double quotes and no semicolons. Biome also sorts the imports.
- Formatting runs by itself on every file Claude edits, before lint. One hook, `.claude/hooks/format-on-edit.sh`, runs Biome and then the lint check, so the two never race on the same file.
- Formatting is applied straight away, because it only moves code around and never changes names or what the code does. Lint still never auto-fixes.
- `pnpm format` formats the whole project. `pnpm format:check` only checks, and CI runs it before lint.
- shadcn's and AI Elements' files, and Prisma's generated code, aren't formatted. The vendored paths in `biome.json` must match the `VENDORED` list in `eslint.config.mjs`. Change both together.
- Tailwind's `@theme`, `@source` and `@custom-variant` lines need `css.parser.tailwindDirectives` in `biome.json`. Without it, Biome can't read `globals.css`.

## Linting

- ESLint 9 with Next's rule sets (`core-web-vitals` and `typescript`), set up in `eslint.config.mjs`.
- `next lint` no longer exists, and `next build` doesn't lint. Run `pnpm lint` yourself. CI runs it too.
- Type-checking is `pnpm exec next typegen && pnpm exec tsc --noEmit`. `next typegen` writes the route types, like `PageProps`, that `tsc` needs. CI runs both.
- Every rule is an error, never a warning. `pnpm lint` passes only when it finds nothing.
- Lint runs by itself on every file Claude edits. Claude must fix everything it reports before moving on.
- That check never auto-fixes. Claude chooses the fix, because auto-fix picks mechanical names, like turning `tmp` into `temporary`.
- Claude Code loads hooks when a session starts. After changing `.claude/settings.json`, restart the session or apply the change in `/hooks`.
- `eslint-disable` comments are switched off. Change the code, not the rule.
- `src/components/ui/` and `src/lib/utils.ts` come from shadcn, and `src/components/ai-elements/` from Vercel's AI Elements, so they only follow Next's own rules. They're the `VENDORED` list in `eslint.config.mjs`. `src/db/generated/` is written by Prisma and isn't linted at all.
- Config files in the project root, like `next.config.ts`, skip the size and complexity limits, because their shape is set by the tool that reads them.
- A default export is a named arrow function: `const Home = () => ...`, then `export default Home` at the end of the file.
- Arrow functions can't be generators, so write those as `const name = async function* () {}`.
- Put the main process at the top of the file and its helpers below it.
- Plain constants, in capitals, go at the very top, right after the imports.
- Values worked out when the file loads by calling a helper in the same file, like `environment = readEnvironment()`, the shared Prisma client or `languageModel`, go at the very bottom, after the helpers they call. Arrow functions aren't hoisted, so if one sits above those helpers, the app crashes on start. A value read from one of them, like `DATABASE_URL = environment.DATABASE_URL`, is in capitals and stays below it.
- The capitals check is `@typescript-eslint/naming-convention` with `types`, which needs type information. So `eslint.config.mjs` turns on TypeScript's project service, and root `.js` and `.mjs` files join it through `allowDefaultProject`. Linting one file takes a few seconds longer because of it.
- Components (`.tsx` files) can have 300 lines and 10 statements per function. Everything else is held to 8 statements, with no line limit.
- `pnpm lint` also checks the database schema and the screens. Their rules are in `.claude/rules/database.md` and `.claude/rules/screens.md`.

## To decide later

Reminders for the owner. Don't build any of these until they're decided.

- A naming check beyond lint. Lint catches bad names but not misleading ones. Options: require `is`/`has`/`can`/`should` on yes/no values, or an AI review of names at the end of each task. This time the owner ran a naming and simplify pass by hand. The item stays open.
- Stopping Claude from editing the lint config. Left open for now.
- A pre-commit lint check. The plan is in decision 24 of `docs/decisions.md`.
