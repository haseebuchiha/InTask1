# AI features

How the four AI features work: incident reports, the chat, response analysis and the cost controls. The measured costs are in [`cost-analysis.md`](cost-analysis.md).

These are the brief's Option B, LLM insights ([decision 28](decisions.md#28-option-b-llm-insights-for-the-ai-enhancement)). [`src/services/llm.ts`](../src/services/llm.ts) is the only code that talks to the model, through the AI SDK on the Responses API, with no retries ([decisions 29](decisions.md#29-the-ai-sdk-for-model-calls), [30](decisions.md#30-the-responses-api-not-chat-completions) and [31](decisions.md#31-no-retries-on-model-calls)).

## Incidents

After each ping is saved, `reportIncidentForPing` in [`src/services/incidents.ts`](../src/services/incidents.ts) checks it. Detection is plain arithmetic, so the model only explains ([decision 33](decisions.md#33-severity-comes-from-arithmetic-not-the-model)):

1. Average the successful pings in the 24 hours before this one. With fewer than 12 of them, stop: the average is too noisy.
2. The ping is an incident if it failed, or took at least 2 times the average.
3. It's **critical** if it failed or took at least 5 times the average, and a **warning** otherwise.

The incident is saved as `pending` before the model is asked, so it's recorded whatever happens next ([decision 34](decisions.md#34-save-the-incident-row-before-asking-the-model)). The model gets the ping, its severity and average, the 12 most recent durations, and the payload and response cut to 2000 characters each. It answers in a schema: a one-sentence summary, 2 to 4 likely causes and 2 to 4 recommendations. The status then becomes `written`, `skipped_budget` when the hourly budget is spent, or `failed` when there's no model, the 20-second timeout passes, the answer doesn't fit the schema, or the prompt is over 6000 tokens. Then the incident goes out on the live stream ([decision 35](decisions.md#35-send-incidents-as-an-incident-event-on-the-same-channel)).

## Chat

- The model gets one tool, `queryDatabase`. A call names a table, `ping` or `incident`, a read method, `findMany`, `aggregate` or `groupBy`, and the Prisma arguments for it, as JSON. The model never writes SQL ([decision 39](decisions.md#39-one-querydatabase-tool-with-checked-prisma-arguments)).
- A strict Zod schema in [`src/lib/chat-query.ts`](../src/lib/chat-query.ts) checks every call before Prisma sees it: only the table's own columns, a fixed list of operators, `take` from 1 to 100, no unknown keys, no relations, and no filters on the JSON columns. The model is shown a looser schema, to save tokens on every step ([decision 49](decisions.md#49-a-loose-tool-schema-for-the-model-a-strict-one-inside-execute)).
- Only the three read methods are wired up, so there's no write method to reach, whatever the model sends. A rejected call goes back as "The query was rejected." with the reason, so the model can fix it.
- Each query returns at most 100 rows and 8000 characters. Each answer gets at most 4 model steps and 60 seconds. Errors stay on the server, and token counts sent by the browser are ignored.
- Every question carries the conversation before it ([decision 42](decisions.md#42-send-the-whole-conversation-with-every-question)), and the model is told the current UTC time, so "this week" means what it says ([decision 48](decisions.md#48-tell-the-model-the-current-utc-time)). Conversations are saved in `chat_session` and `message` ([decision 41](decisions.md#41-save-conversations-in-the-database)). Stop ends what the browser shows, but the server finishes and saves the answer, so its tokens are counted ([decision 47](decisions.md#47-let-the-server-finish-an-answer-after-stop)).
- Checked live against `psql`: the chat said 10 pings failed this week, the slowest successful ping was 68338 at 17,583 ms, and there was one warning incident in the last 24 hours. All three matched.

## Response analysis

- Every ping gets a `responseKind` in code when it's saved, at no token cost ([decision 54](decisions.md#54-response-analysis-tags-in-code-one-summary-a-day)): `clean_echo` (a 2xx whose `json` is exactly the payload, in any key order), `echo_mismatch` (a 2xx whose echo differs or is missing), `empty` (a 2xx with no JSON body), `client_error` (4xx), `gateway_error` (5xx) or `failed` (no reply).
- It also keeps httpbin's `origin`, the public IP it saw us call from, so a change in the monitor's network shows up. The migration that added both columns tagged every earlier ping in SQL with the same rules. The chat's tool can filter and group by both.
- A timer checks every 5 minutes whether yesterday, in UTC, has its summary. If not, the code works out the day's numbers from the ping table: pings and failures, counts per kind and per HTTP status, failures per UTC hour, p50, p95 and max latency of the successful pings, the first 10 caller IPs in the order they appeared, and the longest run of failures.
- The model gets those numbers, one line each, and nothing else: no rows, no payloads. It writes 2 to 4 sentences and up to 4 findings, and says "no failures" plainly when there were none.
- Like an incident, the summary is saved as `pending` before the model is asked, then becomes `written`, `skipped_budget` or `failed`.

## Cost controls

- **The budget.** `LLM_CALLS_PER_HOUR`, 20 by default, caps model calls in any trailing hour, shared by reports, chat answers and summaries. It's counted from the tables on every check, so a restart doesn't reset it ([decisions 32](decisions.md#32-keep-the-model-budget-in-tables-not-memory), [37](decisions.md#37-the-hourly-cap-counts-written-reports-plus-assistant-messages) and [45](decisions.md#45-only-answers-that-reached-the-model-count-against-the-cap)).
- **The answer cache.** An answer is cached for an hour under every question that led to it, trimmed and lower-cased, plus the model's name. The same conversation in any chat comes back marked "from cache", with 0 tokens ([decision 46](decisions.md#46-cache-a-first-questions-answer-for-one-hour)).
- **The token limit.** gpt-tokenizer counts every prompt locally before it's sent, and a prompt over 6000 tokens is refused.
- **The fallback.** When the budget is spent, a report or summary is saved as `skipped_budget`, and the chat says "The model budget for this hour is spent. It resets at HH:MM UTC." Refusals and cache hits are saved with 0 tokens and never count. When the model fails, everything else keeps working.
- **The cost on the dashboard.** The usage card shows calls this hour, when the budget frees up, and today's estimated spend, from a price table in the code ([decision 38](decisions.md#38-price-the-model-calls-from-a-table-of-estimates)).
