import { activateList, importList, recordUnblindedAccess, withActor } from "@rtsm-core/core";
import { assignments, randomizationEntries, randomizationLists } from "@rtsm-core/db";
import { listActivateSchema, listImportSchema } from "@rtsm-core/schemas";
import { and, asc, eq } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { requirePermission } from "../auth/plugin.js";
import type { AuthenticatedUser } from "../auth/service.js";
import { loadStudy, replyDomainError, requireMembership, studyIdOf } from "./helpers.js";

export const listRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    "/studies/:studyId/lists",
    { preHandler: requirePermission("list.manage", (r) => ({ studyId: studyIdOf(r) })) },
    async (request, reply) => {
      const parsed = listImportSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
      const user = request.user as AuthenticatedUser;
      try {
        await loadStudy(request.server.db, studyIdOf(request));
        const list = await withActor(
          request.server.db,
          { userId: user.id, label: user.username },
          (tx) =>
            importList(tx, {
              studyId: studyIdOf(request),
              filename: parsed.data.filename,
              csv: parsed.data.csv,
              createdBy: user.id,
            }),
        );
        return reply.code(201).send(list);
      } catch (err) {
        if (await replyDomainError(reply, err)) return;
        throw err;
      }
    },
  );

  app.get("/studies/:studyId/lists", { preHandler: requireMembership() }, async (request) => {
    // List metadata only — versions, status, checksums. No entry content.
    return request.server.db
      .select()
      .from(randomizationLists)
      .where(eq(randomizationLists.studyId, studyIdOf(request)))
      .orderBy(asc(randomizationLists.version));
  });

  /**
   * Activation is the GxP-significant act (P11-06): password step-up plus a
   * captured reason, both enforced here; the trigger-audited status change
   * carries them into the chain.
   */
  app.post(
    "/studies/:studyId/lists/:listId/activate",
    { preHandler: requirePermission("list.manage", (r) => ({ studyId: studyIdOf(r) })) },
    async (request, reply) => {
      const parsed = listActivateSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
      const user = request.user as AuthenticatedUser;
      const reauth = await request.server.authService.reauthenticate(user.id, parsed.data.password);
      if (!reauth.ok) {
        return reply.code(403).send({ error: `re-authentication failed: ${reauth.reason}` });
      }
      const { listId } = request.params as { listId: string };
      try {
        const list = await withActor(
          request.server.db,
          { userId: user.id, label: user.username },
          (tx) =>
            activateList(tx, {
              studyId: studyIdOf(request),
              listId,
              activatedBy: user.id,
              reason: parsed.data.reason,
            }),
        );
        return list;
      } catch (err) {
        if (await replyDomainError(reply, err)) return;
        throw err;
      }
    },
  );

  /**
   * The unblinded read (ADR-0003): entries with arms, plus who each entry was
   * assigned to. Requires list.read_unblinded and logs the exposure in the
   * same transaction as the read.
   */
  app.get(
    "/studies/:studyId/lists/:listId/entries",
    { preHandler: requirePermission("list.read_unblinded", (r) => ({ studyId: studyIdOf(r) })) },
    async (request, reply) => {
      const user = request.user as AuthenticatedUser;
      const { listId } = request.params as { listId: string };
      const db = request.server.db;
      const [list] = await db
        .select()
        .from(randomizationLists)
        .where(
          and(
            eq(randomizationLists.id, listId),
            eq(randomizationLists.studyId, studyIdOf(request)),
          ),
        )
        .limit(1);
      if (!list) return reply.code(404).send({ error: "list not found" });

      return withActor(db, { userId: user.id, label: user.username }, async (tx) => {
        await recordUnblindedAccess(tx, {
          studyId: studyIdOf(request),
          userId: user.id,
          context: "lists.entries",
          entityType: "randomization_list",
          entityId: listId,
        });
        const rows = await tx
          .select({
            seq: randomizationEntries.seq,
            arm: randomizationEntries.arm,
            stratum: randomizationEntries.stratum,
            subjectKey: assignments.subjectKey,
          })
          .from(randomizationEntries)
          .leftJoin(assignments, eq(assignments.entryId, randomizationEntries.id))
          .where(eq(randomizationEntries.listId, listId))
          .orderBy(asc(randomizationEntries.seq));
        return rows;
      });
    },
  );
};
