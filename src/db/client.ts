import "server-only"
import { PrismaPg } from "@prisma/adapter-pg"
import { DATABASE_URL } from "@/config/env"
import { PrismaClient } from "@/db/generated/client"

const UTC_SESSION_TIMEZONE = "-c timezone=UTC"

const getOrCreatePrismaClient = () => {
  databaseGlobals.prismaClient ??= createPrismaClient()
  return databaseGlobals.prismaClient
}

const createPrismaClient = () => {
  const adapter = new PrismaPg({ connectionString: DATABASE_URL, options: UTC_SESSION_TIMEZONE })
  return new PrismaClient({ adapter })
}

const databaseGlobals = globalThis as unknown as { prismaClient?: PrismaClient }

export const database = getOrCreatePrismaClient()
