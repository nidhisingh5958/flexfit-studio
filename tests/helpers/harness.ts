import { beforeEach, afterEach } from "vitest";
import { createTestDatabase, migrateTestDatabase, type TestDatabase, type TestDb } from "./db";

/**
 * Registers beforeEach/afterEach hooks that give every test in the calling
 * file a fresh, schema-migrated, empty SQLite database. Call once at the top
 * of a test file (outside any `it`), then read `harness.db` / `harness.raw`
 * inside each test.
 */
export function useTestDatabase() {
  let current: TestDatabase | undefined;

  beforeEach(async () => {
    current = createTestDatabase();
    await migrateTestDatabase(current);
  });

  afterEach(() => {
    current?.close();
    current = undefined;
  });

  return {
    get db(): TestDb {
      if (!current) throw new Error("Test database not initialized — access inside an it()/beforeEach body.");
      return current.db;
    },
    get raw(): TestDatabase {
      if (!current) throw new Error("Test database not initialized — access inside an it()/beforeEach body.");
      return current;
    },
  };
}
