import { withActor } from "@rtsm-core/core";
import { depots } from "@rtsm-core/db";
import { depotCreateSchema, depotUpdateSchema } from "@rtsm-core/schemas";
import { and, asc, eq } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { requirePermission } from "../auth/plugin.js";
import type { AuthenticatedUser } from "../auth/service.js";
import {
  isUniqueViolation,
  loadStudy,
  replyDomainError,
  requireMembership,
  studyIdOf,
} from "./helpers.js";

// Depots are supply configuration, not sites (ADR-0009): no subjects, no
// site-scoped grants. Management rides kit.manage like the rest of the
// supply surfaces.
export const depotRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    "/studies/:studyId/depots",
    { preHandler: requirePermission("kit.manage", (r) => ({ studyId: studyIdOf(r) })) },
    async (request, reply) => {
      const parsed = depotCreateSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
      const user = request.user as AuthenticatedUser;
      try {
        await loadStudy(request.server.db, studyIdOf(request));
        const depot = await withActor(
          request.server.db,
          { userId: user.id, label: user.username },
          async (tx) => {
            const [row] = await tx
              .insert(depots)
              .values({ studyId: studyIdOf(request), ...parsed.data })
              .returning();
            if (!row) throw new Error("depot insert returned no row");
            return row;
          },
        );
        return reply.code(201).send(depot);
      } catch (err) {
        if (isUniqueViolation(err)) {
          return reply.code(409).send({ error: "depot code already exists in this study" });
        }
        if (await replyDomainError(reply, err)) return;
        throw err;
      }
    },
  );

  app.get("/studies/:studyId/depots", { preHandler: requireMembership() }, async (request) => {
    return request.server.db
      .select()
      .from(depots)
      .where(eq(depots.studyId, studyIdOf(request)))
      .orderBy(asc(depots.code));
  });

  app.put(
    "/studies/:studyId/depots/:depotId",
    { preHandler: requirePermission("kit.manage", (r) => ({ studyId: studyIdOf(r) })) },
    async (request, reply) => {
      const parsed = depotUpdateSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
      const user = request.user as AuthenticatedUser;
      const { depotId } = request.params as { depotId: string };
      const depot = await withActor(
        request.server.db,
        { userId: user.id, label: user.username },
        async (tx) => {
          const [row] = await tx
            .update(depots)
            .set({ ...parsed.data, updatedAt: new Date() })
            .where(and(eq(depots.id, depotId), eq(depots.studyId, studyIdOf(request))))
            .returning();
          return row ?? null;
        },
      );
      if (!depot) return reply.code(404).send({ error: "depot not found" });
      return depot;
    },
  );
};
