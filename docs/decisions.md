# Decisions

Each entry records what we chose, why, and what we turned down. The newest entries go at the bottom.

How the code is organised and written lives in [`AGENTS.md`](../AGENTS.md). This file covers the choices behind it.

---

## 1. Start from `create-next-app`

Date: 2026-09-28 · Status: accepted

### Decision

We scaffolded the app with:

```
npx create-next-app@latest task1 --ts --tailwind --eslint --app --src-dir --import-alias "@/*" --use-pnpm --disable-git
```

This gives Next.js 16.3.6, React 19, TypeScript 5, Tailwind CSS 4, ESLint 9 with Next's rule sets, the App Router, code under `src/`, and pnpm.

### Why

- The brief prefers React or Next.js. With Next.js the dashboard, the REST endpoints and the scheduled job all ship as one app.
- `src/` keeps application code apart from config files at the root.
- pnpm installs faster than npm and its lockfile is strict.

### Notes

- npm package names can't contain capital letters, so the package is named `task1` and the folder was renamed to `Task1` afterwards.
- The git repo is `Task1` itself, started on 2026-10-02 after the first deploy. Its root holds the CI workflow.

---

## 2. Run on a long-lived server, not serverless

Date: 2026-09-28 · Status: accepted

### Context

The app has two jobs that never stop: pinging httpbin every 5 minutes, and keeping a live connection open to every dashboard viewer.

### Decision

The app runs as one long-lived Node process on our own VPS (Hostinger KVM 1: 1 vCPU, 4 GB RAM). pm2 keeps the process running and nginx sits in front of it. We don't use Docker.

### Why

A long-lived process can run a timer and hold connections open without any extra services. A serverless host can do neither.

### Alternatives considered

- Vercel plus Upstash. Upstash QStash would call an API route every 5 minutes, because Vercel's free cron only runs once a day. Upstash Redis would pass new rows to viewers. It works, but it takes three services to do what one process does. Vercel also stops functions after a few minutes, so each viewer's live connection would drop and reconnect over and over.
- Hostinger shared web hosting. It doesn't allow a Node process that stays up. We have a KVM plan, which is a real virtual machine, so this doesn't apply.

### Consequences

- The brief suggests a free platform. We use our own VPS because the app needs a process that stays up. The VPS was already owned and in use for other things before this exercise, so it adds no cost. The dashboard is still reachable at a public URL.
- We're responsible for the server: Node version, pm2, nginx, TLS and Postgres.

---

## 3. Start the 5-minute timer from `instrumentation.ts`

Date: 2026-09-28 · Status: accepted

### Decision

`src/instrumentation.ts` exports `register()`, which Next calls once when the server starts. It starts a `setInterval` that runs the ping job every 5 minutes.

The interval comes from the `PING_INTERVAL_MS` setting, which defaults to 300000 (5 minutes). A shorter one makes local testing faster.

### Why

The timer lives in the same process as the website. There's no separate worker to deploy, monitor or keep alive, and no cron service to set up.

### Consequences

- `register()` returns straight away unless `process.env.NEXT_RUNTIME === "nodejs"`, because Next also calls it for the edge runtime.
- Each tick catches its own errors. An unhandled rejection inside the interval would crash the whole process.
- The interval handle lives on `globalThis`. If `startPingTimer` runs again, it clears the old timer and starts a new one, so there's never a second timer. Next calls `register()` once per server, so in practice this only matters in tests.
- There's no ping at startup. The first one comes one interval after the server starts, so restarts and deploys don't add pings off the schedule.
- `next dev` doesn't re-run `register()` when a file changes. After changing the ping job or anything it calls, restart `pnpm dev`.
- Running two copies of the app pings httpbin twice. See decision 6.

---

## 4. Push live updates with Socket.IO

Date: 2026-09-28 · Status: replaced by decision 6

### Decision

We use Socket.IO 4. The app still runs with plain `next start`. `instrumentation.ts` starts a Socket.IO server on its own port when the app boots. After the ping job saves a row, it emits a `ping` event to every connected browser. The dashboard listens with `socket.io-client`. In production, nginx forwards `/socket.io/` to the socket port, so browsers only ever talk to one address.

### Why

