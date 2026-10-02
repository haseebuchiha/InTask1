import { describe, expect, test } from "vitest"
import { parseChatSessionId } from "@/lib/chat-session-id"

describe("parseChatSessionId", () => {
  test.each(["abc", "a1B2-c3_d4", "x".repeat(64)])("accepts the plain token %s", (sessionId) => {
    expect(parseChatSessionId(sessionId)).toBe(sessionId)
  })

  test.each(["", "x".repeat(65), "has space", "slash/inside", "dot.inside", "émoji", "../etc"])(
    "rejects %j",
    (sessionId) => {
      expect(parseChatSessionId(sessionId)).toBeNull()
    },
  )
})
