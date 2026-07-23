import { auditEvents } from "@rtsm-core/db";
import { desc, eq } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { requirePermission } from "../auth/plugin.js";
import { studyIdOf } from "./helpers.js";

export const auditRoutes: FastifyPluginAsync = async (app) => {
  // The per-study audit chain. Snapshots are already blinding-safe: the
  // trigger strips arm/payload/credentials before hashing (0001), so
  // audit.review does not imply unblinded access.
  app.get(
    "/studies/:studyId/audit",
    { preHandler: requirePermission("audit.review", (r) => ({ studyId: studyIdOf(r) })) },
    async (request) => {
      const query = request.query as { limit?: string };
      const limit = Math.min(Number(query.limit ?? 100) || 100, 500);
      return request.server.db
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.chainScope, `study:${studyIdOf(request)}`))
        .orderBy(desc(auditEvents.id))
        .limit(limit);
    },
  );
};
