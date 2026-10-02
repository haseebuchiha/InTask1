---
paths:
  - "**/*.test.*"
  - "**/*.spec.*"
  - "tests/**"
  - "e2e/**"
  - "vitest.config.*"
  - "playwright.config.*"
---

# Testing rules

These cover tests and test setup. The main rules are in `AGENTS.md`.

## Writing a test

- Before writing or changing any test, load Matt Pocock's `tdd` skill, `mattpocock-skills:tdd`, and follow it.
- Test behaviour through the public functions and routes, never the private helpers behind them. A refactor that keeps the behaviour must not break a test.
- Write the failing test first, then only enough code to pass it. One test at a time.
- Mock only at the edges: `fetch`, the model, and the browser APIs happy-dom lacks. The mocks listed under "The model" below are the agreed ones. Don't add a mock of our own code just to make a test easier to write.
- An expected value comes from a known-good literal or a worked example, never from working it out the way the code does.
- The skill agrees with the owner which public functions and routes to test before any test is written. A subagent can't ask, so whoever spawns it agrees them with the owner first and writes them into the prompt.
- Subagents may not get this file. When you spawn one that writes tests, tell it to load `mattpocock-skills:tdd` and read this file first.
- Before adding a test, answer four questions. What behaviour does it protect? What bug would make it fail? Why doesn't an existing test already catch that bug? Does it need an export or hook that no production code uses? If it needs one, test at the real boundary instead. These come from a test-audit checklist.
- Counts and limits are checked exactly. To prove a limit of 50, seed 51 rows and expect 50. A check like `<= 50` passes on an empty database.

## Proving a test

- Every new or changed test must be seen failing for the right reason. For new behaviour, the test is written first and fails until the code exists. For code that already exists, break the code on purpose, for example by dropping a filter or changing a limit, and watch the test fail. Then put the code back.
- Before deleting or merging a test, prove that a test that stays catches the same bug. Break the code the way the old test would notice, and watch the remaining test fail.
- Put broken code back straight away, and check it matches the original byte for byte by comparing a sha256 before and after. A dev server may be hot-reloading the checkout, and another session may be running the tests.
- Don't break `src/services/ping.ts` while the dev server runs, because its timer records real pings. Tamper with the test's fake input instead.
- Report each proof: what was broken, which test failed, and that the file was restored.

- Tests run with Vitest. Component tests run in happy-dom, not jsdom, because jsdom needs Node 24.15 or newer.
- Vitest runs two projects. `server` runs `tests/**/*.test.ts` in Node. `components` runs `tests/**/*.test.tsx` in happy-dom.
- Every server file imports `server-only`, and that import throws inside Vitest. The Vitest config swaps it for an empty module, so tests can import services and models.
- The Vitest config sets `LOG_LEVEL=silent` to keep pino quiet, and `AI_GATEWAY_API_KEY` to empty, so a key in `.env` never sends test traffic to the AI Gateway.
- It also pins `LLM_MODEL` to `gpt-5.5`, so the cost tests' literal prices hold whatever `.env` says. The components project pins `TZ` to `Asia/Karachi`, a zone that isn't UTC, so a date bug that only shows away from UTC still fails on CI's UTC runner. Expected times in component tests are written for that zone.
- The Vitest config also turns on `mockReset`, `restoreMocks` and `unstubGlobals`. Every mock, spy and `vi.stubGlobal` is reset before each test, so tests don't reset them by hand.
- Test files get looser lint limits: no line or statement limit per function, callbacks can nest 4 deep, and the banned vague-names list doesn't apply. Every other rule still does, including arrow functions and no comments.
- Test files may load the database client directly, for example to wipe data between runs. Every other import rule still applies to them.

## Folders

- `tests/` mirrors `src/`: a test for `src/services/ping.ts` goes in `tests/services/ping.test.ts`, and API route tests go in `tests/api/`.
- `tests/integration/` holds tests that cross layers, like a timer tick that ends on an open stream.
- `tests/support/` holds helpers that more than one test file uses:
  - `database.ts` deletes the rows a test wrote, by a field in their payload. It also deletes incidents, by their ping's id or payload, chat sessions with their messages, by id, and response summaries, by day.
  - `httpbin.ts` fakes httpbin's echo and reads the request ids a `fetch` stub saw.
  - `event-stream.ts` opens and reads the real stream route.
  - `event-source.ts` is a fake `EventSource` for component and hook tests.
  - `ping-row.ts` builds a `PingRow` for screen tests.
  - `model-provider.ts` holds `vi.mock` factories for `@ai-sdk/openai` and `@ai-sdk/gateway`: `mockOpenAIModule(builtModels, providerSettings)` and `mockGatewayModule(builtModels, providerSettings)`. Each returns a `MockLanguageModelV4`, pushes every model it builds onto `builtModels`, and records the settings each provider was built with.
  - `model-stream.ts` scripts the mock model's streamed replies. `textStep` and `toolCallStep` build one model step's chunks, with its token usage, and `withCachedInputTokens(step, count)` marks part of a step's input as served from the provider's cache. `modelUsage(input, output, cached)` builds the usage itself. `replyInSteps(model, steps)` spies on the mock model's `doStream` and answers each request with the next step, optionally with a delay between chunks. `readUIMessageChunks` and `readStreamedText` read a chat response back as UI message chunks and text.
- `tests/setup/` holds Vitest setup files.

## Screens

- Any test that renders `PingDashboard`, `IncidentList` or `useRefreshOnNewPing` must mock `next/navigation`'s `useRouter` and call `stubEventSource()` from `tests/support/event-source.ts`. happy-dom has no `EventSource`, and the fake lets a test fire open, error and ping events itself.
- nuqs's debounced updates need fake timers. The URL update fires just after the 500 ms delay.

