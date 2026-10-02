---
paths:
  - "src/services/llm.ts"
  - "src/services/incidents.ts"
  - "src/services/chat.ts"
  - "src/services/response-analysis.ts"
  - "src/models/response-summary.ts"
  - "src/components/response-summary-card.tsx"
  - "src/models/incident.ts"
  - "src/models/message.ts"
  - "src/models/chat-session.ts"
  - "src/lib/chat-*.ts"
  - "src/app/api/chat/**"
  - "src/hooks/use-chat-*"
  - "src/jobs/**"
  - "src/components/llm-usage-card.tsx"
  - "src/components/incident-*"
  - "src/components/chat-*"
  - "src/components/ai-elements/**"
  - "tests/services/llm.test.ts"
  - "tests/services/incidents.test.ts"
  - "tests/services/chat.test.ts"
  - "tests/services/response-analysis.test.ts"
  - "tests/api/chat.test.ts"
---

# Model call rules

These cover the language model: the shared model layer, incident reports, the daily response summary, the chat and the hourly budget. The main rules are in `AGENTS.md`, including "Model calls". The reasons are in decisions 28 to 49 and 53 to 56 of `docs/decisions.md`. What's still open is listed in `docs/plan-llm-insights.md`.

## The model layer

- `src/services/llm.ts` is the only file that imports the AI SDK providers (`@ai-sdk/openai` and `@ai-sdk/gateway`) and the tokenizer (`gpt-tokenizer`). Every model call goes through it. Other services call its exports: `generateStructured`, `streamAnswer`, `hasLlmBudget`, `summarizeLlmUsage`, `estimateUsd` and `toTokenUsage`. The model itself isn't exported.
- The provider is picked once, when `services/llm.ts` loads. With `AI_GATEWAY_API_KEY` empty, the model is `createOpenAI({ baseURL: LLM_BASE_URL, apiKey: LLM_API_KEY }).responses(LLM_MODEL)`, the Responses API. Don't switch to `.chat(model)`: the local `openai-oauth` proxy's chat-completions route drops `response_format`, so the schema never reaches the model. See decision 30.
- With `AI_GATEWAY_API_KEY` set, the model is `createGateway({ apiKey })` with the id `openai/` plus `LLM_MODEL`. The gateway passes the AI SDK's call options through, `responseFormat` and `providerOptions` included, so `Output.object` works the same way. `LLM_MODEL` stays a bare name like `gpt-5.5`, because the price table is keyed by it. See decision 55.
- No other file knows which provider is active. `services/llm.ts` logs one info line when it loads, `{ provider: "openai-compatible", baseURL, model }` or `{ provider: "ai-gateway", model }`. Never log the key.
- Every call sends `providerOptions.openai` built from one shared constant per provider, plus the caller's `promptCacheKey`: `{ store: false }` for the proxy, `{ store: false, promptCacheRetention: "24h" }` for the gateway. The proxy rejects `prompt_cache_retention` with "Unsupported parameter", so never send it there. The keys are constants in capitals at the top of each service: `ping-monitor-chat`, `ping-monitor-incident` and `ping-monitor-summary`. See decision 56.
- `generateStructured({ schema, instructions, prompt, promptCacheKey })` calls `generateText` with `Output.object({ schema })`. `generateObject` is deprecated in AI SDK 7. It returns the parsed `output` and the call's `usage`, as `{ inputTokens, cachedInputTokens, outputTokens }`.
- `streamAnswer({ instructions, messages, tools, promptCacheKey })` is the chat's call. It counts the prompt's tokens, checks the budget, converts the UI messages with `convertToModelMessages(messages, { ignoreIncompleteToolCalls: true })`, and returns `streamText`'s result. `services/chat.ts` turns that into the response.
- Every call has `maxRetries: 0`. A retry is a model call the budget doesn't count. See decision 31. A structured call has a 20-second `AbortSignal.timeout`, and a chat answer 60 seconds, across all its steps.
- Prompt tokens are counted locally with `gpt-tokenizer` before anything is sent. Text that looks like a special token, like `<|endoftext|>`, counts as plain text, so a question containing it still reaches the model. A structured call counts its instructions and prompt. A chat call counts its instructions and the text parts of every message, not tool calls or results. Over 6000, the call is refused with the error `prompt too long`.
- The settings are `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL`, `LLM_CALLS_PER_HOUR` and `AI_GATEWAY_API_KEY`, read from `config/env.ts`. All five have defaults, so the app, CI and tests start without a proxy. The Vitest config pins `AI_GATEWAY_API_KEY` to empty, so tests never reach the gateway.
- `languageModel` and the chosen provider are built once, at the bottom of `services/llm.ts`, after the helpers they call.
- `toTokenUsage` turns the AI SDK's usage into `{ inputTokens, cachedInputTokens, outputTokens }`, reading `inputTokenDetails.cacheReadTokens` for the cached part. Any count the provider leaves out is 0.
- AI SDK 7 renamed things older examples use: `instructions`, not `system`. `isStepCount`, not `stepCountIs`. `onEnd`, not `onFinish`. `convertToModelMessages` is async. A UI message stream is built with `toUIMessageStream({ stream, ... })` and returned with `createUIMessageStreamResponse`.

