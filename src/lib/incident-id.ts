import * as zod from "zod"

export const LARGEST_INCIDENT_ID = 2_147_483_647

export const parseIncidentId = (text: string) => incidentIdSchema.safeParse(text).data ?? null

const incidentIdSchema = zod.coerce.number().int().min(1).max(LARGEST_INCIDENT_ID)
