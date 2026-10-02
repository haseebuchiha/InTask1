---
paths:
  - "src/**/*.tsx"
  - "src/components/**"
  - "src/hooks/**"
  - "src/app/**"
  - "components.json"
---

# Screen rules

These cover pages, components, hooks and styling. The main rules are in `AGENTS.md`.

## shadcn/ui

- shadcn/ui is set up with its current default style, which builds components on Base UI, not Radix.
- Screens use shadcn components from `src/components/ui/`, never raw `button`, `input`, `textarea`, `select`, `table` or `dialog` elements. Add a missing one with `pnpm dlx shadcn@latest add <name>`.
- `src/components/ui/` and `src/lib/utils.ts`, which holds the `cn` helper, are shadcn's code. Don't hand-edit them. They only follow Next's own lint rules, and Biome doesn't format them.
- `src/components/ai-elements/` holds components copied from Vercel's AI Elements registry. They're vendored the same way, in the `VENDORED` list in `eslint.config.mjs` and the `files.includes` list in `biome.json`. See "The chat" below.
- `@shadcn/lint` is pinned to one exact version because it is new and changes fast. Upgrade it on purpose, then run `pnpm lint`.
- To compare our shadcn components with the latest upstream ones, run `pnpm exec shadcn add <names> --dry-run` by hand. Don't use `shadcn diff`: it is deprecated and gives wrong answers.

## Styling

- Colours come from the theme in `src/app/globals.css`, like `text-muted-foreground`. Raw colours like `bg-zinc-500`, made-up values like `w-[158px]` and inline `style` all fail lint.
- Tailwind classes that clash, like `p-4 p-2`, or repeat fail lint. Lint also wants classes in a set order and their shortest form; `pnpm exec eslint --fix <file>` does that for you.
- The Tailwind checker's `no-deprecated-classes` rule is off on purpose. Its auto-fix turns `rounded` into `rounded-sm`, which is a different size in our theme. Don't switch it on.
- Fonts: `layout.tsx` loads Geist into `--font-geist-sans` and `--font-geist-mono`, and `globals.css` sets `--font-sans: var(--font-geist-sans)`. Never point `--font-sans` at itself. shadcn's setup did that once, and the whole page fell back to a serif font.

## Components

- Components are the exception. They can run up to 300 lines. Split them into sections where it makes the screen easier to follow, not just to make them shorter.
- The 300-line, 10-statement and complexity-10 limits apply to every function in a `.tsx` file, not just components. Past 10 statements, move the logic into a hook in `src/hooks/`.
- A component is a named arrow function. Type its props directly. Don't use `React.FC`.
- A generic component needs a trailing comma in `.tsx`: `const PingList = <Entry,>(...) => ...`.
- React 19 passes `ref` as a normal prop, so don't use `forwardRef`. For `memo`, wrap a named component, like `memo(PingRow)`, never `memo(() => ...)`.
- Event handlers in JSX are named functions. An inline callback with a `{ }` body fails lint, except inside a hook call like `useEffect`.
- `layout.tsx` wraps the app in nuqs's `NuqsAdapter` and in the page's `<main>` wrapper, with `SiteNav`, the Dashboard and Incidents links, above the `<main>`, and `ChatWidget` after it. Keep all three. Pages, `not-found.tsx` and `error.tsx` render straight into that `<main>`, without one of their own. `global-error.tsx` replaces the whole layout, so it keeps its own.
- Display helpers used by more than one component, like `formatDuration`, `formatPingInterval` and `formatCachedTokens`, live in `src/components/ping-formatting.tsx`. So does `ResponseKindBadge`, which the ping table's Response column and the ping page's header share. Its labels are Clean echo, Echo mismatch, Empty body, Client error, Gateway error and No reply.
- `formatCachedTokens` gives " (300 cached)", or nothing at 0, for the chat's token line, an incident's input tokens and the summary card's token line. The usage card adds "1,200 cached input tokens today" only when there are any.
- Browser-side code imports Prisma types, like `Ping`, from `@/db/generated/browser`. Only server code imports from `@/db/generated/client`.
- A link that looks like a button is a Next `Link` with `className={cn(buttonVariants(...))}`, like the back links in `ping-details.tsx` and `not-found.tsx`. Screen readers then announce it as a link. Don't use `Button` with `nativeButton={false}` for links.
- Put a `Label` beside a `Switch` and link them with `htmlFor` and the switch's `id`. Don't wrap the switch in the label: in happy-dom, one click then toggles it twice.

