---
paths:
  - "prisma/**"
  - "prisma.config.ts"
  - ".prismalintrc.json"
  - "src/models/**"
  - "src/db/**"
---

# Database rules

These cover the Prisma schema, the models and the database client. The main rules are in `AGENTS.md`.

## Naming

prisma-lint checks these, using `.prismalintrc.json`.

- Database naming: model names are singular PascalCase, like `Ping`, mapped to a snake_case table name with `@@map("ping")`. Fields are camelCase, mapped to snake_case columns with `@map("status_code")`.
- Every model starts with `id`, then `createdAt`, and `createdAt` has an index. Every field whose name ends in `At` is a `DateTime` stored as `@db.Timestamptz`.
- Don't use prisma-lint's ignore comments (`///`). They are comments, and comments are banned.

## Checks

- `pnpm lint` also checks the database schema. Editing `prisma/schema.prisma` runs those checks by themselves.
- The checks are `pnpm lint:prisma`: `prisma format --check`, then `prisma validate`, then `prisma-lint prisma/schema.prisma`. If only formatting fails, run `pnpm exec prisma format`.

## Prisma setup

- Prisma is pinned to 7.10: `prisma`, `@prisma/client` and `@prisma/adapter-pg`. npm's newest `prisma` is an 8.0 release candidate. Don't upgrade until Prisma 8 has a stable release.
- The client is generated into `src/db/generated/`. It isn't committed or linted. `pnpm install` regenerates it, because the `postinstall` script runs `prisma generate`.
- Server code imports Prisma's types from `@/db/generated/client`. Browser-side code imports them from `@/db/generated/browser`, which carries no server code. `PingRow` in `src/lib/ping-row.ts` is built from the browser `Ping` type.
- `src/db/client.ts` holds the one shared client. It uses the Postgres driver adapter and is cached on `globalThis`, so reloads in development reuse it.
- The client forces each session's timezone to UTC (`options: "-c timezone=UTC"`), because `@prisma/adapter-pg` assumes Postgres sends and receives timestamps in UTC. On a server in any other timezone, times are off by that zone's offset. `tests/db/client.test.ts` guards this.
- Only files in `models/` import the Prisma client. Models only talk to the database. They make no decisions and never call services.
- A model's query fields say what they do to the query, not what they mean. `PingPageQuery.onlyWithError` keeps rows whose `error` is set. The service maps the `failedOnly` filter to it, so what "failed" means stays in the service.
- `prisma.config.ts` reads `DATABASE_URL` straight from the environment, because it runs outside the app. It's the one exception to "only `config/env.ts` reads environment variables".
- `pnpm db:migrate` creates and applies a migration. It runs `prisma migrate dev`. In Prisma 7 it no longer regenerates the client, so run `pnpm exec prisma generate` after changing the schema.
- In a non-interactive shell, like an agent's, `prisma migrate dev` stops at any data-loss warning, even with `--create-only`. Write the SQL with `pnpm exec prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script` into a new `prisma/migrations/<UTC timestamp>_<name>/migration.sql`, apply it with `pnpm exec prisma migrate deploy`, then run `prisma generate`. `20261001234800_remove_summary_covers_until` was made this way.
- CI and production apply the committed migrations with `pnpm exec prisma migrate deploy`. It never creates new ones.
- Store httpbin's response in a `jsonb` column. Keep the fields we filter on, like status and duration, as ordinary columns so they can be indexed.

## Tables

