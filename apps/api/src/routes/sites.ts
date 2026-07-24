import { withActor } from "@rtsm-core/core";
import { sites } from "@rtsm-core/db";
import { siteCreateSchema, siteUpdateSchema } from "@rtsm-core/schemas";
import { and, asc, eq } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { requirePermission } from "../auth/plugin.js";
import type { AuthenticatedUser } from "../auth/service.js";
import { loadStudy, replyDomainError, requireMembership, studyIdOf } from "./helpers.js";

/** Postgres 23505, possibly wrapped by the driver/ORM in `cause`. */
function isUniqueViolation(err: unknown): boolean {
  for (let e = err; typeof e === "object" && e !== null; e = (e as Error).cause) {
    if ((e as { code?: string }).code === "23505") return true;
  }
  return false;
}

export const siteRoutes: FastifyPluginAsync = async (app) => {
  // Site setup is study administration; allowSystemAdmin mirrors study.manage
  // (it confers no trial capability — site-bound acts stay behind their own
  // permissions).
  app.post(
    "/studies/:studyId/sites",
    {
      preHandler: requirePermission("site.manage", (r) => ({ studyId: studyIdOf(r) }), {
        allowSystemAdmin: true,
      }),
    },
    async (request, reply) => {
      const parsed = siteCreateSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
      const user = request.user as AuthenticatedUser;
      try {
        await loadStudy(request.server.db, studyIdOf(request));
        const site = await withActor(
          request.server.db,
          { userId: user.id, label: user.username },
          async (tx) => {
            const [row] = await tx
              .insert(sites)
              .values({ studyId: studyIdOf(request), ...parsed.data })
              .returning();
            if (!row) throw new Error("site insert returned no row");
            return row;
          },
        );
        return reply.code(201).send(site);
      } catch (err) {
        if (isUniqueViolation(err)) {
          return reply.code(409).send({ error: "site code already exists in this study" });
        }
        if (await replyDomainError(reply, err)) return;
        throw err;
      }
    },
  );

  app.get("/studies/:studyId/sites", { preHandler: requireMembership() }, async (request) => {
    return request.server.db
      .select()
      .from(sites)
      .where(eq(sites.studyId, studyIdOf(request)))
      .orderBy(asc(sites.code));
  });

  app.put(
    "/studies/:studyId/sites/:siteId",
    {
      preHandler: requirePermission("site.manage", (r) => ({ studyId: studyIdOf(r) }), {
        allowSystemAdmin: true,
      }),
    },
    async (request, reply) => {
      const parsed = siteUpdateSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
      const user = request.user as AuthenticatedUser;
      const { siteId } = request.params as { siteId: string };
      const site = await withActor(
        request.server.db,
        { userId: user.id, label: user.username },
        async (tx) => {
          const [row] = await tx
            .update(sites)
            .set({ ...parsed.data, updatedAt: new Date() })
            .where(and(eq(sites.id, siteId), eq(sites.studyId, studyIdOf(request))))
            .returning();
          return row ?? null;
        },
      );
      if (!site) return reply.code(404).send({ error: "site not found" });
      return site;
    },
  );
};
