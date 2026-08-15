import { vi } from "vitest";

// auth.login/auth.logout call `cookies()` from "next/headers" directly
// (not through createContext, which these tests bypass entirely). That API
// only works inside a real Next.js request scope, which a direct
// `appRouter.createCaller()` call in a test never has. This is test
// infrastructure standing in for the framework, not a change to
// src/server/routers/auth.ts — the router code is untouched, we're only
// giving `cookies()` somewhere to write.
const store = new Map<string, string>();

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (store.has(name) ? { name, value: store.get(name)! } : undefined),
    set: (name: string, value: string) => {
      store.set(name, value);
    },
    delete: (name: string) => {
      store.delete(name);
    },
  }),
}));
