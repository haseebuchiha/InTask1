import * as zod from "zod"

export const LARGEST_PING_ID = 2_147_483_647

export const parsePingId = (text: string) => pingIdSchema.safeParse(text).data ?? null

const pingIdSchema = zod.coerce.number().int().min(1).max(LARGEST_PING_ID)
