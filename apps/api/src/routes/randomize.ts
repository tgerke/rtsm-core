import { deliverAssignment, randomizeSubject, withActor } from "@rtsm-core/core";
import { assignments, deliveryEvents, sites } from "@rtsm-core/db";
import { randomizeRequestSchema } from "@rtsm-core/schemas";
import { and, desc, eq } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { requirePermission } from "../auth/plugin.js";
import type { AuthenticatedUser } from "../auth/service.js";
import {
  loadStudy,
  replyDomainError,
  requireMembership,
  siteIdOfBody,
  studyIdOf,
} from "./helpers.js";

export const randomizeRoutes: FastifyPluginAsync = async (app) => {
  /**
   * Randomize a subject and deliver the assignment to the EDC. The
   * allocation commits first, then delivery runs — an intake outage must not
   * roll back a consumed entry (the alternative would let a flaky network
   * reorder allocations); a failed delivery stays visible in the transfer
   * log and is safe to re-send. The response never carries the arm.
   */
  app.post(
    "/studies/:studyId/subjects/:subjectKey/randomize",
    {
      // The scope carries the requested site: a site-scoped coordinator can
      // randomize only there, and never without naming their site.
      preHandler: requirePermission("subject.randomize", (r) => ({
        studyId: studyIdOf(r),
        ...siteIdOfBody(r),
      })),
    },
    async (request, reply) => {
      const parsed = randomizeRequestSchema.safeParse(request.body ?? {});
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
      const user = request.user as AuthenticatedUser;
      const { subjectKey } = request.params as { subjectKey: string };
      const actor = { userId: user.id, label: user.username };
      try {
        const study = await loadStudy(request.server.db, studyIdOf(request));
        if (!study.enabled) return reply.code(409).send({ error: "study is disabled" });
        const assignment = await withActor(request.server.db, actor, (tx) =>
          randomizeSubject(tx, {
            studyId: studyIdOf(request),
            subjectKey,
            ...(parsed.data.stratum !== undefined ? { stratum: parsed.data.stratum } : {}),
            ...(parsed.data.strata !== undefined ? { strata: parsed.data.strata } : {}),
            ...(parsed.data.siteId !== undefined ? { siteId: parsed.data.siteId } : {}),
            createdBy: user.id,
          }),
        );
        const delivery = await deliverAssignment(request.server.db, assignment.id, actor);
        return reply.code(201).send({
          assignmentId: assignment.id,
          randomizationId: assignment.randomizationId,
          subjectKey: assignment.subjectKey,
          delivery,
        });
      } catch (err) {
        if (await replyDomainError(reply, err)) return;
        throw err;
      }
    },
  );

  app.get("/studies/:studyId/assignments", { preHandler: requireMembership() }, async (request) => {
    // Blinded listing: who was randomized when, and how delivery went.
    // Never the arm (that lives on the entry, reachable only unblinded).
    const db = request.server.db;
    const rows = await db
      .select({
        id: assignments.id,
        subjectKey: assignments.subjectKey,
        randomizationId: assignments.randomizationId,
        siteCode: sites.code,
        createdAt: assignments.createdAt,
      })
      .from(assignments)
      .leftJoin(sites, eq(sites.id, assignments.siteId))
      .where(eq(assignments.studyId, studyIdOf(request)))
      .orderBy(desc(assignments.createdAt));
    const withDelivery = [];
    for (const row of rows) {
      const [latest] = await db
        .select({ outcome: deliveryEvents.outcome, createdAt: deliveryEvents.createdAt })
        .from(deliveryEvents)
        .where(eq(deliveryEvents.assignmentId, row.id))
        .orderBy(desc(deliveryEvents.createdAt))
        .limit(1);
      withDelivery.push({ ...row, lastDelivery: latest ?? null });
    }
    return withDelivery;
  });

  /** Manual re-send (safe: the intake is idempotent, replay comes back 200). */
  app.post(
    "/studies/:studyId/assignments/:assignmentId/redeliver",
    { preHandler: requirePermission("delivery.manage", (r) => ({ studyId: studyIdOf(r) })) },
    async (request, reply) => {
      const user = request.user as AuthenticatedUser;
      const { assignmentId } = request.params as { assignmentId: string };
      const [assignment] = await request.server.db
        .select({ id: assignments.id })
        .from(assignments)
        .where(and(eq(assignments.id, assignmentId), eq(assignments.studyId, studyIdOf(request))))
        .limit(1);
      if (!assignment) return reply.code(404).send({ error: "assignment not found" });
      try {
        const delivery = await deliverAssignment(request.server.db, assignmentId, {
          userId: user.id,
          label: user.username,
        });
        return { delivery };
      } catch (err) {
        if (await replyDomainError(reply, err)) return;
        throw err;
      }
    },
  );
};
