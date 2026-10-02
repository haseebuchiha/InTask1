# Plan: Option B, LLM-powered insights

Status: built. The plan was agreed on 2026-10-01 and built the same day, in two waves: incident reports with the shared model layer, then the chat. Response analysis followed on 2026-10-02, then the AI Gateway as an optional provider, cached input tokens priced at the discount, and cached follow-ups. The choices are recorded in decisions 28 to 49 and 53 to 56 of `docs/decisions.md`, the rules in `AGENTS.md` and `.claude/rules/llm.md`, and the description for readers in `README.md` and `docs/ai-features.md`. This file keeps only what's still open.

## What was built

| The brief asks for | Built as | Decisions |
|---|---|---|
| A chat that answers questions about the data | A floating chat widget on every page, `POST /api/chat`, one read-only `queryDatabase` tool, saved conversations | 39 to 44, 47 to 49, 53 |
| Incident reports, written automatically | An incident check after every ping, severity from arithmetic, a model-written report, the Incidents pages | 33 to 35 |
| Payload analysis | Every response tagged in code (`responseKind`, `origin`), one model-written summary a day from statistics worked out in code, and a summary card at the top of the dashboard, loaded on the server. The on-demand "today so far" button and the summary routes were removed (decision 54's 2026-10-02 note). The incident prompt still carries the payload and the response | 28, 54 |
| Cost controls | A local token count before every call, a cap of 20 calls an hour shared by reports and answers, `skipped_budget` reports and the chat's budget refusal, the usage card, the one-hour answer cache for first questions and follow-ups, cached input tokens stored and priced at the provider's discount, a prompt cache key per kind of call, and the cost analysis in `docs/cost-analysis.md` | 31, 32, 37, 38, 45, 46, 56 |
| A deployable provider | The Vercel AI Gateway when `AI_GATEWAY_API_KEY` is set, the local proxy otherwise | 55 |

## Open points

- **`GET /api/llm/usage`.** Planned with the incidents wave, never built. The usage card calls `summarizeLlmUsage()` on the server, so nothing in the app needs the route. Build it for curl and tests, or drop it.
- **The 6000-token limit is still a guess.** A report's prompt measured 798 tokens. Chat answers measured 1,867 to 5,467 input tokens, but that's across all their steps, and the check only counts the instructions and the conversation's text, not query results. Tune it after more real chats, and decide whether the check should count tool results too.
- **Parallel chats can pass the cap by a few** (decision 32). A reservation row written before the call would close the gap, if it ever matters.
- **Caching query results.** Settled for now: only final answers are cached, keyed by the questions so far (decision 46). Revisit only if real use shows repeated queries inside different questions.
- **The AI Gateway path is untested against the real gateway** (decision 55). With a real key, check that a report's structured output, the cached-token counts and `promptCacheRetention: "24h"` all come through, then compare the estimate with the gateway's spend report.
- **No measurement of prompt caching yet.** The proxy reports 0 cached tokens, so the discount in the estimate has never been exercised live (decision 56).
- **The Incidents page refreshes on every `ping` event too**, not only on `incident` (decision 35).
- **The usage card says the budget resets now** when there were no calls in the hour (decision 37).
- **Yesterday's summary isn't retried after `skipped_budget` or `failed`** (decision 54). Retry it on a later check if that turns out to matter.

## Known limits of the chat

These are accepted for now. `README.md` keeps the ones it mentions under "Assumptions".

- After Stop, the server finishes and saves the whole answer, so a reload shows more than was on screen (decision 47).
- `cached` isn't stored, so after a reload a cached answer shows as a 0-token answer without "from cache" (decision 46).
- A cached answer can be up to an hour old, follow-ups included (decision 46).
- The 6000-token check counts text parts only, and a long conversation eventually gets the "too long" refusal on every question (decision 42).
- Sessions with the same first question get the same title (decision 41).
- There's no Redis, so streams can't be resumed after a reload (decision 47).
- There's no login, so anyone who can reach the chat can spend the hour's budget (decision 40).