## Prompts

- Prompts, instructions and tool descriptions are constants in capitals at the top of the service that owns them, like `REPORT_INSTRUCTIONS` in `services/incidents.ts`, `SUMMARY_INSTRUCTIONS` in `services/response-analysis.ts`, and `CHAT_INSTRUCTION_LINES` and `QUERY_DATABASE_DESCRIPTION` in `services/chat.ts`. Output and input schemas are Zod schemas, so they keep camelCase names and sit at the bottom, like `reportSchema`. `services/llm.ts` holds no prompt of its own.
- A prompt is built from facts the service already has, one line per fact. Cut large JSON before it goes in: the incident prompt cuts the payload and the response to 2000 characters each.
- The chat's instructions end with the current time in UTC, built per question by `buildChatInstructions`. With only the date, the model read "the last 24 hours" as "since midnight". See decision 48.

## Budget and cost

- `LLM_CALLS_PER_HOUR`, 20 by default, caps model calls in the trailing 60 minutes. A call counts as an incident with `reportStatus: "written"`, a `Message` row with role `assistant` and `inputTokens` above 0, or a `response_summary` row with `inputTokens` above 0. The model functions are `countWrittenIncidentsSince`, `countChargedAssistantMessagesSince`, `countChargedResponseSummariesSince` and their `findOldest…Since` partners. See decisions 45 and 54.
- A response summary is counted, and priced, by its `createdAt`, like an incident or an answer. Only the daily job writes one, once per UTC day. The one rewrite is a `pending` row left by a crash, which keeps its first `createdAt`. That's accepted: it only misplaces one call, and only when the app stayed down for over an hour in the middle of the call.
- Cache hits and refusals are saved as assistant rows with 0 tokens, so they never count. A chat answer is one call however many steps it took, and its tokens are the total of every step.
- The budget is read from those tables on every check. Never keep a counter in memory: a restart would reset it.
- Every model call's tokens are stored on the row it produced, in `inputTokens`, `cachedInputTokens` and `outputTokens`: the incident for a report, the assistant `Message` for a chat answer, the `response_summary` row for a daily summary. There's no separate call log table.
- Only the server sets tokens. The chat ignores any token counts the browser puts on a message, and saves questions with 0.
- `hasLlmBudget()` lets a caller decide before it starts work. `generateStructured` and `streamAnswer` also refuse on their own when the budget is spent, with the error `llm budget spent`.
- `cachedInputTokens` is the part of `inputTokens` the provider's prompt cache served, not an extra amount. The budget still counts a call by `inputTokens` above 0.
- The cost estimate comes from `USD_PER_MILLION_TOKENS` in `services/llm.ts`: gpt-5.5 at $5 in, $0.50 cached in and $30 out per million tokens, and $1.25, $0.125 and $10 for any model not listed. `estimateUsd` charges `inputTokens - cachedInputTokens` at the input price and `cachedInputTokens` at the cached price, and treats a missing cached count as 0. These are estimates, not a bill. Update the table when the model or its price changes. See decision 56.
- `summarizeLlmUsage()` returns this hour's calls, the cap, when the oldest call leaves the window, the estimated spend since midnight UTC and the cached input tokens since midnight UTC. The dashboard's `LlmUsageCard` shows it, and the chat's budget refusal reads its reset time.
- A call isn't counted until its row is saved, so chat answers started at the same moment can pass the cap by a few. That's accepted (decision 32).

## Incidents