- `ping`: one row for each run of the ping job. Decision 5 lists its columns. `responseKind` (required) and `origin` (nullable) were added by `20261001223056_add_response_kind`. `services/ping.ts` decides the kind when it saves the ping: `failed` (no status code), `gateway_error` (5xx), `client_error` (4xx), `empty` (no JSON body), `clean_echo` (httpbin's `json` deep-equals the payload sent) or `echo_mismatch`. `origin` is httpbin's `origin` field, our public IP, when it's text. See decision 54.
- That migration backfilled every existing row in SQL, with a `CASE` that follows the same rules: `response -> 'json' = payload` compares as `jsonb`, so key order doesn't matter, and a NULL or JSON-null response is `empty`. It adds the column as nullable, fills it, then sets `NOT NULL`. `prisma migrate dev` refuses a required column without a default on a table with rows, so the migration was made with `--create-only` and edited by hand. Stop the running app before applying a migration like it: an old process inserts pings without the column and fails.
- `response_summary`: one row per UTC `day` (`@db.Date`, unique), written by `services/response-analysis.ts`. A row always covers its whole UTC day, from midnight to the next midnight, so there's no column for where the window ends. `status` is `pending`, `written`, `skipped_budget` or `failed`. `summary` and `findings` (a `jsonb` list of up to 4 strings) hold the model's text, `statistics` (`jsonb`) the numbers it was given, and `inputTokens`, `cachedInputTokens` and `outputTokens` the call's tokens. `updatedAt` is Prisma's `@updatedAt`.
- `incident`: one row for each slow or failed ping, linked by `pingId`. It holds the `severity`, the ping's `durationMs` and the `averageDurationMs` it was compared with, the `reportStatus` (`pending`, `written`, `skipped_budget` or `failed`), the report (`summary`, plus `likelyCauses` and `recommendations` as `jsonb` lists of strings), and the report call's `inputTokens`, `cachedInputTokens` and `outputTokens`.
- `chat_session`: one row per chat conversation. Its `id` is a plain token of 1 to 64 characters, made by the AI SDK's `generateId`. `title` is null until the first answer is saved, then the first 80 characters of the first question.
- `message`: one row per question or answer, linked by `sessionId`. Its `id` is the AI SDK message id: the browser's for a question, `msg-…` from the server for an answer. `role` is `user` or `assistant`. `parts` is the message's AI SDK `parts` array as `jsonb`, so an answer's tool calls, with their arguments and results, are stored inside it. There's no tool-call table.
- Only assistant rows carry tokens, in `inputTokens`, `cachedInputTokens` and `outputTokens`: the total of every model step behind the answer. Questions, cache hits and refusals have 0. The budget counts assistant rows with `inputTokens` above 0.
- `cachedInputTokens`, on `incident`, `message` and `response_summary`, is the part of `inputTokens` the provider's prompt cache served, not an extra amount. It defaults to 0, so rows from before it, and providers that don't report it, read as uncached. Migration `20261001230414_add_cached_input_tokens` added it to all three tables. See decision 56.
- `questionHash` is set on an assistant row that finished with `stop`. It's the hash of the model and every question in the conversation up to that answer, so it covers follow-ups too. It's indexed, and the answer cache looks it up within the last hour. Cache hits and refusals are saved without one. See decision 46.
- The service saves a question and its answer together with `createMessages`, which uses `createMany` with `skipDuplicates`. A question resent with the same id, as on Retry, isn't saved twice. The answer's `createdAt` is a millisecond after the question's, so a session's messages sort by `createdAt`.
- `queryPings` and `queryIncidents` run the chat's `queryDatabase` tool. They take a query already checked by `chatQuerySchema` in `src/lib/chat-query.ts` and pass its arguments to `findMany`, `aggregate` or `groupBy`. They check nothing themselves, and they must never gain a write method.
- One migration, `20261001154533_add_incidents_and_chat`, created all three. `20261001223056_add_response_kind` created `response_summary`. `20261001230414_add_cached_input_tokens` added `cachedInputTokens` to `incident`, `message` and `response_summary`. `20261001234800_remove_summary_covers_until` dropped `response_summary.covers_until`, once the on-demand "today so far" summary was removed.
- `severity`, `reportStatus`, `role`, `responseKind` and a summary's `status` are plain strings, not Postgres enums. The services decide their values.
- `saveResponseSummary(day, fields)` upserts on `day` and replaces the whole row: a field left out goes back to its empty value, so saving a day as `pending` again clears its earlier summary, findings and tokens, cached ones included.
- The budget counts a `response_summary` row by `createdAt`, like an incident or a message. Only the daily job writes a row, once per day, so `createdAt` is when its call was made. `countChargedResponseSummariesSince`, `findOldestChargedResponseSummarySince` and `sumResponseSummaryTokensSince` read it.
- `listPingOutcomesBetween(start, end)` reads a window's pings, oldest first, with only `createdAt`, `statusCode`, `durationMs`, `error`, `responseKind` and `origin`. The summary's statistics are worked out from it in the service.
- A model call's tokens are stored on the row it produced, and the hourly budget is counted from these tables. See `.claude/rules/llm.md`.
- The foreign keys are `ON DELETE RESTRICT`. Delete a ping's incidents before the ping, and a session's messages before the session. Tests do this in their clean-up: `deleteIncidentsByPingPayload` or `deleteIncidentsByPingIds` runs before `deletePingsByPayload`, and `deleteChatSessionsByIds` deletes the messages first. The app itself never deletes a conversation.
