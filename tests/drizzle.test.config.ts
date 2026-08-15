import type { Config } from "drizzle-kit";

// Test-only migration generator. The app itself uses `drizzle-kit push`
// against a dev DB file (see drizzle.config.ts); tests need real, replayable
// SQL migrations so each test can spin up an isolated SQLite file quickly.
export default {
  schema: "./src/db/schema.ts",
  out: "./tests/drizzle",
  dialect: "sqlite",
  dbCredentials: {
    url: "file:tests/.tmp-gen.db",
  },
} satisfies Config;