## The database

- Server tests use the real Postgres in `DATABASE_URL`. Only `fetch` is stubbed, so httpbin is never called.
- Delete every row a test writes, and nothing else. Tests that call `recordPing` delete by the request ids the `fetch` stub saw. Tests that seed rows put a run id in the payload and delete by that. Never wipe the whole table.
- Delete incidents before their pings. The foreign key blocks deleting a ping that still has an incident.
- Tests that seed rows for a time-window read, like the 24-hour baseline, the trailing-hour budget or the model's range reads, put them on a random day inside a far-past or far-future window of their own. Real pings in the dev database, and suites running at the same time, then never land in each other's windows:
  - `tests/services/llm.test.ts`: 2001 to 2020, with `Date` faked to the seeded day.
  - `tests/services/incidents.test.ts` and `tests/api/incidents.test.ts`: the years 3000 to 3098.
  - `tests/models/incident.test.ts` and `tests/models/message.test.ts`: the years 4000 to 4098.
  - `tests/models/ping.test.ts`, for `queryPings` and `listPingOutcomesBetween`: 2100 to 2119.
  - `tests/services/chat.test.ts`: 2120 to 2159, with `Date` faked to the seeded day.
  - `tests/api/chat.test.ts`: 2160 to 2199, with `Date` faked to the seeded day.
  - `tests/models/response-summary.test.ts`: 2200 to 2209.
  - `tests/services/llm-provider.test.ts`: 1980 to 1989, with `Date` faked. It only reads, through the budget check.
  - `tests/services/response-analysis.test.ts`: 2230 to 2239, with `Date` faked to the seeded day. `findLatestResponseSummary` reads the newest row in the table, so this must stay the latest window any suite writes summaries in. The other summary suites only check that the newest rows they read are at least as new as their own.
- A new suite that seeds by time picks a window none of these use. A query a test runs, including one the mock model sends through `queryDatabase`, needs both ends of its range inside its own window. A range with only a start, like `gte` a day in 2120, also reaches every later window.

## The model

- No test calls the proxy or any model.
- `tests/services/llm.test.ts` mocks `@ai-sdk/openai` and `@ai-sdk/gateway` with `mockOpenAIModule` and `mockGatewayModule` from `tests/support/model-provider.ts`, so either provider returns a `MockLanguageModelV4` from `ai/test`, and records the settings it was built with. `services/llm.ts` doesn't export its model. Each suite keeps a `builtModels` list in `vi.hoisted`, passes it to the factories, and takes the mock with `const languageModel = builtModels[0]`: the model the model layer built when it loaded. Each test sets the reply with `vi.spyOn(languageModel, "doGenerate")`.
- `tests/services/llm-provider.test.ts` checks which provider the settings pick. Each test calls `vi.stubEnv("AI_GATEWAY_API_KEY", ...)` and `vi.resetModules()`, then imports `@/config/logger` and `@/services/llm` again, so the model layer is built fresh from the stubbed setting. It empties `builtModels` before each test and checks the one model the factories built: its provider and its model id. It calls `vi.unstubAllEnvs()` after each test.
- Tests of code above the model layer mock `@/services/llm` itself, with `generateStructured` and `hasLlmBudget` as `vi.fn()`. That covers `tests/services/incidents.test.ts` and `tests/services/response-analysis.test.ts`. `tests/integration/ping-flow.test.ts` makes `hasLlmBudget` return `false`, so a tick never reaches the model.
- The chat's tests are the exception. `tests/services/chat.test.ts` and `tests/api/chat.test.ts` mock `@ai-sdk/openai` with `mockOpenAIModule(builtModels)`, take the mock the same way as `tests/services/llm.test.ts`, and go through the real `services/llm.ts`, so the budget, the token check and `store: false` are part of what they test. Each model step's reply comes from `replyInSteps` in `tests/support/model-stream.ts`. The service test wraps `streamAnswer` in `vi.fn(original)` and spies on `@/models/message` with `{ spy: true }`, so a test can make one call fail. The API test spies on `@/services/chat` the same way.
- `tests/components/chat-screen.test.tsx` mocks `@ai-sdk/react`'s `useChat`, and checks the screen and `ChatTitle` against the messages and status it's given. It passes a stand-in object as the `Chat`. It needs no `EventSource`.
- `tests/components/chat-widget.test.tsx` is the exception: it renders the real widget with the real `useChat` and `Chat`, and stubs `fetch` with a small router for the four chat routes. Answers are UI message streams written in the test, and `heldAnswer` keeps one open until the test finishes it, to check the pulsing dot. It clears `localStorage` before each test, and blocks it with `vi.spyOn(window, "localStorage", "get")` to check the try/catch paths.
- `tests/jobs/ping.test.ts` mocks `@/services/incidents` to check the job's second step on its own. `tests/jobs/response-summary.test.ts` mocks `@/services/response-analysis` the same way.
- `tests/components/response-summary-card.test.tsx` renders the card from a summary built in the test. It mocks nothing: the card has no button and fetches nothing.

## What the brief asks for

- A CI pipeline that runs the tests, lint and a coverage report; a written choice of the app's core parts; and thorough tests for ONE of them. Unit tests for the key logic, integration tests for the API endpoints and a basic end-to-end test are all welcome.
- The core component we test thoroughly is the ping-recording process: `src/services/ping.ts` and the broadcast in `src/services/live-updates.ts`. Keep both at 100% of lines and branches. The reasons are in decision 23 of `docs/decisions.md`.
- `src/services/llm.ts` is held to 100% of lines and branches too, because it guards the model budget.
