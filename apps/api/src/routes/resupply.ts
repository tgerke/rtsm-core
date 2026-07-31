import { DomainError, withActor } from "@rtsm-core/core";
import { kitTypes, resupplyRequests, resupplySchemes, sites } from "@rtsm-core/db";
import { resupplyDismissSchema, resupplySchemeSchema } from "@rtsm-core/schemas";
import { and, asc, desc, eq } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { requirePermission } from "../auth/plugin.js";
import type { AuthenticatedUser } from "../auth/service.js";
import { replyDomainError, studyIdOf } from "./helpers.js";

// Every surface here names kit types, so everything is kit.manage-only
// (ADR-0009 blinding classes): schemes and requests cannot exist without
// saying which type is low, and with one type per arm the code is the
// allocation.
export const resupplyRoutes: FastifyPluginAsync = async (app) => {
  /** Upsert the scheme for one site and kit type. */
  app.put(
    "/studies/:studyId/resupply-schemes",
    { preHandler: requirePermission("kit.manage", (r) => ({ studyId: studyIdOf(r) })) },
    async (request, reply) => {
      const parsed = resupplySchemeSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
      const user = request.user as AuthenticatedUser;
      const studyId = studyIdOf(request);
      try {
        const scheme = await withActor(
          request.server.db,
          { userId: user.id, label: user.username },
          async (tx) => {
            const [site] = await tx
              .select({ id: sites.id })
              .from(sites)
              .where(and(eq(sites.id, parsed.data.siteId), eq(sites.studyId, studyId)))
              .limit(1);
            if (!site) throw new DomainError("site not found in this study", 404);
            const [kitType] = await tx
              .select({ id: kitTypes.id })
              .from(kitTypes)
              .where(and(eq(kitTypes.code, parsed.data.kitTypeCode), eq(kitTypes.studyId, studyId)))
              .limit(1);
            if (!kitType) throw new DomainError("kit type not found in this study", 404);
            const [row] = await tx
              .insert(resupplySchemes)
              .values({
                studyId,
                siteId: site.id,
                kitTypeId: kitType.id,
                triggerLevel: parsed.data.triggerLevel,
                targetLevel: parsed.data.targetLevel,
              })
              .onConflictDoUpdate({
                target: [
                  resupplySchemes.studyId,
                  resupplySchemes.siteId,
                  resupplySchemes.kitTypeId,
                ],
                set: {
                  triggerLevel: parsed.data.triggerLevel,
                  targetLevel: parsed.data.targetLevel,
                  updatedAt: new Date(),
                },
              })
              .returning();
            if (!row) throw new Error("resupply scheme upsert returned no row");
            return row;
          },
        );
        return {
          id: scheme.id,
          siteId: scheme.siteId,
          kitTypeCode: parsed.data.kitTypeCode,
          triggerLevel: scheme.triggerLevel,
          targetLevel: scheme.targetLevel,
        };
      } catch (err) {
        if (await replyDomainError(reply, err)) return;
        throw err;
      }
    },
  );

  app.get(
    "/studies/:studyId/resupply-schemes",
    { preHandler: requirePermission("kit.manage", (r) => ({ studyId: studyIdOf(r) })) },
    async (request) => {
      return request.server.db
        .select({
          id: resupplySchemes.id,
          siteCode: sites.code,
          kitTypeCode: kitTypes.code,
          triggerLevel: resupplySchemes.triggerLevel,
          targetLevel: resupplySchemes.targetLevel,
        })
        .from(resupplySchemes)
        .innerJoin(sites, eq(sites.id, resupplySchemes.siteId))
        .innerJoin(kitTypes, eq(kitTypes.id, resupplySchemes.kitTypeId))
        .where(eq(resupplySchemes.studyId, studyIdOf(request)))
        .orderBy(asc(sites.code), asc(kitTypes.code));
    },
  );

  /** Open first, then the answered ones, newest first. */
  app.get(
    "/studies/:studyId/resupply-requests",
    { preHandler: requirePermission("kit.manage", (r) => ({ studyId: studyIdOf(r) })) },
    async (request) => {
      return request.server.db
        .select({
          id: resupplyRequests.id,
          siteCode: sites.code,
          kitTypeCode: kitTypes.code,
          quantity: resupplyRequests.quantity,
          status: resupplyRequests.status,
          shipmentId: resupplyRequests.shipmentId,
          createdAt: resupplyRequests.createdAt,
        })
        .from(resupplyRequests)
        .innerJoin(sites, eq(sites.id, resupplyRequests.siteId))
        .innerJoin(kitTypes, eq(kitTypes.id, resupplyRequests.kitTypeId))
        .where(eq(resupplyRequests.studyId, studyIdOf(request)))
        .orderBy(asc(resupplyRequests.status), desc(resupplyRequests.createdAt));
    },
  );

  /** The pharmacist's "no": closes the request with the reason on the row. */
  app.post(
    "/studies/:studyId/resupply-requests/:requestId/dismiss",
    { preHandler: requirePermission("kit.manage", (r) => ({ studyId: studyIdOf(r) })) },
    async (request, reply) => {
      const parsed = resupplyDismissSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
      const user = request.user as AuthenticatedUser;
      const { requestId } = request.params as { requestId: string };
      const row = await withActor(
        request.server.db,
        { userId: user.id, label: user.username },
        async (tx) => {
          const [updated] = await tx
            .update(resupplyRequests)
            .set({ status: "dismissed", dismissReason: parsed.data.reason, updatedAt: new Date() })
            .where(
              and(
                eq(resupplyRequests.id, requestId),
                eq(resupplyRequests.studyId, studyIdOf(request)),
                eq(resupplyRequests.status, "open"),
              ),
            )
            .returning();
          return updated ?? null;
        },
      );
      if (!row) return reply.code(404).send({ error: "no open request with this id" });
      return { id: row.id, status: row.status, dismissReason: row.dismissReason };
    },
  );
};
