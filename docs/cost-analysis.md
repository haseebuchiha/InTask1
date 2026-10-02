# Cost analysis

What the model calls cost, measured call by call, and what an hour at the cap can cost at worst. The controls that bound these numbers are in [`ai-features.md`](ai-features.md#cost-controls).

These use the estimated prices in [`src/services/llm.ts`](../src/services/llm.ts) for gpt-5.5: $5 per million input tokens, $0.50 per million cached input tokens and $30 per million output tokens. They're estimates, not a bill. A cost is input × $5 / 1,000,000 + output × $30 / 1,000,000, so the report below is $0.0040 + $0.0060 ≈ $0.01.

| Measured call | Input tokens | Output tokens | Estimated cost |
|---|---|---|---|
| An incident report: a ping of 2821 ms against an 884 ms average, written in about 5 seconds | 798 | 199 | $0.010 |
| The daily summary of 2026-09-30, 850 pings | 503 | 166 | $0.0075 |
| A summary of 2,015 pings, at a 30-second interval | 579 | 229 | $0.0098 |
| Chat: "How many pings failed this week?", 1 query | 1,867 | 219 | $0.016 |
| Chat: "And what was the slowest one?", a follow-up, 2 queries | 2,328 | 307 | $0.021 |
| Chat: "Summarize incidents in the last 24 hours", a follow-up, 4 queries | 2,494 | 551 | $0.029 |
| Chat: "List the 20 slowest pings this month with their ids and durations and explain each one", 2 queries | 5,467 | 1,299 | $0.066 |
| Chat: a later first question and its follow-up | 2,138 + 6,242 | 157 + 1,123 | $0.08 |
| Chat: the same conversations again, in a new chat | 0 | 0 | $0, from the cache |

| Ceiling | Calls | Estimated cost |
|---|---|---|
| An hour at the cap, every call a report like the one above | 20 | $0.20 an hour, $4.78 a day |
| An hour at the cap, every prompt at the 6000-token limit, about 4,000 tokens out | 20 | $3.00 an hour |
| A report for every ping at the default interval, for a day | 288 | $2.87 a day |
| An hour at the cap, every call a chat answer like the third one above | 20 | $0.58 an hour, $13.92 a day |
| An hour at the cap, every answer as heavy as the 20-row one | 20 | $1.33 an hour, $31.83 a day |
| The daily summary | 1 a day | about $0.01 a day, $0.30 a month |

What this tells us:

- With incidents alone, the cap can't be reached at the default interval: there's at most one report per ping, so 12 an hour. The chat is what can reach it.
- An hour at the cap costs about three times as much in chat answers as in reports, $0.58 against $0.20. The cap bounds both, and most pings aren't incidents, so a normal day costs far less.
- A chat answer is mostly input: every step resends the instructions, the tool's description, the conversation and the results so far. A typical answer is 2,000 to 3,000 tokens, or 2 to 3 cents. The usage card's estimate matched these rows.
- The 6000-token limit bounds the instructions and the conversation's text, not query results, so one answer can cost more than the heavy case. The cap on calls is what bounds the spend.
- The summary's prompt holds counts, not rows, so it stays a few hundred tokens whether a day has 850 pings or 2,015.
- The answer cache makes a repeated conversation free, follow-ups included. Retries are off, so a flaky provider can't multiply calls behind the budget's back.

## Provider prompt caching

OpenAI bills the start of a prompt it has seen recently, for prompts of 1,024 tokens or more, at a tenth of the input price. Every chat step resends the same instructions and tool description, so chat answers are where this pays off ([decisions 44](decisions.md#44-store-false-on-every-chat-call) and [56](decisions.md#56-store-cached-input-tokens-and-price-them-at-the-discount)). The app stores each call's `cached_input_tokens` and prices them at $0.50 per million. Each kind of call sends its own prompt cache key, `ping-monitor-chat`, `ping-monitor-incident` or `ping-monitor-summary`, and through the gateway asks for 24-hour retention. A typical answer's 2,500 input tokens cost $0.0125 at the full price, and $0.00125 if all were cached. The ceilings above leave the discount out. Every measurement in this file came through the local proxy, which reports 0 cached tokens, so the discount only shows up against the real API.
