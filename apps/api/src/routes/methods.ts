import {
  activateMethod,
  createMethodDraft,
  recordUnblindedAccess,
  withActor,
} from "@rtsm-core/core";
import { randomizationDraws, randomizationMethods } from "@rtsm-core/db";
import { methodActivateSchema, methodCreateSchema } from "@rtsm-core/schemas";
import { and, asc, eq } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { requirePermission } from "../auth/plugin.js";
import type { AuthenticatedUser } from "../auth/service.js";
import { loadStudy, replyDomainError, requireMembership, studyIdOf } from "./helpers.js";

/**
 * The blinded method serialization (ADR-0008): no seed — seed + config +
 * assignment order reconstructs every arm — and no config.arms, matching
 * the kit precedent that blinded surfaces carry no arm identifiers at all.
 * Factors, weights, and p stay visible: coordinators need the covariate
 * shape to randomize, and none of it maps a subject to an arm. The full
 * config travels only on the unblinded read below.
 */
function blindedMethod<T extends { seed: string; config: unknown }>(method: T): Omit<T, "seed"> {
  const { seed: _seed, config, ...safe } = method;
  const { arms: _arms, ...blindedConfig } = config as Record<string, unknown>;
  return { ...safe, config: blindedConfig } as Omit<T, "seed">;
}

export const methodRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    "/studies/:studyId/methods",
    { preHandler: requirePermission("list.manage", (r) => ({ studyId: studyIdOf(r) })) },
    async (request, reply) => {
      const parsed = methodCreateSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
      const user = request.user as AuthenticatedUser;
      try {
        await loadStudy(request.server.db, studyIdOf(request));
        const method = await withActor(
          request.server.db,
          { userId: user.id, label: user.username },
          (tx) =>
            createMethodDraft(tx, {
              studyId: studyIdOf(request),
              config: parsed.data.config,
              ...(parsed.data.seed !== undefined ? { seed: parsed.data.seed } : {}),
              createdBy: user.id,
            }),
        );
        return reply.code(201).send(blindedMethod(method));
      } catch (err) {
        if (await replyDomainError(reply, err)) return;
        throw err;
      }
    },
  );

  app.get("/studies/:studyId/methods", { preHandler: requireMembership() }, async (request) => {
    // Method metadata and the blinded config — versions, status, checksums,
    // factors. Arms and seed never appear here.
    const rows = await request.server.db
      .select()
      .from(randomizationMethods)
      .where(eq(randomizationMethods.studyId, studyIdOf(request)))
      .orderBy(asc(randomizationMethods.version));
    return rows.map(blindedMethod);
  });

  /**
   * Method activation is the same GxP-significant act as list activation
   * (P11-06): password step-up plus a captured reason. It also switches the
   * study's randomization source — the outgoing list or method retires in
   * the same transaction (ADR-0008: one active source).
   */
  app.post(
    "/studies/:studyId/methods/:methodId/activate",
    { preHandler: requirePermission("list.manage", (r) => ({ studyId: studyIdOf(r) })) },
    async (request, reply) => {
      const parsed = methodActivateSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
      const user = request.user as AuthenticatedUser;
      const reauth = await request.server.authService.reauthenticate(user.id, parsed.data.password);
      if (!reauth.ok) {
        return reply.code(403).send({ error: `re-authentication failed: ${reauth.reason}` });
      }
      const { methodId } = request.params as { methodId: string };
      try {
        const method = await withActor(
          request.server.db,
          { userId: user.id, label: user.username },
          (tx) =>
            activateMethod(tx, {
              studyId: studyIdOf(request),
              methodId,
              activatedBy: user.id,
              reason: parsed.data.reason,
            }),
        );
        return blindedMethod(method);
      } catch (err) {
        if (await replyDomainError(reply, err)) return;
        throw err;
      }
    },
  );

  /**
   * The unblinded read (ADR-0008 decisions 7–8): the seed and the draw
   * records — scores, probabilities, counts snapshots, chosen arms —
   * behind list.read_unblinded, with the exposure logged in the same
   * transaction as the read. Everything an inspector needs to replay every
   * assignment (EMA A5.2.4).
   */
  app.get(
    "/studies/:studyId/methods/:methodId/unblinded",
    { preHandler: requirePermission("list.read_unblinded", (r) => ({ studyId: studyIdOf(r) })) },
    async (request, reply) => {
      const user = request.user as AuthenticatedUser;
      const { methodId } = request.params as { methodId: string };
      const db = request.server.db;
      const [method] = await db
        .select()
        .from(randomizationMethods)
        .where(
          and(
            eq(randomizationMethods.id, methodId),
            eq(randomizationMethods.studyId, studyIdOf(request)),
          ),
        )
        .limit(1);
      if (!method) return reply.code(404).send({ error: "method not found" });

      return withActor(db, { userId: user.id, label: user.username }, async (tx) => {
        await recordUnblindedAccess(tx, {
          studyId: studyIdOf(request),
          userId: user.id,
          context: "methods.unblinded",
          entityType: "randomization_method",
          entityId: methodId,
        });
        const draws = await tx
          .select()
          .from(randomizationDraws)
          .where(eq(randomizationDraws.methodId, methodId))
          .orderBy(asc(randomizationDraws.drawIndex));
        return { ...method, draws };
      });
    },
  );
};
