import { createClient, type Client } from "@libsql/client";
import { drizzle, type LibSQLDatabase } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as schema from "@/db/schema";

const MIGRATIONS_FOLDER = join(process.cwd(), "tests", "drizzle");

export type TestDb = LibSQLDatabase<typeof schema>;

export interface TestDatabase {
  db: TestDb;
  client: Client;
  /** Absolute path to the backing SQLite file, so a second, independent
   * connection can be opened against the *same* data for concurrency tests. */
  path: string;
  close: () => void;
}

/**
 * Creates a fresh, file-backed SQLite database with the production schema
 * applied (via SQL migrations generated from src/db/schema.ts) and nothing
 * else in it. Each call gets its own file so tests never see each other's
 * data. File-backed (not :memory:) so concurrency tests can open a second,
 * independent connection against the same underlying data.
 */
export function createTestDatabase(): TestDatabase {
  const dir = mkdtempSync(join(tmpdir(), "flexfit-test-"));
  const path = join(dir, "test.db");
  const client = createClient({ url: `file:${path}` });
  const db = drizzle(client, { schema });

  return {
    db,
    client,
    path,
    close: () => {
      client.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Applies the generated schema migrations to a freshly created database. */
export async function migrateTestDatabase(database: TestDatabase): Promise<void> {
  await migrate(database.db, { migrationsFolder: MIGRATIONS_FOLDER });
}

/**
 * Opens a second, independent connection + drizzle instance against an
 * already-migrated test database file. Used only by concurrency tests that
 * need two genuinely separate clients racing against the same data, the way
 * two concurrent HTTP requests would in production (each tRPC request gets
 * its own `db` from createContext, but they all point at the same file).
 */
export function openSecondConnection(database: TestDatabase): { db: TestDb; client: Client } {
  const client = createClient({ url: `file:${database.path}` });
  const db = drizzle(client, { schema });
  return { db, client };
}
