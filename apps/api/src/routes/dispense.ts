import { dispenseKit, withActor } from "@rtsm-core/core";
import { assignments, dispenseEvents, kits, sites } from "@rtsm-core/db";
import { dispenseRequestSchema } from "@rtsm-core/schemas";
import { desc, eq } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { requirePermission } from "../auth/plugin.js";
import type { AuthenticatedUser } from "../auth/service.js";
import { replyDomainError, requireMembership, siteIdOfBody, studyIdOf } from "./helpers.js";

export const dispenseRoutes: FastifyPluginAsync = async (app) => {
  /**
   * Dispense a kit to a randomized subject. Site-bound: the scope carries the
   * dispensing site, so a site-scoped grant works only there. The response is
   * blinded — a kit number, never an arm or kit type.
   */
  app.post(
    "/studies/:studyId/subjects/:subjectKey/dispense",
    {
      preHandler: requirePermission("kit.dispense", (r) => ({
        studyId: studyIdOf(r),
        ...siteIdOfBody(r),
      })),
    },
    async (request, reply) => {
      const parsed = dispenseRequestSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
      const user = request.user as AuthenticatedUser;
      const { subjectKey } = request.params as { subjectKey: string };
      try {
        const result = await withActor(
          request.server.db,
          { userId: user.id, label: user.username },
          (tx) =>
            dispenseKit(tx, {
              studyId: studyIdOf(request),
              subjectKey,
              siteId: parsed.data.siteId,
              dispensedBy: user.id,
            }),
        );
        return reply.code(201).send({ subjectKey, ...result });
      } catch (err) {
        if (await replyDomainError(reply, err)) return;
        throw err;
      }
    },
  );

  /** Blinded dispense log: who received which kit number, where, when. */
  app.get("/studies/:studyId/dispenses", { preHandler: requireMembership() }, async (request) => {
    return request.server.db
      .select({
        id: dispenseEvents.id,
        subjectKey: assignments.subjectKey,
        kitNumber: kits.kitNumber,
        siteCode: sites.code,
        createdAt: dispenseEvents.createdAt,
      })
      .from(dispenseEvents)
      .innerJoin(assignments, eq(assignments.id, dispenseEvents.assignmentId))
      .innerJoin(kits, eq(kits.id, dispenseEvents.kitId))
      .innerJoin(sites, eq(sites.id, dispenseEvents.siteId))
      .where(eq(dispenseEvents.studyId, studyIdOf(request)))
      .orderBy(desc(dispenseEvents.createdAt))
      .limit(200);
  });
};