- It's the least code we have to own: a few lines to start the socket server, and about 3 lines in the browser.
- The library handles the edge cases. It reconnects with backoff, sends heartbeats, falls back to HTTP long-polling when WebSockets are blocked, and buffers messages while reconnecting.
- It's widely used (about 21M weekly downloads) and actively maintained. Version 4.8.4 came out in September 2026.
- It has an [official testing recipe](https://socket.io/docs/v4/testing).

### Alternatives considered

| Option | Why not |
|---|---|
| Server-sent events written by hand (a route handler with `ReadableStream` plus the browser's `EventSource`) | No custom server needed, but we'd write the keep-alive pings, the cleanup on disconnect and the proxy headers ourselves. It's more hand-written code to maintain for no gain in our setup. |
| `next-ws` | It patches `node_modules/next` on install and supports exact Next versions only, so every Next upgrade waits for a new next-ws release. |
| Plain `ws` | No reconnection or heartbeats built in, and it breaks hot reload in development unless we route upgrade requests ourselves. |
| Pusher / Ably | Needs an outside account and secret keys, and our data leaves the server. |
| Yjs | Built for many people editing one shared document and merging their changes. Here only the server writes and viewers only read, so there's nothing to merge. |

### Consequences

- `next start` doesn't give us its HTTP server to attach to, so Socket.IO gets its own port. Our other option was a custom `server.mts` that wraps Next. We turned that down to keep the standard `next start` that pm2 runs.
- In development there's no nginx in front, so the browser connects to the socket port directly. The address comes from an environment variable.
- The Socket.IO server is reached through `globalThis.io`. On Next 16.3.6, `instrumentation.ts` and the route code load separate copies of the same module, so an ordinary module-level singleton would give each of them its own instance. This was confirmed in a throwaway test app.
- pm2 must run exactly one instance, in fork mode. In cluster mode each copy would run its own timer, and each viewer would only hear from the copy it connected to.
- The nginx site config needs a `/socket.io/` block with the `Upgrade` and `Connection` headers so WebSocket upgrades go through.
- In development, a reload can run `register()` again. The same `globalThis` flag that guards the timer also stops a second socket server from grabbing the port.
- A server restart drops every connection and the Socket.IO state. Nothing is lost: rows are already in Postgres, clients reconnect by themselves, and on each `connect` the dashboard refetches recent rows from the history endpoint to fill any gap.

---

## 5. Prisma with PostgreSQL

Date: 2026-09-28 · Status: accepted. Hosting settled 2026-10-02, see below.

### Decision

Prisma is the data layer. PostgreSQL is the database.

### Why

- Prisma gives typed queries, migrations kept in the repo, and one schema file that serves as the database schema the brief asks for.
- Postgres stores each httpbin response in a `jsonb` column and still lets us query the fixed fields, like status and duration, with ordinary indexes.

### The table

There's one table, `ping`, with one row for each run of the ping job. The first migration, `create_ping`, creates it.

Amended 2026-10-02: four tables followed. Decision 36 added `incident`, `chat_session` and `message`, and decision 54 added `response_summary`. The same decision gave `ping` two more columns, `responseKind` and `origin`.

- `id`, and `created_at` for when the ping ran. `created_at` has an index, because the table is always sorted and filtered by it.
- `payload`: the random JSON we sent, as `jsonb`.
- `status_code`: the HTTP status httpbin sent back. It's null when no response came back, like on a timeout.
- `duration_ms`: how long the request took, until the response or the failure. It's always set.
- `response`: httpbin's response body, as `jsonb`. It's null when there was none.
- `error`: what went wrong. It's set whenever a ping didn't succeed, including when httpbin answered with an error status. So "failed" is one simple check: `error IS NOT NULL`.

A list of pings leaves out `payload` and `response`. They're the two heavy columns, and the table doesn't show them. `GET /api/pings/:id` returns a ping in full.

### Settled, 2026-10-02

Postgres runs on the VPS, as the database `task1` with its own role, over loopback. The app and its database share one machine, so a managed tier would only add a network hop and a second place to look when something breaks. The app is live at https://ping-monitor.applyfast.tech. The setup is in `deployment.md`.

---

## 6. Push live updates with better-sse

Date: 2026-09-28 · Status: accepted · Replaces decision 4 · The browser side changed in decision 27

### Decision

New pings reach the dashboard as server-sent events. One API route, `src/app/api/pings/stream/route.ts`, keeps a stream open to each viewer using better-sse. After the ping job saves a row, the broadcasting service sends it on a shared better-sse channel. The browser listens with its built-in `EventSource`.

### Why

- It's what Next recommends. Next's streaming guide (`node_modules/next/dist/docs/01-app/02-guides/streaming.md`, "Streaming in Route Handlers") names server-sent events as a use for streaming from an API route. Neither Next nor Vercel ships a separate package for it.
- It removes the reason we turned down server-sent events in decision 4. better-sse handles the keep-alive messages, reconnect timing and the stream format, which we would otherwise write by hand.
- The stream is an ordinary API route on the same port as the rest of the app. We don't need a second port, a `/socket.io/` block in nginx, or a client package.
- Data only flows one way, from server to viewers. Socket.IO's two-way messaging would go unused.

### Alternatives considered

| Option | Why not |
|---|---|
| Socket.IO (decision 4) | A second port, an nginx upgrade rule and a client package, all for two-way messaging we don't use. |
| Server-sent events written by hand | Same approach, but we'd own the keep-alive, cleanup and headers. better-sse is a thin layer over the pattern Next documents, so swapping it out later means writing about 20 lines. |

### Consequences

- better-sse is small and still before 1.0: version 0.16.1, about 69k weekly downloads, last released in December 2025. We use a tiny part of it, so replacing it is cheap if it stalls.
- We ended up owning the cleanup when a viewer disconnects after all, which was decision 4's reason for not writing server-sent events by hand. better-sse doesn't handle a failed write to a viewer who left, and it starts a session even when the viewer is already gone. `src/services/live-updates.ts` works around both (decision 22). A small `pnpm patch` of better-sse, plus an issue upstream, could replace that workaround later.
- The channel lives on `globalThis`, for the same reason given in decision 4. `instrumentation.ts` and the route code load separate copies of the same module.
- Keep-alive must stay on. Pings are 5 minutes apart, and nginx closes a connection that stays quiet longer than its read timeout. better-sse sends a keep-alive every 10 seconds, well inside nginx's default of 60.
- nginx must not buffer any route. Buffering the stream makes events arrive late and in batches, and pages stream their HTML too, so Next's self-hosting guide asks for buffering off everywhere. Set `proxy_buffering off` for the whole site. The stream route also sends `X-Accel-Buffering: no` itself. better-sse sends that header by default, and we set it explicitly so it can't disappear in an upgrade.
- The stream route exports `dynamic = "force-dynamic"`. Without it, `next build` tries to prerender its `GET`. The history routes don't need it, because route handlers aren't cached by default. If Cache Components is turned on later, replace it with `await connection()`, because Cache Components replaces segment settings like `dynamic`.
- Serve the site over HTTP/2 through nginx. Over HTTP/1.1, a browser allows only 6 connections to one site, and each open dashboard tab holds one.
- pm2 still runs exactly one instance, in fork mode. The timer and every open stream live in that one process.
- The browser never refetches from the history endpoint, because our dashboard never calls it (decision 9). It calls `router.refresh()` instead, which re-runs the page on the server. Decision 27 covers when.

---

## 7. Organise code by what it does, the way Rails does

Date: 2026-09-28 · Status: accepted

### Decision

Each kind of code gets one folder. `services/` holds what the app does, `models/` holds database reads and writes, `jobs/` holds timed work, and `components/` and `hooks/` hold the screen. `config/` holds settings and the logger, and `db/` holds the Prisma client. `app/` holds only pages and API routes. The full layout is in `AGENTS.md`.

### Why

- Anyone who has used Rails knows where to look, and so does an AI agent. Each kind of code has exactly one place.
- Next doesn't impose a layout. Its docs only ask for one to be picked and kept.

### Alternatives considered

- Folders by feature, with everything about pings in one folder. That's better for big apps with many features. This app has one feature, so it would be one folder holding everything.
- A `server/` folder wrapping everything that runs on the server. It would only have made one lint rule shorter. Each server file's `server-only` import already stops browser code from pulling it in.
- A `controllers/` folder. With two small API routes, the route files call services directly. A controller layer would only pass the calls along.

---

## 8. Services run the process, models only touch the database

Date: 2026-09-28 · Status: accepted

### Decision

- Pages, API routes and jobs each call one service function. That function reads as a list of steps, top to bottom.
- Each step is a helper in the same file, a model function, or a function from another service.
- Models only read and write the database. They make no decisions. Only models import the Prisma client.
- Calls only go down or sideways. A model never calls a service.
- A service file is a long module. It holds a whole area of work and exports only what other code needs.

### Why

- A reviewer can open one function and read the whole process: build a payload, send it, save the result, broadcast it.
- With database code kept in models, a change to a table touches one file.
- Long service files keep related helpers together. Splitting every helper into its own file means jumping between files to follow one process.

### Alternatives considered

- Rails' "fat models", where business rules live in the model. Prisma already generates the table types, so our models stay thin and the rules live in services.
- Event-driven code, where a service announces "ping saved" and separate listeners react. That hides the order of the steps, which is exactly what we want visible.

---

## 9. The dashboard reads on the server, and API routes are for outside callers

Date: 2026-09-28 · Status: accepted · The chat is the one exception, in decision 40 · Amended 2026-10-02: the endpoints grew with the incident routes (decision 28) and the chat routes (decisions 40 and 53), and the chat became the one user input (decision 40)

### Decision

- The dashboard page runs on the server and calls services directly. The browser never fetches table data itself.
- The brief asks for REST endpoints for historical data, so we have two. `GET /api/pings` returns a page of saved pings, and `GET /api/pings/:id` returns one ping in full. Both call the same services the page uses.
- When a new ping is saved, the live stream tells the browser, and the browser re-runs the page on the server (decisions 6 and 27).
- We don't use server actions.

### Why

- Next recommends fetching data on the server, and it means the table has data on first load, with no loading spinner.
- Users never enter data in this app, so there's nothing for server actions to do.
- The endpoints are for reviewers checking with curl, for tests, and for any other app. Each costs a few lines, because it reuses the services.

### Alternatives considered

- TanStack Query in the browser. It's great when the browser fetches data itself, which it never does here. The first rows come from the server, filter changes re-run the page on the server (decision 10), and a new ping re-runs it too. It would be a library with nothing to do.
- Having the dashboard call its own API routes. That adds an extra network trip to reach code the page can call directly.

---

## 10. Keep the table's filters and pages in the URL with nuqs

Date: 2026-09-28 · Status: accepted

### Decision

nuqs keeps the table's filters and page number in the URL. The definitions live in `src/lib/ping-filters.ts`. The page reads them on the server, the dashboard writes them in the browser, and `GET /api/pings` uses them to check its query string.

The table's filters are a date range and "failed only", plus the page number. The brief doesn't require filters. We chose these two because they're what someone reading ping history needs.

The definitions are nuqs's own built-in parsers, with no rules of our own:

- `page` uses `parseAsInteger`, and defaults to 1. A page is 20 pings. The service treats anything below 1 as page 1.
- `from` and `to` use `parseAsIsoDateTime`. They take an ISO 8601 time like `2026-09-30T12:00:00Z`, or a bare date like `2026-09-30`, which means midnight UTC at the start of that day. Both ends are included.
- `failedOnly` uses `parseAsBoolean`, and defaults to `false`. Only `true` turns it on.

The API reads them in nuqs's strict mode, so a value nuqs can't read at all, like `page=abc` or `from=notadate`, returns 400. The page reads them leniently instead, so a bad value in a shared link falls back to the default and the dashboard still loads.

The dashboard's date boxes pick whole days in the viewer's own time zone. They send the start and end of that local day as exact times, and wait 500 ms after the last change before updating the URL, so typing a date doesn't fire a request for every key.

### Why

- A filtered view can be shared or bookmarked, and the back button works.
- One definition is used in three places, so the page, the browser and the API can't disagree about what a filter means.
- When a filter changes, nuqs can re-run the page on the server. The new rows come from the same service call as the first load.

### Alternatives considered

- Plain React state. It's simpler, but filters would be lost on refresh and couldn't be shared, and the API would need its own separate checks.
- Our own stricter parsers, first with regular expressions and then with Zod. They capped the page number, took only exactly `true` or `false`, and read a bare `to` as the end of that day. That was more code to own, and the Zod version shipped about 20 KB of Zod, gzipped, to the browser. We chose nuqs's built-ins for clarity.

### Consequences

- The built-ins are loose on odd input. `page=12abc` reads as 12, `page=1.5` as 1, and `failedOnly=maybe` as `false`. The worst case is a page or filter the caller didn't quite mean, never bad data.
- A bare `to` date is the start of that day, not the end. For a whole day, send an exact end time like `2026-09-30T23:59:59.999Z`.
- A time with no offset, like `2026-09-30T12:00:00`, is read in the server's time zone, because that's how JavaScript's `Date` reads it. Callers should add `Z` or an offset.
- A page number too large for the database, like `page=100000000000000000000`, fails with a 500, on the API and on the dashboard. Nobody pages that far, so we left it.

---

## 11. Zod for checking input and settings

Date: 2026-09-28 · Status: accepted

### Decision

Zod checks two things: the environment variables, in `src/config/env.ts`, and the ping id in `/api/pings/:id` and `/pings/:id`. The table's filters are read by nuqs's built-in parsers (decision 10), so Zod never touches them and never reaches the browser.

Amended 2026-10-02: Zod now also reads the incident id, in `src/lib/incident-id.ts`, the way it reads the ping id; the shape of the model's incident report (decisions 29 and 34) and daily summary (decision 54); the chat's request body (decision 42) and session id (decisions 41 and 53); and the query arguments the model writes for the chat (decisions 39 and 49).

The id check lives in `src/lib/ping-id.ts`, and both `GET /api/pings/:id` and the `/pings/:id` page use it. An id must read as a whole number from 1 to 2147483647, the largest value a Postgres `integer` holds. Anything else gets a 400 from the API, instead of a database error. Zod's number coercion is loose too: `1e3` reads as 1000.

### Why

- One library covers both jobs. It also turns each check into a TypeScript type, so we don't describe the same shape twice.
- It's the most widely used option, and shadcn's form components and Vercel's AI SDK expect it.

### Alternatives considered

- Valibot and ArkType. Both are fine, but there's no reason to add a second library when Zod already fits.
- t3-env, a wrapper around Zod for environment variables. Its main feature keeps browser settings apart from server settings, and we have no browser settings.

---

## 12. pino for logging

Date: 2026-09-28 · Status: accepted

### Decision

- One shared pino logger, in `src/config/logger.ts`. Lint bans `console`.
- It writes one line of JSON per event to standard output, and pm2 saves that output to log files.
- `onRequestError` in `src/instrumentation.ts` sends every uncaught server error to the logger.
- In development, the output is piped through pino-pretty to make it readable.

### Why

- The brief calls proper error handling and logging "a huge plus".
- Next doesn't recommend a logging library, but it lists pino among the packages that work with no setup.
- JSON lines are easy to search on the server. pm2 already handles log files, so pino doesn't have to.

### Alternatives considered

- OpenTelemetry, which Next recommends for monitoring. It follows each request through the app, but needs a separate service to collect and show the data. That's too much for this app.
- `console.log`. It has no levels and no structure, and it's easy to leave behind by accident.
- consola. It's aimed at command-line tools.

### Consequences

- Don't use pino's `transport` option for pretty output. It runs in a separate thread, which currently breaks under Next's bundler (Next issue #87342).

---

## 13. shadcn/ui on Base UI

Date: 2026-09-28 · Status: accepted

### Decision

The interface uses shadcn/ui, set up with the CLI's current default style. That style builds components on Base UI instead of Radix. The components live in `src/components/ui/`.

### Why

- shadcn copies component code into the project, so we own it and can change it.
- Base UI is shadcn's current default. Starting on it means we won't have to redo components later.

### Alternatives considered

- Radix, shadcn's older default, which has more examples and add-ons online. Switching was cheap before any components existed, but we chose to stay on the current default.

### Consequences

- shadcn's generated files don't follow our code style, so lint only applies Next's own rules to them (decision 15).
- shadcn's setup left the page font broken, because a theme variable pointed at itself. `globals.css` now points `--font-sans` at the font Next loads, `--font-geist-sans`.

---

## 14. Pin Prisma to version 7

Date: 2026-09-28 · Status: accepted

### Decision

`prisma`, `@prisma/client` and `@prisma/adapter-pg` are pinned to 7.10.

### Why

On 2026-09-28, the newest `prisma` on npm was 8.0.0-rc.17, an unfinished release candidate, while the newest `@prisma/client` was 7.10.0. Installing without a version number gave a mismatched pair. Prisma warns that release candidates can change in breaking ways from one to the next.

### Consequences

- We use the Prisma 7 setup: `prisma.config.ts` at the root, the generated client in `src/db/generated/`, and a Postgres driver adapter.
- `prisma.config.ts` reads `DATABASE_URL` directly, because it runs outside the app. It's the one exception to "only `config/env.ts` reads environment variables".
- Revisit this when Prisma 8 has a stable release.

---

## 15. Strict lint rules, checked after every edit

Date: 2026-09-28 · Status: accepted

### Decision

- We use ESLint with Next's rule sets, plus our own rules for naming, function size, step-by-step style, arrow functions and no comments. The rules are in `eslint.config.mjs` and summarised in `AGENTS.md`.
- Every rule is an error. `pnpm lint` fails on any problem.
- After an edit, a hook runs ESLint on the file. Problems show up straight away and have to be fixed before the work moves on.
- `eslint-disable` comments don't work.

### Why

- The project was written with an AI coding agent, Claude Code, and the hooks run on its edits, so the tooling is transparent to a reviewer. AI-written code tends to drift toward comments that repeat the code, vague names and long functions. Rules that run on every edit stop that as it's written, not later in review.
- Separate check scripts that only run at commit time catch problems late. ESLint runs in the editor and after every edit, with no extra scripts to maintain.

### Alternatives considered

- Biome. It's faster, but it would replace Next's own lint rules and it has no rule for abbreviations.
- oxlint. It's fast, but it's missing the naming and syntax rules we need, and its plugin support is still early.
- Letting the hook auto-fix problems. In testing, auto-fix renamed `tmp` to `temporary`, which passes the rule but isn't a better name. The arrow-function auto-fix could also produce code that crashes on load. So each problem is fixed by hand, with a chosen name.

### Consequences

- Official support for ESLint 9 ended on 2026-08-06. We can't move to ESLint 10 until Next's rule set supports it, so the plugins are pinned to versions that work with 9.
- shadcn's files (`src/components/ui/` and `src/lib/utils.ts`) only get Next's rules. Prisma's generated code isn't linted.
- Hooks load when a session starts, so a running session needs a restart to pick up hook changes.
- The lint config isn't protected from edits yet. We chose not to block that for now.

---

## 16. The code style rules

Date: 2026-09-28 · Status: accepted

### Decision

- No comments. Names and small functions explain the code.
- Clear names: at least 3 characters, no abbreviations like `res` or `tmp`, no vague words like `data`, `result` or `item`, and no type prefixes like `strName`.
- Functions are at most 8 statements, with no line limit. This was 8 lines and 6 statements until 2026-10-02, when the formatter arrived (decision 50). A formatter spreads Prisma queries and objects over many lines, and a line count punished that and pushed code into tiny helpers. Components can reach 300 lines and 10 statements, but should be split into sections wherever that makes the screen easier to follow.
- Arrow functions only. A default export is a named arrow, followed by `export default Name`.
- No classes. Errors are `new Error(message, { cause })`.
- The main process goes at the top of a file and its helpers go below it. Values worked out when the file loads go at the very bottom. Amended on 2026-10-02 by decision 51: plain constants, in capitals, now go at the very top, right after the imports. Only values worked out by calling a helper in the same file stay at the very bottom.

### Why

- Short functions with clear names read like a list of steps, which is the style decision 8 depends on.
- Components are mostly markup, which takes up lines without adding logic, so they get a bigger limit.
- With one way to write functions and no classes, there's less to decide, and the code stays consistent whoever writes it.
- Unlike `function` declarations, arrow functions aren't lifted to the top of the file. A value computed when the file loads must come after the helpers it uses, or the app crashes on start.

### Alternatives considered

- 6 lines per function. That was too tight: a process with 4 steps and a return didn't fit.
- A custom error class for each kind of failure. It reads well, but it's the one place classes would creep back in. A clear message and a `cause` carry the same information.

---

## 17. happy-dom for component tests

Date: 2026-09-28 · Status: accepted

### Decision

Component tests run with Vitest in happy-dom, a lightweight fake browser.

### Why

jsdom, the usual choice, now needs Node 24.15 or newer, and the development machine had 24.14.1. happy-dom is lighter and faster, and it covers what basic component tests need.

### Consequences

- Every server file imports `server-only`, and that import throws inside Vitest. The Vitest config swaps it for an empty module.
- In happy-dom, a `Label` wrapped around a `Switch` toggles it twice on one click. So the label sits beside the switch and points at it with `htmlFor`.

---

## 18. No login

Date: 2026-09-28 · Status: accepted

### Decision

The dashboard has no login.

### Why

- The brief doesn't ask for one.
- The dashboard only shows data, and nobody enters anything, so there's nothing to protect.
- Adding login, for example with better-auth, would be real work outside the brief.

### Consequences

- Anyone with the URL can see the pings. The payloads are random test data, so nothing sensitive is exposed.

---

## 19. Lint the database schema and the screens too

Date: 2026-09-28 · Status: accepted

### Decision

- `pnpm lint` also checks `prisma/schema.prisma`: Prisma's own format and validity checks, then prisma-lint for our naming rules. Editing the schema runs these checks straight away, the same way editing code runs ESLint.
- Screen files (`.tsx`) get three more sets of checks. shadcn's official linter (`@shadcn/lint`) catches restyled shadcn components, raw colours, made-up values, inline styles and unknown classes. A Tailwind checker (`eslint-plugin-better-tailwindcss`) catches clashing, repeated or out-of-order classes. A rule that ships with Next's lint setup bans raw `button`, `input`, `textarea`, `select`, `table` and `dialog` elements in favour of the shadcn versions.

### Why

- The schema is code too. A plural table name or a missing `createdAt` is cheap to catch now and expensive to rename after data exists.
- Screens drift the same way code does: a hard-coded colour here, a hand-rolled button there. These checks keep every screen on the shared theme and components.

### Alternatives considered

- `eslint-plugin-tailwindcss`. Its Tailwind 4 support is stable now, but it reports class order once for every class (24 errors on one small page) and catches nothing the two linters above miss.
- A third-party `eslint-plugin-shadcn`. It had 1 star and a single day of work behind it.
- `shadcn diff` for spotting upstream changes to our components. It's deprecated and reported "no updates" when two files had changed.

### Consequences

- `@shadcn/lint` was two weeks old, with seven releases in eight days, so it's pinned to exactly 0.2.0. Upgrade it on purpose.
- The Tailwind checker's `no-deprecated-classes` rule is off on purpose. Its auto-fix turns `rounded` into `rounded-sm`, which is a different size in our theme, so it would silently change how things look. Don't switch it back on.
- The after-edit check on a screen file takes about 1.5 seconds with a warm cache.
- The create-next-app home page failed 31 of the new checks, so it was replaced with a minimal "Ping monitor" placeholder. The dashboard has since replaced that.

---

## 20. Lint enforces the architecture

Date: 2026-09-30 · Status: accepted

### Decision

ESLint's built-in `no-restricted-imports` rule blocks imports that break the layers in decision 8. Pages, API routes and jobs can't import models. Models can't import services. Services can't import the interface. Components, hooks and `lib/` can't import any server folder. Only models and `db/` can load the database client. Type-only imports stay allowed everywhere, because types disappear when the code is compiled. The rules sit in `architectureRules` in `eslint.config.mjs`.

### Why

The architecture was only written down. Nothing stopped a page from reaching straight into the database. Now that mistake fails lint, and shows up right after the edit.

### Alternatives considered

- `eslint-plugin-boundaries` or dependency-cruiser. Both are more powerful, but ESLint's built-in rule covers our six folder rules without a new package.
- typescript-eslint's version of the rule. It's deprecated in favour of the built-in one, which now handles type-only imports itself.

### Consequences

- Each pattern catches both `@/models/ping` and relative paths like `../models/ping`.
- Dynamic `import()` and `require()` aren't checked.
- Test files may load the database client directly, for example to wipe data between runs. Every other import rule still applies to them.

---

## 21. Run every database session in UTC

Date: 2026-09-30 · Status: accepted

### Context

`@prisma/adapter-pg` 7.10 assumes Postgres sends and receives timestamps in UTC. It drops the offset Postgres adds when it reads a `timestamptz`, and it writes times with no offset at all. Postgres reads an offset-less time in its own session time zone. The development Postgres runs in Asia/Karachi (UTC+5), so saved times were off by 5 hours.

### Decision

`src/db/client.ts` passes `options: "-c timezone=UTC"` to the adapter. Every session runs in UTC, whatever time zone the server is set to.

### Why

- It fixes the problem where it starts, in one line, and it holds on any machine.
- `tests/db/client.test.ts` guards it. It checks times written through the model and times stamped by the database's own clock. On the unfixed client, 4 of its 5 tests fail.

### Alternatives considered

- Setting the time zone on the Postgres server or the database. It works, but it lives outside the repo, so every new machine needs the same step, including production.

### Consequences

- Rows saved on a dev machine before the fix are 5 hours early. The ones in the dev database were shifted by hand.
- Only the database session uses UTC. Pages still show each time in the viewer's own time zone.

---

## 22. A broken broadcast never fails a ping

Date: 2026-09-30 · Status: accepted

### Decision

- `recordPing` saves the row first, then broadcasts it. If the broadcast throws, it logs the error with the ping's id and still returns the saved row.
- One viewer's broken connection can't stop a broadcast reaching the others, and it can't leave errors behind. Each viewer's stream gets its own end signal, and that signal only fires after better-sse has started the session.

### Why

- Saving is the job. Broadcasting only tells open tabs to refresh. A broken stream shouldn't lose a row or turn a good ping into a failed one. The row is already in Postgres, and viewers see it the next time their page re-runs.
- We first suspected one broken session could stop better-sse's broadcast loop. It can't: better-sse removes a disconnected session in the same step that marks it disconnected.
- The real bug was quieter. Writes to viewers who had hung up, or who stopped reading, became promise rejections nobody caught. Next logged each one without crashing, but they came back on every ping and every 10-second keep-alive, flooding the log, and the dead sessions were never cleaned up.

### Alternatives considered

- Letting a broadcast error fail the job. The job would log a failure for a ping that worked, and the saved row would look lost.

### Consequences

- `tests/services/ping.test.ts` checks that a throwing broadcast still returns the saved row and logs once.
- `tests/services/live-updates.test.ts` has 4 tests for broken viewers: one who disconnected, one who stopped reading, one who hung up before the stream started, and one who left before it opened. Each checks the healthy streams still get the ping and nothing is left unhandled.
- This workaround is ours to keep while better-sse doesn't handle these cases itself. A small `pnpm patch`, plus an issue upstream, could replace it later (decision 6).

---

## 23. The ping-recording process is the core component we test thoroughly

Date: 2026-09-30 · Status: accepted

### Context

The brief asks us to name the app's core parts and test ONE of them thoroughly. The core parts are:

1. Recording a ping: build a payload, send it to httpbin, save the result, broadcast it. That's `recordPing` in `src/services/ping.ts`, with `src/services/live-updates.ts` for the broadcast, started by the timer in `src/jobs/ping.ts`.
2. Reading history: the filters, the pages and the REST endpoints.
3. Live delivery: the stream route and the browser hook.
4. The dashboard: the table, filters and pagination.

### Decision

The ping-recording process gets the thorough tests.

- `tests/services/ping.test.ts` covers the payload (different on every call, and saved exactly as sent), the request to httpbin, every kind of failure (an error status, a timeout, an abort, a network error, a non-JSON body), what gets saved, and the broadcast, including a broadcast that throws.
- `tests/services/live-updates.test.ts` covers the stream it broadcasts to, including viewers whose connection breaks.
- `tests/integration/ping-flow.test.ts` runs one timer tick end to end: the timer fires, httpbin is stubbed, the row lands in Postgres, and the same row arrives on an open stream.
- Both service files are at 100% of lines and branches.

The other parts get lighter tests: the API endpoints against a real database, the filter parsing, the timer, the database time zone, and component tests for the dashboard, the live hook and the error page.

### Why

- Everything else only reads what this process writes. If it saves the wrong thing, or stops saving, every other part shows wrong data or nothing at all.
- Its failures are quiet and hard to cause by hand. httpbin being slow or down must still produce a row. Tests can force each case.
- It holds most of the brief's backend requirements: ping on a timer, send a random payload, store the response, broadcast it.

### Alternatives considered

- The REST endpoints. They're thin: read the request, call one service, return. Their risk is in the filter parsing, which has its own tests.
- The dashboard. It's what a reviewer sees, but it only draws what the server hands it. A bug there shows straight away. A bug in recording doesn't.

### Consequences

- The service and API tests use the real Postgres in `DATABASE_URL` and stub only `fetch`. Each test deletes the rows it wrote, found by the request ids the `fetch` stub saw or by a run id in the payload.
- There's no browser end-to-end test yet. The integration test covers the critical flow on the server.

---

## 24. CI with GitHub Actions

Date: 2026-09-30 · Status: accepted

### Decision

One workflow, `.github/workflows/ci.yml`, at the root of the repo. It runs on every push and pull request. One job on Ubuntu, with a Postgres 17 service container and Node 24:

1. `pnpm install --frozen-lockfile`, which also generates the Prisma client
2. `pnpm format:check`, added on 2026-10-02 with Biome (decision 50)
3. `pnpm exec prisma migrate deploy`
4. `pnpm lint`
5. `pnpm exec next typegen`, then `pnpm exec tsc --noEmit`
6. `pnpm test:coverage`
7. `pnpm build`
8. Upload `coverage/` as an artifact, unless the run was cancelled

### Why

- The brief asks for a pipeline that runs the tests, checks lint and produces a coverage report. Type-checking and a build catch what those miss.
- `next typegen` writes the route types, like `PageProps`, that `tsc` needs. `next build` writes them too, but type-checking shouldn't wait for a build.
- The tests need a real database. A service container gives each run a fresh one.
- `prisma migrate deploy` only applies the committed migrations, the same as in production. `migrate dev` would try to create new ones.

### Alternatives considered

- Separate jobs for lint, types and tests. They'd run side by side, but each would install everything again, and the whole run is already short.
- A coverage service like Codecov. It needs an account and a token. The uploaded report and the text summary in the log are enough for a reviewer.

### Consequences

- The repo was started on 2026-10-02, after the first deploy, and the first push ran the workflow.
- The job sets `LOG_LEVEL=silent`, so test logs stay out of the CI output.
- A pre-commit hook comes after the repo: `simple-git-hooks` as a dev dependency, installed by a `prepare` script, and listed in `ignoredBuiltDependencies` in `pnpm-workspace.yaml` because pnpm 10 blocks install scripts by default. The hook runs `cd Task1 && pnpm lint`. The full lint takes 5 to 8 seconds, so lint-staged isn't needed.

---

## 25. No `loading.tsx`, so a missing ping gets a real 404

Date: 2026-09-30 · Status: accepted

### Decision

There's no `loading.tsx` anywhere in `src/app/`. The ping details page had one, with a skeleton, and we removed it.

### Why

- A `loading.tsx` wraps its page in a loading boundary. Next then sends the headers and starts streaming before the page finds out the ping is missing, and after that the status can't change. With the skeleton in place, `/pings/<missing id>` showed Not found with status 200. Next's `loading.js` docs describe this under "Status Codes".
- A root `loading.tsx` would also put a skeleton into the dashboard's first HTML instead of the table, which breaks decision 9: data on first load, with no spinner.
- Filter and page changes on the dashboard already show their own loading state, through nuqs's `startTransition`.

### Alternatives considered

- A skeleton on the details page only, which we had first. It cost the real 404 for a missing ping.
- Checking that the ping exists in `proxy`, before the page streams, which Next suggests for a real 404 behind a loading boundary. It's a second database read on every details request.

### Consequences

- A missing or invalid ping, like `/pings/999999999` or `/pings/abc`, returns 404 with the Not found page. So does any unknown address.
- There's no skeleton while a ping's details page loads. It's one database read by id.

---

## 26. On shutdown, stop the timer and close every stream

Date: 2026-09-30 · Status: accepted

### Context

`next start` handles `SIGTERM` and `SIGINT` itself: it stops taking new connections and waits for open ones to finish. Open streams never finish. So with a dashboard open, the app never exited on its own under plain `pnpm start`, and under pm2 every restart waited the full `kill_timeout`.

### Decision

- `register()` in `src/instrumentation.ts` also calls `stopPingTimerAndStreamsOnShutdown()` from `src/jobs/ping.ts`. It listens once for `SIGTERM` and once for `SIGINT`, next to Next's own handler.
- On either signal, it clears the ping timer and calls `shutDownPingStreams()` in `src/services/live-updates.ts`. That ends every open stream, found through better-sse's `activeSessions`, and sets `isShuttingDown` on `globalThis`, so any later stream request gets a 503.
- Streams, and that 503, send `Connection: close`.
- With no streams left open, Next's own shutdown finishes straight away. In testing, the process exited 22 to 50 ms after `SIGTERM`.
- A ping still in flight is always dropped, and nothing is saved for it. The new process pings again one interval after it starts.
- Open tabs show Reconnecting…, with no error page, and go Live again once the new process answers (decision 27).
- pm2 runs the app from `ecosystem.config.js`. On a restart or stop it sends `SIGINT`, and kills the process if it's still running after `kill_timeout`, 10 seconds. That's only a safety net now.

### Why

- Restarts are quick, and a dashboard left open can't keep a stopped app alive.
- A ping is disposable. Missing one leaves a gap in the table, and the next run carries on. Nothing is half-written: a row is saved in one insert, or not at all.

### Alternatives considered

- No shutdown code, leaving it to pm2's `kill_timeout`. It's what we had first, for the reasons in Context.
- Only clearing the timer and closing the streams. Chrome reused the kept-alive connection for its 5-second reconnect, reached the dying server, and the page refresh after it hit a dead server. `Connection: close` makes the browser open a fresh connection, and the 503 turns away any stream request that still reaches the old process.
- Waiting for the in-flight ping before exiting. It saves one row on a badly timed restart, but it needs shared state for the ping in flight and up to 30 seconds, the httpbin timeout, on every restart.
- Taking over the signals from Next with `NEXT_MANUAL_SIG_HANDLE`. Our listener runs next to Next's instead, so Next still finishes the page requests in flight.

### Consequences

- `tests/jobs/ping.test.ts` checks that either signal stops the timer, ends every open stream and refuses new ones.
- pm2 starts `node_modules/next/dist/bin/next start` directly, not `pnpm start`, so the signal reaches Next with no pnpm process in between.
- The config file is `ecosystem.config.js`, not `.cjs`. `package.json` has no `"type": "module"`, so a `.js` file is already CommonJS. ESLint can't lint `.cjs` files in this project: our config applies an `import` plugin rule to every file, but Next's lint setup only loads that plugin for `.js`, `.mjs`, `.ts` and similar files.

---

## 27. Refresh the page on every new ping

Date: 2026-09-30 · Status: accepted · Changes the browser side of decision 6 · Incidents refresh it too since decision 35

### Context

The first live hook put each streamed row into the table itself. So it had to repeat the server's rules in the browser: only on page 1, only when the row matches the filters, no duplicates, and a total count kept by hand. It grew to about 100 lines, and it was one more place where the browser and the server could disagree.

### Decision

- `useRefreshOnNewPing`, in `src/hooks/use-refresh-on-new-ping.ts`, listens to the stream with the browser's `EventSource`. On every `ping` event it calls `router.refresh()`, and the server re-renders the page with the current filters and page number.
- The browser no longer inserts, filters or dedupes rows. The table, the count and the pages always come from the server.
- On any stream error, the hook closes the `EventSource`, shows Reconnecting, and opens a new one 5 seconds later. When the new one opens, it refreshes the page to fill any gap, and shows Live.
- The event still carries the whole row, with the same five fields as `GET /api/pings`, for outside callers.

### Why

- One source of truth. The server already filters, counts and pages, so the browser doesn't repeat it.
- Every page and every filter updates live, not only page 1.
- The hook is about half the size, with one reconnect path.
- The 5-second retry covers what the browser's own retry doesn't. After an HTTP error, like nginx's 502 while pm2 restarts the app, `EventSource` gives up for good. The server asks for a 2-second retry, so waiting 5 never loops tightly.

### Alternatives considered

- Inserting streamed rows in the browser, the first version. It's covered above.
- Fetching the page from `GET /api/pings` on each event. The dashboard would need a client data layer, which decision 9 turned down.

### Consequences

- Each ping costs one server render for every open tab. At one ping every 5 minutes, that's nothing.
- `next dev` reloads the whole page when it restarts, so in development a reader can only see the reconnect path by cutting the network while the server stays up.

---

## 28. Option B, LLM insights, for the AI enhancement

Date: 2026-10-01 · Status: accepted · Built: incidents in decisions 29 to 38, the chat in decisions 39 to 49 · Payload analysis amended by decision 54

### Context

The brief makes an AI enhancement optional but "strongly encouraged", and offers three options. A is anomaly detection with statistics. B is LLM insights: a chat that answers questions about the data, automatic incident reports, and cost controls. C is payload analysis and search.

### Decision

We build Option B, in two waves. The first wave is built: incident reports and the shared model layer. That's `src/services/llm.ts`, `src/services/incidents.ts`, the incident routes and pages, and a usage card on the dashboard. The second wave is the chat. Its plan is in [`docs/plan-llm-insights.md`](plan-llm-insights.md). It's built too: `src/services/chat.ts`, the chat widget and `POST /api/chat` (decisions 39 to 49, then 53).

### Why

- It covers the most of what the brief lists for the AI work: a chat, reports written automatically, and cost controls, each in its smallest useful form.
- Its incident detection already holds the simplest part of Option A: comparing each ping with its recent average (decision 33).
- Its cost controls are part of the brief, so they're built and tested with the feature, not added afterwards.

### Alternatives considered

- Option A, anomaly detection. Pure statistics, with no outside service. It's the cheapest option, and our incident detection covers its simplest version anyway.
- Option C, payload analysis. httpbin echoes back the random payload we sent, so there's little to learn from it. The incident prompt includes the payload and the response instead.

### Consequences

- One feature now depends on a model provider. Without one, incidents are still recorded, with a `failed` report, and everything else works.
- Payload analysis isn't a separate feature. The model gets the payload and the response, cut to 2000 characters each, inside the incident prompt.

---

## 29. The AI SDK for model calls

Date: 2026-10-01 · Status: accepted

### Decision

Model calls go through Vercel's AI SDK: `ai` 7.0.126 and `@ai-sdk/openai` 4.0.83, pointed at an OpenAI-compatible endpoint with `createOpenAI({ baseURL, apiKey })`. `gpt-tokenizer` 4.0.0 counts prompt tokens locally. Only `src/services/llm.ts` imports the provider and the tokenizer.

### Why

- Structured output is one call. `generateText` with `Output.object({ schema })` sends our Zod schema as a JSON schema and checks the answer against it.
- The chat needs streaming, tools and a browser hook (`useChat`). The SDK has all three, so both waves use one library.
- It takes Zod 4, which we already use (decision 11), and it reports the token usage of every call.
- Tests swap in `MockLanguageModelV4` from `ai/test`, so no test reaches the proxy.

### Alternatives considered

- Calling the proxy by hand with `fetch`. One request is easy, but we'd own the schema conversion, the parsing, the usage fields and the error types, and then do it all again for streaming and tools in the chat.

### Consequences

- AI SDK 7 renamed things older examples use: `instructions`, not `system`. `generateObject` is deprecated, so we call `generateText` with `Output.object`.
- A change of provider or library touches one file.

---

## 30. The Responses API, not chat completions

Date: 2026-10-01 · Status: accepted · Amended by decision 55: with `AI_GATEWAY_API_KEY` set, calls go through the AI Gateway instead of the proxy

### Context

Locally, the model is reached through `openai-oauth`, an OpenAI-compatible proxy at `http://localhost:10531/v1`. It serves both `/v1/chat/completions` and `/v1/responses`. Its chat-completions route rebuilds each request and drops `response_format`, without an error. A structured call there still succeeds, but the model never sees the schema.

### Decision

`src/services/llm.ts` builds the model with `provider.responses(model)`, the Responses API.

### Why

The proxy passes `/v1/responses` through almost unchanged, so the JSON schema reaches the model.

### Alternatives considered

- `provider.chat(model)`, chat completions. It's the more familiar API, but this proxy drops the schema on it.
- Asking for JSON in the prompt and parsing the text ourselves. It works on either route, but nothing holds the model to the schema.

### Consequences

- Whatever `LLM_BASE_URL` points at must serve `/v1/responses`.
- The proxy keeps no state and forces `store: false`. A single structured call doesn't notice. The chat's multi-turn calls must set `providerOptions.openai.store: false`, or the SDK sends `item_reference` items that the proxy rejects. They do (decision 44).
- The proxy needs no key, but the provider won't start without one, so `LLM_API_KEY` defaults to `not-needed`.

---

## 31. No retries on model calls

Date: 2026-10-01 · Status: accepted

### Decision

Every model call sets `maxRetries: 0` and an `AbortSignal.timeout`: every structured call gets 20 seconds, and a chat answer gets 60 (decision 47).

### Why

- The AI SDK retries twice by default. Each retry is a real model call that the hourly budget doesn't count, because the budget counts saved rows, one per call (decision 37). A flaky provider could triple the calls behind the cap's back.
- The abort already bounds the call. Retries would only add uncounted attempts.
- A missed report loses no data. The incident is saved anyway, with a `failed` report (decision 34).

### Consequences

- One failed attempt means a `failed` report. The incident, its severity and its numbers are still saved.
- A run of the ping job can now take about 50 seconds: 30 for httpbin and 20 for the model. Runs only stay apart while `PING_INTERVAL_MS` is above 50000.

---

## 32. Keep the model budget in tables, not memory

Date: 2026-10-01 · Status: accepted

### Decision

The hourly budget and the cost estimate are read from the database on every check. `src/services/llm.ts` counts written incident reports and the assistant messages that reached the model (decision 45) in the trailing hour, and sums the token columns since midnight UTC. Nothing about the budget lives in memory.

### Why

- pm2 restarts the app on every deploy. A counter in memory would start again at zero each time, and a crash loop could spend far past the cap.
- Every model call already saves a row. Counting those rows needs no new table, and it can't drift from what really happened.
- `createdAt` is indexed on both tables, so the counts are cheap.

### Alternatives considered

- A counter in memory. The simplest, but a restart resets it.
- A separate `llm_call` table with one row per call, which the first plan had. It repeats what the incident and message rows already hold.

### Consequences

- A model call's tokens are stored on the row it produced (decision 37).
- A call isn't counted until its row is saved. Calls that start at the same moment could pass the cap by a few. Incident reports can't, at one ping every 5 minutes. Chat answers can: answers asked at the same moment all pass the check before any of them is saved, so the cap can be passed by as many as start together. We accept that for now.

---

## 33. Severity comes from arithmetic, not the model

Date: 2026-10-01 · Status: accepted

### Decision

`src/services/incidents.ts` decides everything about an incident with plain arithmetic, before the model is asked:

- Each saved ping is compared with the average duration of the successful pings in the 24 hours before it. With fewer than 12 of them, the average is too noisy, and there's no incident.
- A ping is an incident when it failed, or took at least 2 times that average.
- Its severity is `critical` when it failed or took at least 5 times the average, and `warning` otherwise.

The model only explains. It writes a one-sentence summary, 2 to 4 likely causes and 2 to 4 recommendations. Its instructions say the monitor has already decided, and its output has no severity field.

### Why

- The same ping always gets the same answer, and a test can check it exactly.
- Detection doesn't depend on the model. With the proxy down or the budget spent, incidents are still found and graded.
- A model asked to grade severity can answer differently for the same numbers.

### Alternatives considered

- Letting the model decide whether a ping is an incident, and how bad it is. Less code, but no repeatable answer, and no answer at all when the model is unavailable.

### Consequences

- The average counts only successful pings, so a burst of fast failures can't drag it down.
- A failed ping is always critical, whatever its duration.
- After a fresh start, there are no incidents until 12 successful pings exist. That's an hour at the default interval.

---

## 34. Save the incident row before asking the model

Date: 2026-10-01 · Status: accepted

### Decision

`reportIncidentForPing` first saves the incident with `reportStatus: "pending"`. Then it asks the model, and updates the row to one of three statuses:

- `written`: the report and its token counts are saved.
- `skipped_budget`: the hourly budget was spent, so the model wasn't asked.
- `failed`: something in the report step threw. The proxy was down, the call timed out, the answer didn't match the schema, or the prompt was over 6000 tokens. The error is logged with the incident's and the ping's ids.

The ping job runs this as a second step after `recordPing`, in its own try/catch.

### Why

- The incident is the fact, and the report explains it. A slow or failed ping is recorded whatever happens to the model.
- It's the rule from decision 22: save first, then do the parts that can fail.
- With the model kept out of `recordPing`, a model problem can never lose or fail a ping, and the core process (decision 23) stays as it was.

### Alternatives considered

- Saving the incident only once its report is back. A model outage would hide every incident during it.
- Calling the model inside `recordPing`. A slow model would hold up the ping's own broadcast and log.

### Consequences

- A row is `pending` for as long as the call takes, up to 20 seconds. If the app stops in that window, it stays `pending`, and its page says "Report in progress".
- Reports aren't retried later. A `failed` or `skipped_budget` incident keeps that status.

---

## 35. Send incidents as an `incident` event on the same channel

Date: 2026-10-01 · Status: accepted

### Decision

`broadcastIncident` in `src/services/live-updates.ts` sends the saved incident row on the same better-sse channel as pings, with the event name `incident`. It's sent once the report step ends, whatever the report's status. `useRefreshOnNewPing` refreshes the page on both `ping` and `incident`.

### Why

- One stream per tab. A second stream route would double the open connections, and nginx, HTTP/2 and the shutdown code would all have to handle it (decisions 6 and 26).
- The event name keeps the two apart for outside callers, who can listen for just one.
- A report lands a few seconds after its ping. The `incident` event refreshes the page again once it's saved, so a report never waits for the next ping to appear.

### Alternatives considered

- A separate stream route for incidents. Twice the connections, for an event that only comes with a slow ping.
- No event, leaving pages to catch up on the next ping. A report would show up to 5 minutes late.

### Consequences

- A broadcast that throws is logged with the incident's id, and the incident is still returned, as with pings (decision 22).
- Every page with the hook refreshes on both events. So the Incidents page also re-renders on every ping, even though a ping alone rarely changes it. That's one extra server render per open tab every 5 minutes.
- The stream route is still `/api/pings/stream`. Its name is older than the second event.

---

## 36. Create the chat tables now, use them in the chat wave

Date: 2026-10-01 · Status: accepted · The chat writes them since decision 41

### Decision

One migration, `20261001154533_add_incidents_and_chat`, creates three tables: `incident`, `chat_session` and `message`. Nothing writes to `chat_session` or `message` yet. The chat wave will.

### Why

- The budget counts assistant messages from the start (decision 37). With the `message` table in place, `src/services/llm.ts` and its tests were written once, against both tables.
- The plan agreed the schema for the whole feature, so one migration holds it.

### Alternatives considered

- Adding the chat tables with the chat. Tidier on paper, but the budget code and its tests would change a second time.

### Consequences

- `src/models/message.ts` and `src/models/chat-session.ts` exist, with tests, before any service writes through them.
- Until the chat is built, the assistant-message count is always 0, so the cap only counts incident reports.

---

## 37. The hourly cap counts written reports plus assistant messages

Date: 2026-10-01 · Status: accepted · Amended by decision 45

### Decision

`LLM_CALLS_PER_HOUR`, 20 by default, caps model calls in any trailing 60 minutes. A call counts when it left an incident with `reportStatus: "written"` or a `Message` row with role `assistant` in that hour. Each of those rows stores the tokens of the call that produced it, in `inputTokens` and `outputTokens`.

Since decision 45, an assistant message counts only when it reached the model, with `inputTokens` above 0. Cache hits and refusals are saved as assistant rows with 0 tokens, and don't count.

The dashboard's usage card shows the calls this hour against the cap, when the oldest one leaves the window, and the estimated spend since midnight UTC.

### Why

- Each of those rows is exactly one model call, so counting rows counts calls.
- A trailing hour has no cliff on the hour, where a full budget could be spent twice in two minutes.
- With tokens on the row, the cost needs no extra table, and each incident's page shows what its report used.

### Alternatives considered

- A cap on tokens instead of calls. The brief sets the cap in calls, and the 6000-token limit on each prompt already stops one call from running away.

### Consequences

- A call that reached the model but ended `failed`, like an answer that didn't match the schema, isn't counted, though the provider may still bill it. With retries off (decision 31), that's at most one uncounted call per incident.
- With no calls in the hour, the card says the budget resets now, which reads oddly.

---

## 38. Price the model calls from a table of estimates

Date: 2026-10-01 · Status: accepted · Amended by decision 56: cached input tokens are priced at the cached rate

### Decision

`USD_PER_MILLION_TOKENS` in `src/services/llm.ts` holds a price per million input and output tokens for each model: $5 in and $30 out for gpt-5.5, and a default of $1.25 in and $10 out for any model not listed. `estimateUsd` multiplies the stored token counts by these prices. The usage card shows the result as "About $… estimated today".

### Why

- The provider reports tokens, not money, so there's nothing to read a cost from.
- An estimate is enough to see what a report costs, what the cap allows at worst, and when spend jumps. The cost analysis in `cost-analysis.md` uses the same prices.

### Consequences

- Both rows are estimates, not a bill. Through the local proxy, the figures are what the same tokens would cost at those prices.
- Update the table when the model or its price changes. A model not in the table falls back to the default price without a warning.

---

## 39. One `queryDatabase` tool with checked Prisma arguments

Date: 2026-10-01 · Status: accepted

### Context

The chat answers questions about the pings and incidents, so the model has to read the database. The questions are open: "how many pings failed this week", "the slowest ping today", "incidents by severity".

### Decision

The model gets one tool, `queryDatabase`, defined in `src/services/chat.ts`. Its input is `{ table, method, arguments }`:

- `table` is `ping` or `incident`.
- `method` is `findMany`, `aggregate` or `groupBy`, Prisma's three read methods.
- `arguments` are the Prisma arguments for that method, written by the model as JSON.

The tool's `execute` checks the input with `chatQuerySchema` in `src/lib/chat-query.ts`, then hands it to `queryPings` or `queryIncidents` in the models, which pass the arguments to Prisma. The schema accepts only:

- `where` over the table's own columns. Numbers and dates take `equals`, `not`, `gt`, `gte`, `lt`, `lte` and `in`. Text takes `equals`, `not`, `in`, `contains` and `startsWith`. `AND` and `OR` go one level deep.
- `orderBy`, `select`, `skip`, and `take` from 1 to 100, 20 by default.
- `_count`, and `_avg`, `_sum`, `_min` and `_max` over numeric columns. `_min` and `_max` also take `createdAt`.
- For `groupBy`: `by`, an `orderBy` on grouped columns only, and `take` only with an `orderBy`.

Every object is strict, so an unknown key fails. `payload` and `response` on pings, and `likelyCauses` and `recommendations` on incidents, can be selected but not filtered. Pings leave them out unless `select` asks for them. Relations, like `include` or a filter on an incident's ping, aren't accepted.

Rows are dropped from the end of a result until its JSON fits in 8000 characters, and the result says `truncated: true`. Aggregates come back whole. A query the schema rejects throws "The query was rejected." with Zod's description of what's wrong. The model gets that as the tool's error, and can fix the query in its next step.

### Why

- The model never writes SQL. There's no SQL string, no raw query and no eval. Only the three read methods are wired up, so nothing the model sends can write.
- Prisma's argument shape is well known to models, and one tool covers counts, averages, extremes, breakdowns and lists of rows.
- The schema is the whole safety boundary, and it's plain code with its own tests: 48 cases in `tests/lib/chat-query.test.ts`.

### Alternatives considered

| Option | Why not |
|---|---|
| Letting the model write SQL, run as a read-only database user | Staying read-only would depend on how the database is set up, not on our code. Nothing would cap the rows or stop a heavy query, and production would need a second database role. |
| One fixed tool per kind of question, like `countFailedPings(from, to)` | Safe, but every new kind of question needs new code. The chat could only answer what we predicted. |
| Putting recent rows into the prompt | The prompt grows with the table, and the 6000-token limit would cut it off within a day. |

### Consequences

- A query reads one table. A question that needs both takes two queries. Incidents carry their own `durationMs`, so most don't.
- `take` caps the rows returned, but `aggregate` and `groupBy` read every matching row. At 288 pings a day that's cheap.
- The chat shows each query as a collapsed block with its arguments and result, so a reader can check where a number came from.
- A rejected query costs one of the answer's 4 steps.

---

## 40. The browser calls one API route, for the chat

Date: 2026-10-01 · Status: accepted · Revisits decision 9 · The chat widget calls four chat routes since decision 53

### Context

Decision 9 kept the browser from fetching data. Pages load on the server, and the API routes are for outside callers. It said to revisit this if a feature ever took user input. The chat does: the user types a question, and the answer streams back.

### Decision

- `POST /api/chat`, in `src/app/api/chat/route.ts`, is the one route the browser calls. `useChat` from `@ai-sdk/react` posts `{ id, messages }` to it through `DefaultChatTransport` and reads the answer as a UI message stream.
- The route checks the body (decision 42), calls `answerQuestion` in `src/services/chat.ts`, and returns its streamed `Response`. A body it can't read gets a 400, and an unknown session a 404.
- `GET /api/chat/sessions` lists the 20 newest sessions. As first built it was for outside callers only: the chat page didn't call it, and loaded the list on the server. Decision 53 removed the page, and the widget now calls it for the history menu, and `GET /api/chat/sessions/:id` to load a conversation.
- Everything else stays as decision 9 has it. The chat pages loaded their session on the server until decision 53 removed them, and there are still no server actions.

### Why

- `useChat` needs an HTTP endpoint that streams. Its transport posts JSON and reads the answer as it arrives.
- A route can be called with curl and tested like the others, and the brief asks for REST.

### Alternatives considered

- A server action behind a custom `useChat` transport. It's more code of our own for the same stream, and nothing outside the app could call it.

### Consequences

- "The browser never fetches" now has one exception, written down in `AGENTS.md`.
- There's no login (decision 18), so anyone who can reach the site can ask questions and spend the hourly budget. The cap is the only limit. When the chat spends it, incident reports in that hour are skipped too.

---

## 41. Save conversations in the database

Date: 2026-10-01 · Status: accepted · Amended by decision 53: the `/chat` pages are gone, and the widget starts a session with its first question, so a visit no longer leaves an empty session

### Decision

- `/chat` creates a `chat_session` row with a random id and redirects to `/chat/:id`. The id is a plain token of 1 to 64 letters, digits, `_` or `-`, read by `parseChatSessionId` in `src/lib/chat-session-id.ts`. Any other id, or an unknown one, gets the Not found page.
- Once an answer ends, the question and the answer are saved as `message` rows, a millisecond apart so they sort in order. Each row keeps the AI SDK message's `parts` as JSON, so tool calls come back with their arguments and results. An answer also keeps its tokens.
- `/chat/:id` loads the session's messages on the server and hands them to `useChat`, so a reload, or a shared link, shows the whole thread.
- A session's title is the first 80 characters of its first question, set when the first answer is saved. The side list shows the 20 newest sessions.

### Why

- A reload shouldn't lose the conversation.
- The budget and the cost estimate already count model calls from saved rows (decision 32). The saved answer is that row.
- The answer cache reads saved answers (decision 46).
- `parts` is what `useChat` holds, so loading a session needs no conversion.

### Alternatives considered

- Keeping the thread in the browser's storage. It's lost on another device, and the server would have nothing to count.
- A separate table for tool calls. They live inside the answer's `parts`, and nothing needs to query a call on its own.

### Consequences

- Every visit to `/chat` starts a session, so a chat left empty still shows in the list as "New chat".
- Sessions that start with the same question get the same title.
- There's no way to delete a conversation, and the tables only grow.

---

## 42. Send the whole conversation with every question

Date: 2026-10-01 · Status: accepted

### Decision

- `useChat` sends the whole message list with every question. That's its default.
- The route checks the body with `parseChatRequest` in `src/lib/chat-request.ts`. Zod checks the envelope: `{ id, messages }`, with a non-empty id and a non-empty list. The AI SDK's `safeValidateUIMessages` then checks every message, and the list must end with the user's question. Anything else gets a 400 before the model is asked.
- The server saves only the newest question and the answer. The earlier messages are already saved, and a question saved twice, as on Retry, is skipped.
- Only the server sets token counts. Counts the browser puts on a message are ignored, and questions are saved with 0.

### Why

- It's `useChat`'s default, so there's no transport code of our own.
- A follow-up needs the earlier turns, including the tool calls and their results, and the browser already holds them.
- The checks turn a broken or hand-written body into a 400, not a model call.

### Alternatives considered

- Sending only the new question and loading the history from the database, through `prepareSendMessagesRequest`. The server would trust nothing from the browser but the question, at the cost of a read per question and custom transport code. Worth it if the chat ever gets logins.

### Consequences

- The caller decides what history the model sees, and could send a made-up one. With no login and read-only data, that only misleads their own chat. What's saved is their question and the real answer.
- The 6000-token check counts the text of the whole conversation. A long chat reaches it in the end, and every further question gets the "too long" refusal (decision 45). The way out is a new chat.
- Every question resends the history, so input tokens grow with the conversation. The provider keeps nothing between questions (decision 44).

---

## 43. Build the chat screen from AI Elements, shadcn and Streamdown

Date: 2026-10-01 · Status: accepted

### Context

Vercel's AI Elements is a registry of chat components in the shadcn style. It's written for shadcn on Radix, and we use shadcn on Base UI (decision 13). Copied code breaks in two ways. Radix's `asChild` prop doesn't exist in Base UI, which uses `render`. And Radix marks an open panel with `data-state="open"`, while Base UI uses `data-open`, `data-closed` and, on a trigger, `data-panel-open`.

### Decision

The chat screen mixes three sources:

| Piece | From | What it does |
|---|---|---|
| `Conversation` and its parts | AI Elements `conversation`, on `use-stick-to-bottom` | Keeps the view pinned to the newest message while an answer streams, with a scroll-down button |
| `Tool` | AI Elements `tool`, patched | One collapsed block per query, titled "Queried pings" or "Queried incidents", with its state, arguments and result |
| `Loader` | AI Elements `loader` | The spinner beside "Thinking…" |
| `CodeBlock` | AI Elements `code-block`, on shiki | The JSON inside a tool block |
| `Message` and `Bubble` | shadcn's own `message` and `bubble` | The question and answer bubbles, and the token line under an answer |
| `Textarea`, `Button` and `Collapsible` | shadcn | The question box, Send, Stop, Retry and the suggestion chips |
| Markdown in answers | Streamdown | Renders markdown that's still arriving |

- The four AI Elements files were copied into `src/components/ai-elements/`. Like `src/components/ui/`, they're in the `VENDORED` list in `eslint.config.mjs`, so only Next's own lint rules apply to them.
- `tool.tsx` is patched for Base UI. Its `data-[state=open]` and `data-[state=closed]` classes became `data-open` and `data-closed`, and the chevron turns on `group-data-panel-open`.
- AI Elements' `message` and `prompt-input` weren't taken, because they use `asChild`. shadcn's own `message` and `bubble` work on Base UI as they are, and the question box is a shadcn `Textarea` and `Button` in a form.
- `src/app/globals.css` has `@source "../../node_modules/streamdown/dist/*.js"`, so Tailwind generates the classes Streamdown uses.
- New packages: `@ai-sdk/react` 4.0.129, `streamdown` 2.7.0, `shiki` 4.5.0 and `use-stick-to-bottom` 1.1.6.

### Why

- Scroll-pinning during a stream, collapsible tool blocks and a loader are the fiddly parts of a chat screen. The Radix-free AI Elements components have them working.
- Streamdown copes with markdown that arrives a few characters at a time, like a `**` that hasn't closed yet.
- shadcn's own chat components are built for the style we use, so they need no patches.

### Alternatives considered

- All of AI Elements. `message` and `prompt-input` would need rewriting from `asChild` to `render`, again after every update.
- Moving shadcn back to Radix. It would change every existing component for one screen.
- Writing the whole screen by hand. The scroll and tool blocks are real work that AI Elements has already done.

### Consequences

- Updating an AI Elements file means applying the Base UI patch again. Check its `data-` classes after any update.
- Vendored files skip our style and screen rules, so `tool.tsx` keeps raw colours like `text-green-600` on its status icons.

---

## 44. `store: false` on every chat call

Date: 2026-10-01 · Status: accepted · Extended by decision 55: every call, structured ones too, now sends `store: false`

### Context

The Responses API can keep each response on the provider's side, and does by default. The AI SDK then points at earlier turns with `item_reference` items instead of resending them. The local `openai-oauth` proxy keeps no state, forces `store: false`, and rejects those references (decision 30).

### Decision

`streamAnswer` in `src/services/llm.ts` sets `providerOptions.openai.store: false` on every chat call. Each call carries the whole conversation as plain messages.

### Why

- Without it, every follow-up through the proxy fails.
- Our database already holds the conversation (decision 41). A copy at the provider adds nothing, and this way nothing we send is kept there.
- It works the same on any OpenAI-compatible endpoint, with state or without.

### Consequences

- Every call resends the history. The browser already sends all of it (decision 42).
- `tests/services/llm.test.ts` checks that the option is sent.

---

## 45. Only answers that reached the model count against the cap

Date: 2026-10-01 · Status: accepted · Amends decision 37

### Context

Decision 37 counted every assistant `Message` row as a model call. The chat also saves answers that never reach the model: cache hits (decision 46) and two fixed refusals. Counting those would overstate the calls, and a refusal for a spent budget would itself keep the budget spent.

### Decision

- The hourly cap counts written incident reports plus assistant messages with `inputTokens` above 0. The model functions are `countChargedAssistantMessagesSince` and `findOldestChargedAssistantMessageSince` in `src/models/message.ts`.
- Cache hits and refusals are saved as assistant rows with 0 tokens. They show in the thread but don't count.
- An answer is one call, however many model steps it took. Its tokens are the total of every step.
- An answer with no text but with tokens, like one that spent all 4 steps on queries, is still saved and counted. An answer with no text and no tokens isn't saved.
- Only the server sets tokens, and only on assistant rows (decision 42).

The two refusals are fixed texts, sent as the answer without calling the model:

- "The model budget for this hour is spent. It resets at HH:MM UTC." The time is when the oldest counted call leaves the window.
- "That question is too long for one call. Ask something shorter." This one comes when the instructions plus the conversation's text pass 6000 tokens.

### Why

- The cap limits model calls. A cache hit or a refusal makes none.
- A refusal that counted would push the reset time later with every try.
- The count still comes from saved rows, as decision 32 has it.

### Consequences

- One counted call can be up to 4 model requests. The stored tokens, and so the cost estimate, include all of them.
- An answer that broke off with an error before the model reported its usage is saved with 0 tokens and isn't counted, though the provider may bill it. It's the same gap as a failed report in decision 37.
- The usage card and the budget refusal read the same rows, so they agree on the reset time.

---

## 46. Cache a first question's answer for one hour

Date: 2026-10-01 · Status: accepted · Amended 2026-10-02: follow-ups are cached too, see the note at the end

### Decision

- When a conversation has exactly one user message, `src/services/chat.ts` hashes it: sha256 of the model id and the question, trimmed and lower-cased. The answer's row keeps the hash in `questionHash`.
- Before calling the model, it looks for an assistant row with the same hash from the last hour, in any session. If it finds one, it sends that answer's text back with `metadata.cached = true`, and makes no model call. The answer shows "0 tokens, from cache".
- Only answers that finished with `stop` get a hash. An answer that broke off or ran out of steps is never served from the cache, and neither is a refusal.
- A cache hit is saved with 0 tokens and no hash. It doesn't count (decision 45), and the hour still runs from the original answer.

### Why

- The three suggestion chips ask the same questions in every new chat. The cache answers the repeats for free.
- The brief lists caching among the cost controls.
- A follow-up depends on the conversation before it, so only first questions are safe to reuse.
- The model id is in the hash, so changing `LLM_MODEL` starts a fresh cache.
- One hour matches the budget's window.

### Alternatives considered

- Caching each query's result. Most of an answer's tokens are the model reading its instructions and the conversation, not the query, so this saves little.
- Hashing whole conversations, to cache follow-ups too. Two chats rarely match word for word past the first question.
- Matching similar questions with embeddings. Another model call and another moving part, for a few more hits.

### Consequences

- A cached answer can be up to an hour old. Asked again, "how many pings failed in the last hour?" can get numbers that have since changed.
- Only the text is replayed. The original answer's query blocks don't show on a hit.
- `cached` isn't stored. After a reload, a cached answer shows as a 0-token answer, without "from cache".

### Amended 2026-10-02: follow-ups are cached too

- The hash now covers every user question in the conversation so far, not only the first: sha256 of the model id, then each question's text, trimmed and lower-cased, in order, joined with a NUL character. A conversation with one question hashes exactly as before, so rows saved earlier still match.
- So a follow-up comes from the cache when another chat asked the same questions in the same order within the hour, like "How many pings failed this week?" then "And the slowest?". The same follow-up after a different first question asks the model.
- The answers in between aren't part of the hash. Two chats that asked the same questions within the hour were answered from the same data, so their answers differ only in wording.
- The rest stands: one hour, only answers that finished with `stop`, and hits and refusals saved without a hash. The column keeps its name, `questionHash`.
- The alternative above, "two chats rarely match word for word past the first question", is still true of free text. But a lookup costs one indexed query, and the suggestion chips make repeated sequences likely.

---

## 47. Let the server finish an answer after Stop

Date: 2026-10-01 · Status: accepted

### Decision

- Stop, or closing the tab, ends the browser's connection, but not the answer. In `src/services/chat.ts`, `answer.consumeStream()` reads the model's stream to the end, and `consumeSseStream: consumeStream` reads the UI message stream to the end with nobody listening. So `onEnd` still runs, and the whole answer is saved with its tokens.
- A follow-up still works after a Stop in the middle of a query. `convertToModelMessages` runs with `ignoreIncompleteToolCalls: true`, so the half-finished tool call the browser kept is left out.
- The 60-second abort and the 4-step limit still bound the answer.

### Why

- The model keeps running whether or not anyone reads the stream. Saving the answer means its tokens count against the budget. If Stop skipped the save, stopping every answer would make uncounted calls.
- The call is already paid for, so its answer is worth keeping.

### Alternatives considered

- Aborting the model call when the browser goes. The tokens spent before the abort would never be counted.
- Resumable streams, so a reload picks the answer up mid-stream. They need Redis or another shared store, which this app doesn't have.

### Consequences

- After Stop, a reload shows the whole answer, more than the user saw.
- Stop doesn't save money. It only stops the screen.

---

## 48. Tell the model the current UTC time

Date: 2026-10-01 · Status: accepted

### Decision

The chat's instructions end with the time the question was asked, like "It is now 2026-10-01 17:35 UTC, so today is 2026-10-01." They also:

- say every time in the database is UTC, and to say UTC when giving one
- list both tables' columns, and what a null `statusCode` or `error` means
- give the incident rules: the 24-hour average, the 12-ping minimum, 2 and 5 times the average, and the report statuses
- say to use the tool for every number and never guess one, preferring `aggregate` for totals and `groupBy` for breakdowns over `findMany`
- ask for a few plain sentences, without markdown tables, and to say so when the data doesn't cover the question

### Why

- The model has no clock, and questions like "this week" or "the last 24 hours" need one.
- With only the date, the model read "the last 24 hours" as "since midnight". With the time, it builds the right range.
- With the incident rules, it can explain an incident without guessing what one is.
- Aggregates keep tool results small, and so the next step's input tokens too.

### Consequences

- The instructions are built for every question, by `buildChatInstructions`. Their fixed lines are constants at the top of `src/services/chat.ts`, in `CHAT_INSTRUCTION_LINES`.
- "Today" and "this week" are UTC days, not the viewer's.

---

## 49. A loose tool schema for the model, a strict one inside `execute`

Date: 2026-10-01 · Status: accepted

### Context

The AI SDK turns a tool's Zod `inputSchema` into a JSON schema and sends it with every model step. `chatQuerySchema` is large: six shapes, with every column and operator spelled out. As the tool's schema it would cost tokens on every step, and parts of it come out as `propertyNames`, which OpenAI's tool schemas don't support. The provider strips it with a warning.

### Decision

- The schema the model sees is small: `table` and `method` as enums, and `arguments` as `zod.looseObject({})`, any object. The tool's description lists the columns, operators and limits in plain words.
- `execute` checks the input against the strict `chatQuerySchema` before anything reaches Prisma (decision 39). A query that fails comes back to the model as "The query was rejected." with Zod's explanation.
- The chat screen shows only that message. Any other error in the stream shows as "An error occurred.", so nothing internal reaches the browser.

### Why

- Fewer tokens on every step, and no warning.
- The model-facing schema was never the safety boundary. The input arrives as JSON we have to check anyway, so the strict check sits where it can't be skipped.
- The rejection names what's wrong, so the model can fix it in its next step.

### Alternatives considered

- Sending `chatQuerySchema` as the tool's schema. It's the most precise guide for the model, but it's large on every step and trips the `propertyNames` warning.

### Consequences

- The model can send a query the schema rejects, which costs a step. A few rejections can use all 4 steps, and the answer is then saved with its tokens and no text.
- The tool's description and `chatQuerySchema` must agree. Change them together.

---

## 50. Biome formats the code

Date: 2026-10-02 · Status: accepted

### Decision

- Biome formats every TypeScript, JavaScript, JSON and CSS file. Its linter is off, so ESLint stays the one linter.
- Lines are up to 120 characters, with 2-space indents, double quotes, no semicolons and trailing commas. Biome also sorts the imports. The settings are in `biome.json`.
- After an edit, one hook, `.claude/hooks/format-on-edit.sh`, formats the file and then runs the ESLint check. Matching hooks run side by side, so two separate hooks would race on the same file.
- `pnpm format` formats the whole project and `pnpm format:check` checks it. CI runs the check before lint.

### Why

- ESLint has no formatter. Without one, the layout of each file depends on who wrote it.
- Biome is one fast binary. It formats the whole project in well under a second.
- With only its formatter on, our own ESLint rules stay, and Biome's linter has nothing to replace them with (decision 15).
- Formatting is safe to apply by itself. It only moves code around and never changes names or behaviour, unlike the lint auto-fixes decision 15 turned down.

### Alternatives considered

- Prettier. It's slower, needs more config, and brings another dependency tree.
- Biome's linter too. It would duplicate or replace the custom ESLint rules.

### Consequences

- Lines run to 120 columns. The formatter spreads long calls and objects over many lines, so the 8-line function limit was replaced with a limit of 8 statements (decision 16).
- shadcn's files, AI Elements' files and Prisma's generated code aren't formatted. The vendored paths in `biome.json` must match the `VENDORED` list in `eslint.config.mjs`.
- `globals.css` uses Tailwind's own directives, so `biome.json` turns on `css.parser.tailwindDirectives`.
- Hooks load when a session starts, so a running session needs a restart, or `/hooks`, to pick up the new hook.
- The first run reformatted 63 files. Lint, the type check and the tests passed without any code changes.

---

## 51. Constants in capitals at the top

Date: 2026-10-02 · Status: accepted

### Decision

- A top-level constant that holds a plain value is written in capitals, like `HTTPBIN_URL` or `RECENT_INCIDENT_LIMIT`, and goes at the top of the file, right after the imports. In tests it goes after the `vi.mock` calls. A plain value is a string, number or boolean, a sum or template built from those and other constants, or a list or object made only of them, like `VOCABULARY`, `SESSION_OPTIONS` or `BADGE_VARIANTS`.
- Everything else keeps its camelCase name and its place: Zod schemas, `new` instances like `new Intl.NumberFormat()`, `globalThis` holders, functions, components, and values worked out by calling a function. Values that call a helper in the same file, like `environment = readEnvironment()`, the Prisma client and `languageModel`, still go at the very bottom (decision 16).
- Lint checks it with `@typescript-eslint/naming-convention`: a top-level `const` whose type is a string, number or boolean must be in capitals. The check goes by type, so a string or number read from a value worked out at load time is in capitals too, like `DATABASE_URL = environment.DATABASE_URL` in `config/env.ts`. It stays below the value it reads.
- Next's route options, like `dynamic`, are left out of the check, because Next reads them by name. The banned type prefixes and vague names still apply to names in capitals, as `STR_…` and `DATA`.
- The settings `config/env.ts` exports now have the same names as their environment variables: `DATABASE_URL`, `LOG_LEVEL`, `PING_INTERVAL_MS`, `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL` and `LLM_CALLS_PER_HOUR`.

### Why

- Capitals mark a fixed value wherever it's used in a long service file. It's the usual TypeScript convention.
- At the top, a file's numbers to tune, like the incident thresholds and the timeouts, can be read in one place instead of after every helper.
- A plain value calls nothing, so it can sit above the helpers without the crash on start that decision 16 guards against. A value that calls a helper in the same file can't, so it stays at the bottom.
- Checking by type needs no list of names, and it catches new constants by itself.

### Alternatives considered

- Keeping camelCase constants at the bottom. It worked, but fixed values didn't stand out or sit together.
- A custom lint rule that looks at what's on the right of the `=`. It could tell a literal from a call, but it's more code to own than one `naming-convention` entry.
- Checking lists too, with `types: ["array"]`. It flags the empty arrays tests fill as they run, like `createdSessionIds`, which aren't constants. Lists of plain values are in capitals by this rule, without a lint check.

### Consequences

- Lint now needs type information. `eslint.config.mjs` turns on TypeScript's project service, and the root `.js` and `.mjs` files join it through `allowDefaultProject`. A full `pnpm lint` takes about 12 seconds, and one file about 4.
- Strings in tests that come from a call, like `RUN_ID = randomUUID()`, `SESSION_ID` and `TEST_DAY_QUERY`, are in capitals because lint goes by type. They stay where they were, below anything they read.
- Objects that hold a `Date`, a call's result or a function stay camelCase, like `runMarker` and the `incident` fixture in the live-updates test.
- `vitest.config.mts` falls under the check too, so its `emptyServerOnly` became `EMPTY_SERVER_ONLY`.

---

## 52. Services re-export model reads they don't change

Date: 2026-10-02 · Status: accepted

### Decision

- When a page or route needs a model read exactly as it is, the service re-exports it under the model's name: `export { findPingById } from "@/models/ping"` in `services/ping.ts`, and `export { findIncidentById } from "@/models/incident"` in `services/incidents.ts`. They replace `findPing` and `findIncident`, which only forwarded the call.
- A service function stays when it adds something, like `listRecentIncidents` passing the limit of 50, or `listPingHistory` turning rows into `PingRow`s.

### Why

- One name end to end. Following `findPingById` from the page lands on the query, with no extra hop.
- Pages and routes still import only from services, so the layers of decision 8 hold, and lint checks them the same way (decision 20).

### Consequences

- The ping and incident `:id` routes and pages call `findPingById` and `findIncidentById`.
- A test that mocks a service module with a factory must include any re-export the code under test uses. None needs to today.

---

## 53. The chat is a floating widget, not a page

Date: 2026-10-02 · Status: accepted · Amends decisions 40 and 41

### Context

The brief asks for a "chat widget". The chat was a page: `/chat` made a session and redirected to `/chat/:id`, which loaded the conversation on the server. Asking a question meant leaving the dashboard, and every visit to `/chat` left a session behind, even when nothing was asked (decision 41).

### Decision

- `ChatWidget`, in `src/components/chat-widget.tsx`, is mounted once in `layout.tsx`. A button fixed bottom-right opens a panel from the right: full height, full width on phones, and `sm:max-w-md` from `sm` up. The `/chat` pages, `ChatSessionList` and the nav's Chat link are gone.
- The panel is non-modal, with `modal={false}` and `disablePointerDismissal`. The page and the nav stay usable while it's open, and moving between pages keeps it open, because the App Router keeps the layout's client state across navigations.
- The conversation is an AI SDK `Chat` instance, made outside React by `useChatConversation` in `src/hooks/use-chat-conversation.ts` and read with `useChat({ chat })`. Closing the panel doesn't stop an answer, and the button shows a pulsing dot while one streams with the panel closed.
- The browser keeps the current session's id in `localStorage` under `chat-session-id`, with every read and write in a try/catch. On first open, `GET /api/chat/sessions/:id` loads that conversation. A 404 clears the id and starts an empty chat.
- A session is made lazily, inside the `Chat`'s transport. `DefaultChatTransport`'s `prepareSendMessagesRequest` resolves the session id before each request: the first time, it calls `POST /api/chat/sessions` and stores the id. Then it sends `{ id, messages }` to `POST /api/chat`, as before. The `Chat`'s own id is a local key, the session id for a loaded chat and `new-` plus a random id for a new one, so starting the session never replaces the `Chat`.
- The history menu fetches `GET /api/chat/sessions` each time it opens. Picking a chat stores its id and loads it. New chat clears the id and starts an empty chat.
- Two routes were added. `POST /api/chat/sessions` returns `{ id, createdAt, title }` with status 201. `GET /api/chat/sessions/:id` returns `{ session, messages }`, or a 404 for an id that's unknown or can't be read. `startChatSession` and `loadChatSession` return those shapes now.

### Why

- A widget is what the brief names, and it lets someone ask about an incident while looking at it.
- Kept in the layout, the panel and an answer in progress survive navigation with no state library.
- Making the session with the first question means opening and closing the panel writes nothing, which fixes the empty sessions decision 41 accepted.
- The transport is the one place every request passes through: a typed question, a suggestion chip, and Retry, which calls `regenerate()`. Resolving the session there covers all three, and a failed start is just the chat's error, which Retry tries again.
- Creating the session in the submit handler and passing it as `useChat`'s `id` doesn't work. `useChat` makes a new `Chat` when its `id` changes and stops the old one, so the first question would be cancelled as it's sent.
- `useChat` accepts an existing `Chat`, so the button's dot, the panel's title and the screen all read one conversation, and none of them owns it.

### Alternatives considered

- Keeping the `/chat` pages beside the widget. Two ways into the same chat, and the page's server load would repeat what the widget fetches.
- A modal sheet, shadcn's `SheetContent` as it is. It draws a full-page overlay under the panel, so the first click on the nav only closes the panel, and the panel can't stay open across pages. An overlay switch would mean hand-editing `ui/sheet.tsx`, which `.claude/rules/screens.md` rules out. So the panel uses Base UI's `Dialog.Portal` and `Dialog.Popup` directly, inside shadcn's `Sheet`, and `ui/sheet.tsx` stays as the CLI wrote it.
- A round button. shadcn's lint rejects `rounded-full` and `shadow-lg` on `Button`, and a new variant would mean editing `ui/button.tsx`. The button keeps shadcn's rounded square at `size-14`, and a plain wrapper carries the shadow.
- Creating the session in the submit handler, before `sendMessage`, and sending its id in the request body. Suggestion chips and Retry would each need the same step.
- Keeping the session id in the URL. The widget has no route of its own, and a query parameter on every page would end up in shared dashboard links.

### Consequences

- The browser calls four routes now, all of them chat routes. `AGENTS.md` lists them as the exception to "the browser never fetches".
- A conversation no longer has its own link. Its id is in `localStorage`, so it follows the browser, not a URL. `GET /api/chat/sessions/:id` still loads any conversation by id.
- Sessions made by visits to the old `/chat` page stay in the table, and show in the history menu as "Untitled chat". Nothing cleans them up.
- If a new chat's session is made but its first answer request fails before anything is saved, that session stays empty and shows as "Untitled chat" too.
- The panel doesn't trap focus or dim the page. Esc and the Close button close it. On phones it covers the whole screen.

---

## 54. Response analysis: tags in code, one summary a day

Date: 2026-10-02 · Status: accepted · Amends decision 28 · Amended 2026-10-02: the on-demand button and the summary routes were removed, see the note at the end

### Context

Point 3 of the brief asks to analyse httpbin's response payloads: extract and categorise key information, find patterns, and write summaries in natural language. Decision 28 folded payload analysis into the incident prompt, because httpbin only echoes back what we sent. That leaves every normal ping unanalysed, and nothing says what a day looked like. A model call per ping, or per hour, would cost far more than the question is worth.

### Decision

- Every response is tagged in code when it's saved, at no token cost. `recordPing` sets `responseKind` from the status and the body: `failed` with no status code, `gateway_error` for 5xx, `client_error` for 4xx, `empty` for a 2xx with no JSON body, `clean_echo` when httpbin's `json` deep-equals the payload we sent, and `echo_mismatch` otherwise. It also keeps httpbin's `origin`, our public IP, in its own column.
- Migration `20261001223056_add_response_kind` added both columns and tagged every existing row in SQL with the same rules, so old and new rows read alike.
- Once a day the model writes a short summary. `services/response-analysis.ts` works out the day's numbers in code: the total and failed counts, counts per kind and per status code, failures per UTC hour, p50, p95 and max latency of the successful pings, the caller IPs in order of first appearance, and the longest run of consecutive failures. It saves them as a `pending` row in `response_summary`, one per UTC day, then asks the model, through `generateStructured`, for 2 to 4 plain sentences and up to 4 findings. The model only words numbers it's given.
- A timer checks every 5 minutes, and writes yesterday's summary when there's no finished row for it. So it comes within 5 minutes after midnight UTC, and within 5 minutes of a restart that missed it. A summary always covers one whole UTC day.
- The dashboard shows the latest summary in a card at the top. The page loads it on the server through the service. No route serves summaries.
- The summary counts against the hourly budget like a report: a `response_summary` row with `inputTokens` above 0, counted and priced by `createdAt`.

### Why

- The categories are facts the code already knows. Deciding them in code is free, exact and testable, and leaves the model the one job only it does well: putting numbers into a few readable sentences.
- One call a day costs a few hundred input tokens, about half a cent, whatever the ping interval. The prompt carries counts, never rows, so it doesn't grow with the number of pings.
- Saving the statistics first, as with incidents, means a model outage or a spent budget still leaves the day's numbers in the table.
- The origin is the only field in httpbin's reply that can change without us changing anything, so it's the one worth a column. A new origin means the monitor's network changed.

### Alternatives considered

- A model call per ping to analyse its response. 288 calls a day at the default interval, each saying "httpbin echoed the payload", and far past the hourly cap of 20.
- Hourly summaries. 24 calls a day for numbers that rarely change hour to hour, and they would take most of the hourly budget the chat and the reports share.
- Sending the raw responses, or the day's rows, to the model. Thousands of rows don't fit the 6000-token limit, cost grows with the interval, and the model is worse at counting than the code.
- A "Summarize today so far" button, built at first and then removed. See the note at the end.

### Consequences

- `ping` has two more columns, and `PingRow`, the `ping` stream event and `GET /api/pings` rows carry them. Tests that seed pings must give a `responseKind`.
- The chat is still the only place where the browser calls a route.
- Yesterday's summary isn't retried after `skipped_budget` or `failed`.
- The chat's `queryDatabase` tool didn't know the new columns at first. Later the same day both were added to `chatQuerySchema` and to the tool's description together (decision 49): `responseKind` takes only the six kinds, with `equals`, `not` and `in`, and `origin` is nullable text. Both can be selected, grouped by and ordered by.
- A migration that adds a required column needs the running app stopped first, or the old process's next ping fails on the missing value.

### Amended 2026-10-02: the on-demand button and the summary routes were removed

- As first built, the card had a "Summarize today so far" button. It called `POST /api/response-summaries`, which summarized today from midnight UTC to now and rewrote at most once an hour. `GET /api/response-summaries` and `GET /api/response-summaries/:day` served the history to outside callers.
- All three routes, the button and its hook are gone. The brief doesn't ask for them, and we chose a summary once a day. The dashboard page still loads the latest summary on the server through `findLatestResponseSummary()`.
- With no partial days, a row always covers its whole UTC day. So `coversUntil` went too, dropped by migration `20261001234800_remove_summary_covers_until`, and so did the rule that a partial row doesn't count as the day being done.
- The budget counts a summary by `createdAt` again, like an incident or an answer, instead of `updatedAt`. The rewrite that needed `updatedAt` is gone. The one rewrite left is a `pending` row retried after a crash, which keeps its first `createdAt`. That only misplaces one call, and only when the app stayed down for over an hour in the middle of the call.
- The card's heading is now "Yesterday's summary", or "Daily summary" for an older day, as just after midnight before the job has run.

---

## 55. The AI Gateway when its key is set, the proxy otherwise

Date: 2026-10-02 · Status: accepted · Amends decision 30

### Context

Every model call went to the local `openai-oauth` proxy, an OpenAI-compatible endpoint that runs locally. It worked on a laptop, and whether it could run on the server was still open when this was decided. The proxy also reports no cached tokens. A server without the proxy needs a billed provider with a key. Vercel's AI Gateway is part of the AI SDK, takes one key, and reaches OpenAI's models as `openai/<model>`.

### Decision

- A new optional setting, `AI_GATEWAY_API_KEY`. Empty or unset, the app uses the provider it had: `createOpenAI({ baseURL: LLM_BASE_URL, apiKey: LLM_API_KEY }).responses(LLM_MODEL)`. Set, it uses `createGateway({ apiKey: AI_GATEWAY_API_KEY })` with the model id `openai/` plus `LLM_MODEL`. `LLM_MODEL` stays `gpt-5.5`, and the price table stays keyed by it.
- `@ai-sdk/gateway` is a direct dependency, pinned to 4.0.102, the exact version `ai` 7.0.126 depends on. So there's one copy, and tests mock it like `@ai-sdk/openai`.
- `services/llm.ts` picks the provider once, at the bottom of the file, with `languageModel`. No other file knows which one is active. It logs one info line saying which: `{ provider: "openai-compatible", baseURL, model }` or `{ provider: "ai-gateway", model }`. Never the key.
- The OpenAI options are one constant per provider: `{ store: false }` for the proxy, and `{ store: false, promptCacheRetention: "24h" }` for the gateway. Every call, structured or chat, sends them under `providerOptions.openai` with its own `promptCacheKey` (decision 56).
- The Vitest config pins `AI_GATEWAY_API_KEY` to empty, so a key in a developer's `.env` never sends test traffic to the gateway.

### Why

- Structured output keeps working. The gateway provider posts the AI SDK's own call options, with `responseFormat` holding the JSON schema and `providerOptions` as they are, to the gateway's `/v4/ai/language-model` endpoint, and the gateway runs the provider on its side. The AI SDK's gateway page says its language models "support structured data generation with `Output`" ([ai-sdk.dev/providers/ai-sdk-providers/ai-gateway](https://ai-sdk.dev/providers/ai-sdk-providers/ai-gateway)). So `generateStructured` keeps `Output.object` unchanged. Decision 30 was about the proxy's chat-completions route dropping `response_format`, and that route isn't involved.
- Provider options pass through under the provider's own name, `providerOptions.openai`, not `gateway` (the same page, "Provider-Specific Options"). So one options object serves both providers.
- A setting, not code, switches it. Development keeps the free proxy, and a server without the proxy needs one more line in `.env`.
- The proxy rejects `prompt_cache_retention` with "Unsupported parameter", checked with curl on 2026-10-02, and keeps prompts for 24 hours on its own. It accepts `prompt_cache_key`. So retention is only sent through the gateway.

### Alternatives considered

- `@ai-sdk/openai` pointed at api.openai.com with an OpenAI key. The same code would work. We wanted one key that reaches many providers, with spend reports and fallbacks and no code.
- Importing `createGateway` from `ai`, which re-exports it. No new dependency, but a test could then only replace it by mocking all of `ai`.
- The model string `"openai/gpt-5.5"` with the global `gateway`. It reads `AI_GATEWAY_API_KEY` from the environment itself, around `config/env.ts`.

### Consequences

- Not checked against the real gateway, because no key was used, so whether its OpenAI route honours `promptCacheRetention` is unverified too. A dev server with a fake key starts, logs `ai-gateway` with `openai/gpt-5.5`, and serves the dashboard. A chat question then ends with "An error occurred." and a logged `GatewayAuthenticationError`, without a crash.
- In development the provider line repeats on each hot reload of `services/llm.ts`. In production it's logged once for each copy Next loads.
- The price table is still an estimate on either path.
- Deployed, 2026-10-02: the live copy doesn't use the gateway. The `openai-oauth` proxy also runs on the VPS, as a systemd service on `127.0.0.1:10531`, so production keeps the default `LLM_BASE_URL` and `AI_GATEWAY_API_KEY` stays empty. The gateway path is still the one for a server without the proxy, and still untested against the real gateway.

---

## 56. Store cached input tokens and price them at the discount

Date: 2026-10-02 · Status: accepted · Amends decision 38

### Context

OpenAI caches the start of a prompt it has seen recently, for prompts of 1024 tokens or more, and bills the cached part at a tenth of the input price: $0.50 per million for gpt-5.5 instead of $5. The AI SDK reports it as `usage.inputTokenDetails.cacheReadTokens`, a part of `inputTokens`. A chat answer resends the same instructions and tool description on every step, so a good share of its input can come from the cache. The estimate charged all of it at the full price.

### Decision

- `incident`, `message` and `response_summary` gain `cachedInputTokens Int @default(0)`, in migration `20261001230414_add_cached_input_tokens`. It's the part of `inputTokens` the cache served, not an extra amount.
- `toTokenUsage` reads `cacheReadTokens ?? 0` into `cachedInputTokens`. Every place that saves tokens stores it: the incident report, the daily summary and the chat answer, summed over its steps. The chat's `messageMetadata` carries it, and so do the answers of a loaded conversation.
- `estimateUsd` charges `inputTokens - cachedInputTokens` at the input price and `cachedInputTokens` at the cached price. The table gains a cached price: $0.50 for gpt-5.5 and $0.125 for any other model. A usage without a cached count is priced as all uncached, never as NaN.
- `summarizeLlmUsage` adds up today's cached input tokens. The usage card shows "1,200 cached input tokens today" when there are any. An answer's token line, an incident's input tokens and the summary card's token line add "(300 cached)" when above 0.
- Every call sets `providerOptions.openai.promptCacheKey` to a fixed string for its kind: `ping-monitor-chat`, `ping-monitor-incident` or `ping-monitor-summary`. Each service passes its own, and `services/llm.ts` adds it to the shared options of decision 55, with `promptCacheRetention: "24h"` where the provider takes it.
- The budget still counts a call by `inputTokens > 0`, so a fully cached call still counts.

### Why

- Without it, the estimate overstates a cached prompt's input cost up to tenfold.
- Storing the count on the row that produced it keeps decision 32's rule: no call log table.
- OpenAI routes a request by its prompt's start, and `prompt_cache_key` is added to that, so requests with the same key and prefix reach the same cache more often. One key per kind keeps the three kinds of prompt apart, and lets a new chat reuse the instructions another chat warmed.
- A 24-hour retention keeps a prefix alive across the hours between chats, and between one day's summary and the next.

### Alternatives considered

- Reading the real cost from the gateway's spend report. Exact, but only on the gateway path, and one more API call per dashboard load.
- One cache key per chat session. A session's follow-ups share their prefix anyway, and a shared key lets every chat reuse the common one.
- Storing the uncached count instead. The same number, but `inputTokens` would change meaning for old rows and the budget rule.

### Consequences

- Rows from before the migration have 0 cached tokens, so their estimate is unchanged.
- The local proxy reports 0 cached tokens, so nothing changes in development. The discount and the "cached" lines only show against a provider that reports them, like OpenAI through the gateway.
- Cache writes aren't stored. OpenAI doesn't charge for them.

---

## 57. Deploy from CI over SSH with a forced command

Date: 2026-10-02 · Status: accepted · Extends decisions 2 and 24

### Context

The live copy was updated by hand: ssh in, pull, install, migrate, build, restart. CI already proved every push, but nothing acted on a green run. The server is a 1-CPU VPS where a build takes about 3 minutes, and `next start` serves from `.next`, so a build in place would take the site down for those minutes.

### Decision

- The workflow has three jobs. `checks` and `build` run in parallel on every push and pull request. `deploy` needs both, runs only for pushes to `main`, and sits in a `deploy` concurrency group, so two deploys never overlap.
- `deploy` writes a private key and the server's host key from secrets (`VPS_SSH_KEY`, `VPS_KNOWN_HOSTS`, `VPS_HOST`, `VPS_USER`), then runs `ssh user@host <commit sha>`.
- The server's `authorized_keys` entry for that key carries `command="/opt/task1/deploy.sh"` plus the no-pty and no-forwarding options. The key can run nothing else, and the sha arrives as `SSH_ORIGINAL_COMMAND`.
- `deploy.sh`, in the repo root and at `/opt/task1/deploy.sh`, fetches `origin main`, resets hard to the sha, installs, runs `prisma migrate deploy`, builds into `.next-build` with `NEXT_DIST_DIR=.next-build` at `nice -n 10` and a 2 GB heap, then swaps `.next-build` into `.next` and restarts pm2. `next.config.ts` sets `distDir` from `NEXT_DIST_DIR`, defaulting to `.next`.
- `/opt/task1` is a git clone that pulls over a read-only GitHub deploy key, through an ssh config alias. `.env`, `node_modules` and `.next` are untracked and survive resets.

### Why

- A green run is the only thing that reaches the server. The deploy can't start before `checks` and `build` both pass.
- The forced command bounds the key. If `VPS_SSH_KEY` leaks, its holder can run `deploy.sh` and nothing else, and the script only deploys a commit from `origin main`.
- Two keys, each with one job: one lets GitHub into the server for the script, the other lets the server read the repo. Neither can do the other's work.
- The side-folder build keeps the old site serving during the 3 minutes. The swap is a `mv`, so the gap is the pm2 restart alone.
- The concurrency group stops two pushes from racing on one `.next-build` folder.

### Alternatives considered

- A webhook listener on the server. One more process to keep up, and a port to protect.
- A pull-based cron on the server. Deploys late, and runs with no CI gate.
- Building in CI and shipping the artifact. The build is tied to `node_modules` on the box, and the box builds in 3 minutes anyway.
- Vercel or Railway. Ruled out in decision 2.
- A build in place. Takes the live site down for the build.

### Consequences

- The deploy key is root, restricted to one script.
- A failed build leaves the old `.next` serving. The script stops at the first error, before the swap.
- Migrations run before the swap, so a migration that drops a column the old build reads can error until the restart.
- The first automatic deploy ran on 2026-10-02.