- Never call the model inside `recordPing`. The ping job calls `reportIncidentForPing(ping)` after `recordPing`, in its own try/catch. A failed incident check is logged with the ping's id and never touches the saved ping.
- A ping is checked against the average duration of successful pings in the 24 hours before it. With fewer than 12 of them, there's no incident.
- A ping is an incident when it failed, or took at least 2 times that average.
- Severity is arithmetic, decided in `services/incidents.ts`: `critical` when the ping failed or took at least 5 times the average, `warning` otherwise. The model only explains. Its instructions say the monitor has already decided, and its output has no severity field.
- The incident row is saved with `reportStatus: "pending"` before the model is asked. It then becomes `written`, with the report and its tokens, `skipped_budget` when the budget is spent, or `failed` when anything in the report step throws. A failed report is logged with the incident's and the ping's ids.
- Once the report step ends, the row is broadcast as an `incident` event. See `.claude/rules/live-updates.md`.

## The daily response summary

- `services/response-analysis.ts` exports `summarizeDay(day)`, `summarizePreviousDayIfMissing()` and `findLatestResponseSummary()`. A summary always covers one whole UTC day, from midnight to the next midnight. No route serves summaries. The dashboard page reads the latest one through the service.
- `summarizeDay` works out the statistics in code from `listPingOutcomesBetween(day, nextMidnight)`: the total, the failed count (pings with an `error`), counts per `responseKind` and per status code (`none` for no reply), failed pings per UTC hour (only hours with failures), p50, p95 and max latency of the successful pings (nearest rank), the distinct origins in order of first appearance (the first 10, plus the count) and the longest run of consecutive failed pings. Counts, never rows, so the prompt stays a few hundred tokens whatever the interval.
- It saves the row as `pending` with those statistics first, upserting on `day`, then asks `generateStructured` for `{ summary, findings }`: 2 to 4 plain sentences with counts and UTC times, and at most 4 one-sentence findings. The instructions say to use only the numbers given and to say "no failures" plainly when there were none. The model never sees a ping row, a payload or a response.
- The row then becomes `written` with the text and the tokens, `skipped_budget` when `hasLlmBudget()` is false or the model layer refuses with `llm budget spent` or `prompt too long`, or `failed` when anything else throws. A failed summary is logged with the row's id and its day.
- `summarizePreviousDayIfMissing` summarizes yesterday, UTC, unless it already has a `written`, `skipped_budget` or `failed` row. The job in `jobs/response-summary.ts` calls it every 5 minutes. See `.claude/rules/timed-jobs.md`.
- `findLatestResponseSummary` returns the newest day's row with `relativeDay`: `yesterday` or `earlier`, worked out on the server, so the card never reads the clock while it renders.

## The chat

- `answerQuestion({ sessionId, messages })` in `services/chat.ts` is the whole process: find the session, try the cache, call `streamAnswer`, stream the answer back, save the exchange when it ends. `POST /api/chat` calls it. An unknown session throws an error that `isMissingChatSessionError` recognises, and the route turns it into a 404.
- The model reads the database through one tool, `queryDatabase`: `{ table, method, arguments }`, with `table` `ping` or `incident` and `method` `findMany`, `aggregate` or `groupBy`. The model writes Prisma arguments as JSON. It never writes SQL, and only those three read methods are dispatched, to `queryPings` and `queryIncidents` in the models. Never add a write method, raw SQL or a free-form string. See decision 39.
- The schema the model sees is loose on purpose: `arguments` is `zod.looseObject({})`, and the tool's description lists the columns, operators and limits. It saves tokens on every step and avoids a `propertyNames` warning from OpenAI. `execute` then checks the input against the strict `chatQuerySchema` in `src/lib/chat-query.ts` before anything reaches Prisma. Keep the description and the schema in step. See decision 49.
- `chatQuerySchema` allows only each table's own columns, the listed operators, `take` from 1 to 100, and strict objects. `payload` and `response` can't be filtered on, and `groupBy` orders only by its `by` columns and takes `take` only with an `orderBy`.
- A ping's `responseKind` takes only its six values, `clean_echo`, `echo_mismatch`, `empty`, `client_error`, `gateway_error` and `failed`, with `equals`, `not` and `in`. `origin` is nullable text. Both can be selected, grouped by and ordered by, and the chat's instructions and the tool's description name the six values.
- A query the schema rejects throws "The query was rejected." with Zod's explanation. The model sees it as the tool's error and can retry. The stream's `onError` shows only that message in the browser. Any other error shows as "An error occurred."
- Row results are cut from the end to fit in 8000 characters, with `truncated: true`. Aggregates come back whole.
- `streamText` runs with `stopWhen: isStepCount(4)`, so an answer makes at most 4 model requests.
- Every call, chat or structured, sets `providerOptions.openai.store: false`. The proxy keeps no state and rejects the `item_reference` items the SDK sends otherwise. See decisions 44 and 55.
- The answer goes out through `toUIMessageStream` with `originalMessages`, `generateMessageId` and `messageMetadata`, which puts the answer's `totalUsage` on the finish chunk. `onEnd` saves the newest question and the answer.
- Stop, or a closed tab, doesn't stop the answer. `answer.consumeStream()` and `consumeSseStream: consumeStream` read both streams to the end, so `onEnd` saves the whole answer and it counts against the budget. See decision 47.
- An answer with no text but with tokens is saved and counted. An answer with no text and no tokens isn't saved.
- The cache: every question is hashed with the questions before it. `questionHash` is sha256 of the model id, then every user message's text in the conversation so far, trimmed and lower-cased, in order, joined with a NUL character. A conversation with one question hashes as it did before follow-ups were cached. An assistant row with the same hash from the last hour, in any session, is replayed as the answer with `metadata.cached = true`, and the model isn't called. So a follow-up hits only after the same questions in the same order. Only answers that finished with `stop` get a hash. Hits and refusals are saved with no hash. See decision 46 and its 2026-10-02 note.
- The answer's `messageMetadata` carries `{ usage: { inputTokens, cachedInputTokens, outputTokens } }`, and a loaded conversation's answers carry the same from their rows.
- The refusals are fixed texts, sent and saved as a 0-token answer without calling the model:
  - `llm budget spent`: "The model budget for this hour is spent. It resets at HH:MM UTC."
  - `prompt too long`: "That question is too long for one call. Ask something shorter."