## Data and states

- Pages get data by calling a service on the server. Filter and page changes go through nuqs, which re-runs the page on the server. nuqs's `startTransition` option shows that a change is still loading.
- A page that reads `searchParams`, like the dashboard, already renders on every request, so it doesn't call `await connection()`. `src/app/pings/[id]/page.tsx` and both incident pages don't read `searchParams`, and they still start with `await connection()`.
- nuqs filter controls use `shallow: false` so the server page re-runs.
- Use `error.tsx` for error states. It needs `"use client"`, and in Next 16.3 it receives `retry`, not `reset`.
- Don't add a `loading.tsx` anywhere. A root one puts a skeleton into the dashboard's first HTML instead of the table. Any one makes a page start streaming before it knows a ping is missing, so Not found comes back with status 200 instead of 404. See decision 25 in `docs/decisions.md`.
- A text or date box that updates the URL waits before it does, with nuqs's `limitUrlUpdates: debounce(500)`, so typing doesn't fire a request for every key.
- The dashboard starts with `ResponseSummaryCard` (`src/components/response-summary-card.tsx`), above the model usage card and the table. The page loads the latest summary with `findLatestResponseSummary()` and passes it down. The heading is "Yesterday's summary" or, for an older day, "Daily summary", from the summary's `relativeDay`, and the window under it is two `LocalTime`s: the day's UTC midnight and the next one. A summary always covers a whole UTC day. A written summary shows its paragraph, its findings as a list and a muted token line, like "412 input tokens (300 cached), 120 output tokens". A skipped, failed or pending one says why it has no text. With no summary: "No summary yet. The first one is written after midnight UTC."
- The card only shows. It has no button and fetches nothing: the daily job writes the summary, and the next live refresh shows it. See decision 54.
- The card never reads the clock while it renders. React's purity lint rejects `new Date()` in a component, so the server works out `relativeDay`.
- Live updates come from one hook, `useRefreshOnNewPing`. On every new ping or incident it calls `router.refresh()`, and the server re-renders the page. The browser never adds rows itself. See `.claude/rules/live-updates.md`. The chat doesn't use it.

## The chat

