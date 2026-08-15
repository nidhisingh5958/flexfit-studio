import { appRouter } from "@/server/routers/_app";
import type { Context } from "@/server/trpc";
import type { User } from "@/db/schema";
import type { TestDb } from "./db";

/**
 * Builds a tRPC caller against a test database, impersonating `user` (or
 * anonymous if omitted) — mirrors what `createContext` builds from a real
 * session cookie in `src/server/trpc.ts`, without going through Next.js
 * `cookies()`/HTTP, since routers only depend on `ctx.db` / `ctx.user` /
 * `ctx.token`.
 */
export function callerAs(db: TestDb, user: User | null, token: string | null = null) {
  const ctx: Context = { db: db as unknown as Context["db"], user, token };
  return appRouter.createCaller(ctx);
}

export type Caller = ReturnType<typeof callerAs>;
