---
paths:
  - "src/app/api/**"
---

# API route rules

These cover the REST endpoints. The main rules are in `AGENTS.md`, including "API routes, not server actions".

- `GET /api/pings` (`src/app/api/pings/route.ts`) returns a page of saved pings, newest first. It accepts the same filters as the dashboard table, checked with the shared nuqs definitions in `src/lib/ping-filters.ts`.
- The filters are nuqs's built-in parsers: `page` is `parseAsInteger`, `from` and `to` are `parseAsIsoDateTime`, and `failedOnly` is `parseAsBoolean`. Don't add rules of our own on top.
- The route reads them with `loadPingFilters(request, { strict: true })`. A value nuqs can't read at all, like `page=abc`, `page=` or `from=notadate`, returns 400 with a message that says what's expected.
- The built-ins are loose on odd input: `page=12abc` is 12, `page=1.5` is 1, and `failedOnly` is on only for `true`, in any letter case. `listPingHistory` treats a page below 1 as page 1, and returns the page it used.
- A bare date is midnight UTC at the start of that day, for `to` as well as `from`. Both ends are included. A time with no offset is read in the server's time zone, so examples always use `Z`.
- `GET /api/pings/:id` (`src/app/api/pings/[id]/route.ts`) returns one saved ping in full, including the payload we sent and httpbin's response.
- Zod checks the `:id` through `parsePingId` in `src/lib/ping-id.ts`, which the `/pings/:id` page shares. An id that doesn't read as a whole number from 1 to 2147483647 returns 400. A missing ping returns 404.
- `GET /api/incidents` (`src/app/api/incidents/route.ts`) returns `{ incidents }`: the 50 most recent incidents, newest first, each with a light summary of its ping (`id`, `createdAt`, `statusCode`, `error`). It takes no query and calls `listRecentIncidents`.
- `GET /api/incidents/:id` (`src/app/api/incidents/[id]/route.ts`) returns one incident in full, including its report and token counts. It calls `findIncidentById`, which `services/incidents.ts` re-exports from the model.
- Zod checks the incident `:id` through `parseIncidentId` in `src/lib/incident-id.ts`, which the `/incidents/:id` page shares. It works like the ping id: an id that doesn't read as a whole number from 1 to 2147483647 returns 400, and a missing incident returns 404.
- The ping history routes and `GET /api/incidents/:id` have no `dynamic` export. Route handlers aren't cached by default, and `force-dynamic` would need replacing if Cache Components is turned on.
- `GET /api/incidents` is the exception. Its handler reads nothing from the request, so it exports `dynamic = "force-dynamic"`, like the stream route, so `next build` never prerenders it with build-time data. If Cache Components is turned on, swap it for `await connection()`.
- The stream route, `src/app/api/pings/stream/route.ts`, is covered in `.claude/rules/live-updates.md`.

## No summary routes

- There are no response summary routes. The dashboard page loads the latest summary on the server with `findLatestResponseSummary()`, and nothing else reads summaries. The on-demand `POST /api/response-summaries` and the two `GET` routes were removed. See decision 54.

## The chat routes

- The chat routes are the ones our own browser code calls. The chat widget calls all four. See decisions 40 and 53 in `docs/decisions.md`.
- `POST /api/chat` (`src/app/api/chat/route.ts`) answers one chat question. `useChat` posts to it.
- Its body is `{ id, messages }`: `id` is the chat session's id, and `messages` is the whole conversation as AI SDK UI messages, ending with the user's question. `parseChatRequest` in `src/lib/chat-request.ts` reads it. Zod checks the envelope, a non-empty `id` and a non-empty list, and the AI SDK's `safeValidateUIMessages` checks each message.
- A body that isn't JSON, or fails either check, or doesn't end with a user message, returns 400 with a message that says what's expected. Nothing reaches the model.
- An `id` with no session returns 404, `{ "error": "No chat session with id <id>" }`. `answerQuestion` throws, and the route recognises the error with `isMissingChatSessionError`. Any other error goes through to Next's 500.
- A good request returns the answer as a UI message stream, `text/event-stream`, which `useChat` reads. The budget and "too long" refusals come back on the same stream, as an ordinary answer, with status 200.
- `GET /api/chat/sessions` (`src/app/api/chat/sessions/route.ts`) returns `{ sessions }`: the 20 newest chat sessions, newest first, each with `id`, `createdAt` and `title`. It calls `listRecentChatSessions`. The widget's history menu calls it each time it opens.
- `POST /api/chat/sessions`, in the same file, starts an untitled session with `startChatSession` and returns it, `{ id, createdAt, title }`, with status 201. It takes no body. The widget calls it just before the first question of a new chat.
- `GET /api/chat/sessions/:id` (`src/app/api/chat/sessions/[id]/route.ts`) returns `{ session, messages }`: the session's `id`, `createdAt` and `title`, and its messages as AI SDK UI messages, oldest first, each answer with its token usage in `metadata`. It calls `loadChatSession`. The widget calls it to load the stored conversation and a chat picked from the history menu.
- Its `:id` is read with `parseChatSessionId` from `src/lib/chat-session-id.ts`. Unlike the ping and incident ids, an id it can't read returns 404, not 400, with the same body as an unknown one: `{ "error": "No chat session with id <id>" }`. A session id is an opaque token, so a malformed one is just one that doesn't exist.
- `POST /api/chat` and `src/app/api/chat/sessions/route.ts` export `dynamic = "force-dynamic"`. The sessions `GET` reads nothing from the request, so `next build` would otherwise prerender it. The `:id` route reads its params, so it has no `dynamic` export, like the other `:id` routes.
- The model and the chat's own rules are in `.claude/rules/llm.md`.

## Writing a route

- An API route file stays thin: read the request, call one service, return the result.
- Write handlers as named arrow functions: `export const GET = async (request: Request) => ...`.
- Our own pages don't call the GET endpoints. They exist for outside callers, like a reviewer using curl, and for tests. The chat routes are the exception: the browser calls them.