- The chat is a floating widget, not a page. `ChatWidget` (`src/components/chat-widget.tsx`) is mounted once, in `layout.tsx`, so it's on every page and keeps its state, and any answer still streaming, while the user moves between pages. There's no `/chat` route. See decision 53.
- A button with a chat icon is fixed bottom-right. It opens a panel that slides in from the right: full height, full width on phones, `sm:max-w-md` from `sm` up. While an answer streams and the panel is closed, the button shows a pulsing dot and its name becomes "Open chat, an answer is streaming".
- The panel is non-modal: `Sheet` with `modal={false}` and `disablePointerDismissal`, so the nav and the page stay usable and clicking them doesn't close it. Esc and the Close button do. shadcn's `SheetContent` always draws a full-page overlay that would block those clicks, so the panel is Base UI's `Dialog.Portal` and `Dialog.Popup`, imported as `SheetPrimitive` like `sheet.tsx` does, inside our `Sheet`. `ui/sheet.tsx` stays as the shadcn CLI wrote it. The title, description, trigger and close button are still shadcn's `SheetTitle`, `SheetDescription`, `SheetTrigger` and `SheetClose`.
- shadcn's lint won't let `Button` be restyled with `rounded-full` or `shadow-lg`, so the launcher keeps `Button`'s own shape at `size-14`, and a plain wrapper `div` carries the fixed position and the shadow.
- The panel's header: the title (the session's title, or the first 80 characters of the first question, or "Chat"), the description, `ChatHistoryMenu`, a New chat button and Close. Below it, `ChatScreen` with `key={conversation.key}`, so switching chats starts fresh. While a stored conversation loads, "Loading the chat…" shows instead.
- `useChatConversation` (`src/hooks/use-chat-conversation.ts`) holds the conversation: a `Chat` instance from `@ai-sdk/react`, made outside React and passed down, so closing the panel or unmounting `ChatScreen` never stops an answer. Every part that needs the chat's state calls `useChat({ chat })` on that instance: `ChatScreen`, `ChatTitle` and the launcher's dot.
- The session id lives in `localStorage` under `chat-session-id`. Every read and write is wrapped in try/catch, so blocked storage only means the chat isn't restored on reload.
- On first open, a stored id is loaded with `GET /api/chat/sessions/:id`. A 404 clears the stored id and starts an empty chat; any other failure starts an empty chat and keeps the id. With no stored id, the chat starts empty and no session is made yet.
- A session is made lazily. The `Chat`'s `DefaultChatTransport` has a `prepareSendMessagesRequest` that resolves the session id before every request, calling `POST /api/chat/sessions` the first time and storing the id. A failed start shows as the chat's error, and Retry tries again. The `Chat`'s own `id` is a local key, so the started session never re-creates the `Chat` mid-answer.
- `ChatHistoryMenu` (`src/components/chat-history-menu.tsx`) is a shadcn `DropdownMenu`. It fetches `GET /api/chat/sessions` each time it opens and lists the 20 newest as `DropdownMenuRadioItem`s, the current one checked. Picking one stores its id and loads it. New chat clears the stored id and starts an empty chat.
- `ChatScreen` (`src/components/chat-screen.tsx`) takes the `Chat` and draws the conversation, then a footer with an error line with Retry, three suggestion chips while the conversation is empty, and the question box.
- The question box is a shadcn `Textarea` with a Send `Button`. Enter sends and Shift+Enter adds a line. The box is disabled while an answer streams, and Send becomes Stop. Retry calls `regenerate()`.
- `ChatMessage` (`src/components/chat-message.tsx`) draws one message. Text goes in a shadcn `Bubble` through Streamdown. A `queryDatabase` call is a collapsed AI Elements `Tool` titled "Queried pings" or "Queried incidents", with its arguments and result. An answer has a token line in the `MessageFooter`, like "1,240 tokens (300 cached)", with the cached part only when the provider's prompt cache served some input, and "from cache" for a cache hit.
- The conversation sits in AI Elements' `Conversation`, which keeps it pinned to the bottom while an answer streams. While `status` is `submitted` or `streaming`, "Thinking…" with the `Loader` shows on the answer's side: as `PendingAnswer` before the answer exists, then inside the answer whenever its last part isn't text or a running query. gpt-5.5 reasons first and streams `reasoning` parts with empty text, so they are drawn as that line and never as their own block. AI Elements' `reasoning` was left out: it would open to an empty panel and needs Radix, motion and four Streamdown plugins.
- `src/app/globals.css` has `@source "../../node_modules/streamdown/dist/*.js"`, so Tailwind generates the classes Streamdown's output uses. Keep it.

### AI Elements on Base UI

- AI Elements is written for shadcn on Radix. Our shadcn is on Base UI, so copied AI Elements code can break in two ways. Radix's `asChild` prop doesn't exist in Base UI, which uses `render`. And Radix marks open panels with `data-state="open"`, while Base UI uses `data-open`, `data-closed` and, on a trigger, `data-panel-open`.
- Only Radix-free components were taken: `conversation`, `tool`, `loader` and `code-block`. `tool.tsx` is patched: its `data-[state=open]` and `data-[state=closed]` classes became `data-open` and `data-closed`, and the chevron turns on `group-data-panel-open`.
- Don't add AI Elements components that use `asChild`, like `message` or `prompt-input`. Use shadcn's own `message`, `bubble`, `textarea` and `button`, which already work on Base UI.
- After updating an AI Elements file, apply the Base UI patch again and check its `data-` classes. Vendored files skip our screen rules, so they may keep raw colours, like the status icons in `tool.tsx`. See decision 43 in `docs/decisions.md`.
