import { z } from "zod";
import { router, adminProcedure } from "../trpc";
import { getAdminStats, getClassUtilisation } from "./admin/dashboard";
import {
  getRevenueByMonth,
  getRevenueByMethod,
  getExpiringMemberships,
  getRefundCount,
} from "./admin/revenue-reports";
import {
  getCheckinsPerDay,
  getTopTrainers,
  getNoShowList,
} from "./admin/attendance-reports";

// This router only declares the tRPC procedure shape (input validation,
// adminProcedure authorization) for each existing endpoint. The query
// bodies themselves live in ./admin/{dashboard,revenue-reports,
// attendance-reports}.ts, grouped by which admin page actually consumes
// them — see docs/refactoring-plan.md §7. Every procedure name, input
// schema, and authorization wrapper below is unchanged from the original
// single-file admin.ts.
export const adminRouter = router({
  stats: adminProcedure.query(async ({ ctx }) => getAdminStats(ctx.db)),

  classUtilisation: adminProcedure
    .input(z.object({ limit: z.number().default(10) }).default({}))
    .query(async ({ ctx, input }) => getClassUtilisation(ctx.db, input.limit)),

  revenueByMonth: adminProcedure.query(async ({ ctx }) => getRevenueByMonth(ctx.db)),

  revenueByMethod: adminProcedure.query(async ({ ctx }) => getRevenueByMethod(ctx.db)),

  expiringMemberships: adminProcedure.query(async ({ ctx }) => getExpiringMemberships(ctx.db)),

  refundCount: adminProcedure.query(async ({ ctx }) => getRefundCount(ctx.db)),

  checkinsPerDay: adminProcedure.query(async ({ ctx }) => getCheckinsPerDay(ctx.db)),

  topTrainers: adminProcedure.query(async ({ ctx }) => getTopTrainers(ctx.db)),

  noShowList: adminProcedure.query(async ({ ctx }) => getNoShowList(ctx.db)),
});