- Any other failure before the stream starts is passed on, and nothing is saved.
- Sessions: `startChatSession()` makes an untitled session and returns `{ id, createdAt, title }`, for `POST /api/chat/sessions`. `loadChatSession(id)` returns `{ session, messages }`, the messages as UI messages oldest first, or `null`, for `GET /api/chat/sessions/:id`. `listRecentChatSessions()` returns the 20 newest, for `GET /api/chat/sessions`.

## The chat screen

- The chat is a floating widget in the layout, `src/components/chat-widget.tsx`, with no page of its own. The browser starts a session only when the first question is sent, so opening the panel never makes an empty session. The screen's rules are in "The chat" in `.claude/rules/screens.md`. See decision 53.

- `src/components/ai-elements/` holds `conversation`, `tool`, `loader` and `code-block`, copied from Vercel's AI Elements registry. They're vendored like `src/components/ui/`, in the `VENDORED` list in `eslint.config.mjs` and the `files.includes` list in `biome.json`.
- AI Elements is written for shadcn on Radix, and ours is on Base UI. `tool.tsx` is patched: Radix's `data-[state=open]` and `data-[state=closed]` became `data-open` and `data-closed`, and the chevron turns on `group-data-panel-open`. Apply the patch again after any update.
- Don't add AI Elements components that use `asChild`, like `message` or `prompt-input`. Use shadcn's own `message`, `bubble` and `textarea`. See decision 43.

## Tests

- Tests never call the proxy.
- `tests/services/llm.test.ts` mocks `@ai-sdk/openai` and `@ai-sdk/gateway` with the factories in `tests/support/model-provider.ts`, so `.responses()`, or the gateway, returns a `MockLanguageModelV4` from `ai/test`. `tests/services/llm-provider.test.ts` stubs `AI_GATEWAY_API_KEY`, resets the modules and imports `services/llm.ts` again to check which provider is picked, from the model the factories built. The factories push each model they build onto a `builtModels` list the suite holds in `vi.hoisted`, and a test takes the mock as `builtModels[0]`. Each test sets the model's reply with `vi.spyOn(languageModel, "doGenerate")` on that mock, or with `replyInSteps` from `tests/support/model-stream.ts` for streamed answers. Never export the model from `services/llm.ts` for a test.
- Tests of incidents, the response summary service and the ping flow mock `@/services/llm` itself, with `generateStructured` and `hasLlmBudget` as `vi.fn()`.
- The chat's service and API tests mock `@ai-sdk/openai` the same way, take the mock from `builtModels`, and go through the real `services/llm.ts`. Each step's reply comes from `replyInSteps`.
- `services/llm.ts` stays at 100% of lines and branches, with `services/ping.ts` and `services/live-updates.ts`.
- Rows a test seeds go in a time window no other suite uses. The windows are listed in `.claude/rules/testing.md`.
