import { breakCode, withActor } from "@rtsm-core/core";
import { assignments, codeBreaks, users } from "@rtsm-core/db";
import { codeBreakRequestSchema } from "@rtsm-core/schemas";
import { and, desc, eq } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { requirePermission } from "../auth/plugin.js";
import { hasPermission } from "../auth/rbac.js";
import type { AuthenticatedUser } from "../auth/service.js";
import { replyDomainError, requireMembership, studyIdOf } from "./helpers.js";

export const codeBreakRoutes: FastifyPluginAsync = async (app) => {
  /**
   * Emergency code-break (ADR-0007): password step-up plus a captured reason,
   * and the response carries the arm exactly once. The permission check runs
   * in the handler, not a preHandler, because the site binding comes from the
   * subject's assignment: a site-scoped subject.codebreak grant reaches only
   * subjects randomized at that site, and a site-less assignment requires a
   * study-wide grant.
   */
  app.post(
    "/studies/:studyId/subjects/:subjectKey/codebreak",
    { preHandler: requireMembership() },
    async (request, reply) => {
      const parsed = codeBreakRequestSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
      const user = request.user as AuthenticatedUser;
      const { subjectKey } = request.params as { subjectKey: string };
      const studyId = studyIdOf(request);

      const [assignment] = await request.server.db
        .select({ siteId: assignments.siteId })
        .from(assignments)
        .where(and(eq(assignments.studyId, studyId), eq(assignments.subjectKey, subjectKey)))
        .limit(1);
      const allowed = await hasPermission(request.server.db, user.id, "subject.codebreak", {
        studyId,
        ...(assignment?.siteId ? { siteId: assignment.siteId } : {}),
      });
      if (!allowed) {
        return reply.code(403).send({ error: "missing permission: subject.codebreak" });
      }
      const reauth = await request.server.authService.reauthenticate(user.id, parsed.data.password);
      if (!reauth.ok) {
        return reply.code(403).send({ error: `re-authentication failed: ${reauth.reason}` });
      }
      try {
        const result = await withActor(
          request.server.db,
          { userId: user.id, label: user.username },
          (tx) =>
            breakCode(tx, {
              studyId,
              subjectKey,
              reason: parsed.data.reason,
              performedBy: user.id,
            }),
        );
        return reply.code(201).send(result);
      } catch (err) {
        if (await replyDomainError(reply, err)) return;
        throw err;
      }
    },
  );

  /** Code-break log: blinded-safe by construction — the table has no arm. */
  app.get(
    "/studies/:studyId/codebreaks",
    { preHandler: requirePermission("audit.review", (r) => ({ studyId: studyIdOf(r) })) },
    async (request) => {
      return request.server.db
        .select({
          id: codeBreaks.id,
          subjectKey: assignments.subjectKey,
          reason: codeBreaks.reason,
          performedBy: users.username,
          createdAt: codeBreaks.createdAt,
        })
        .from(codeBreaks)
        .innerJoin(assignments, eq(assignments.id, codeBreaks.assignmentId))
        .innerJoin(users, eq(users.id, codeBreaks.createdBy))
        .where(eq(codeBreaks.studyId, studyIdOf(request)))
        .orderBy(desc(codeBreaks.createdAt))
        .limit(200);
    },
  );
};
