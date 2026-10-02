import { fileURLToPath } from "node:url"
import { loadEnv } from "vite"
import { defineConfig } from "vitest/config"

const EMPTY_SERVER_ONLY = fileURLToPath(new URL("node_modules/server-only/empty.js", import.meta.url))

export default defineConfig(({ mode }) => ({
  resolve: {
    tsconfigPaths: true,
    alias: { "server-only": EMPTY_SERVER_ONLY },
  },
  test: {
    env: { ...loadEnv(mode, process.cwd(), ""), LOG_LEVEL: "silent", LLM_MODEL: "gpt-5.5", AI_GATEWAY_API_KEY: "" },
    unstubGlobals: true,
    restoreMocks: true,
    mockReset: true,
    projects: [
      { test: { name: "server", include: ["tests/**/*.test.ts"], environment: "node" } },
      {
        test: {
          name: "components",
          include: ["tests/**/*.test.tsx"],
          environment: "happy-dom",
          env: { TZ: "Asia/Karachi" },
          setupFiles: ["tests/setup/components.ts"],
        },
      },
    ],
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["src/db/generated/**"],
      reporter: ["text", "lcovonly"],
    },
  },
}))
