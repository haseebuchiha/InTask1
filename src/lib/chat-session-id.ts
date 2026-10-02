import * as zod from "zod"

export const parseChatSessionId = (text: string) => chatSessionIdSchema.safeParse(text).data ?? null

const chatSessionIdSchema = zod.string().regex(/^[\w-]{1,64}$/u)
