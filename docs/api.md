# REST API

The endpoints the app serves, what each returns, and how to call the chat with curl. The code is in [`src/app/api/`](../src/app/api/).

The brief asks for REST endpoints for historical data. Our own pages don't call them: they call the same services on the server. They're for outside callers, like a reviewer with curl, and for tests. The chat routes are the exception, because the widget calls them ([decision 40](decisions.md#40-the-browser-calls-one-api-route-for-the-chat)).

| Endpoint | Returns |
|---|---|
| `GET /api/pings` | A page of 20 pings, newest first, without `payload` and `response`, with `totalCount`, `page` and `pageSize` |
| `GET /api/pings/:id` | One ping in full, including the payload and httpbin's response |
| `GET /api/pings/stream` | The live stream: a `ping` event per new ping, and an `incident` event per new incident |
| `GET /api/incidents` | The 50 most recent incidents, newest first, each with a short summary of its ping |
| `GET /api/incidents/:id` | One incident in full, with its report and token counts |
| `POST /api/chat` | Answers one chat question, streamed as the AI SDK's UI message stream |
| `GET /api/chat/sessions` | The 20 newest chat sessions, with their ids, start times and titles |
| `POST /api/chat/sessions` | Starts an untitled chat session, with status 201. Takes no body |
| `GET /api/chat/sessions/:id` | One chat session and its messages, oldest first |

`GET /api/pings` takes `page`, `from` and `to` (ISO 8601 dates or times, both ends included) and `failedOnly=true`, read by the same nuqs parsers as the dashboard ([decision 10](decisions.md#10-keep-the-tables-filters-and-pages-in-the-url-with-nuqs)). Errors come back as `{ "error": "..." }`: a 400 for a value that can't be read at all, like `page=abc`, `to=2026-02-30` or a ping id of `0`, and a 404 for an id that doesn't exist.

```bash
curl "http://localhost:3000/api/pings?from=2026-09-30&to=2026-09-30T23:59:59.999Z&failedOnly=true&page=2"
```

## Asking the chat with curl

Start a session with `curl -X POST http://localhost:3000/api/chat/sessions` and copy its `id`. Then send the conversation, which for a first question is the question alone ([decision 42](decisions.md#42-send-the-whole-conversation-with-every-question)):

```bash
curl -N http://localhost:3000/api/chat \
  -H "Content-Type: application/json" \
  -d '{
    "id": "SESSION_ID",
    "messages": [
      { "id": "question-1", "role": "user", "parts": [{ "type": "text", "text": "How many pings failed this week?" }] }
    ]
  }'
```

The answer streams back as server-sent events: each query's input and output, the text in pieces, and a finish chunk with the token usage, then `data: [DONE]`. It's a real model call, and it counts against the budget unless it comes from the cache. For a follow-up, send the whole conversation again, with the answer as an `assistant` message and the new question last.
