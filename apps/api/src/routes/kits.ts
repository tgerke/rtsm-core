import { importKits, recordUnblindedAccess, withActor } from "@rtsm-core/core";
import { kits, kitTypes, sites } from "@rtsm-core/db";
import { kitImportSchema, kitTypeCreateSchema, kitUpdateSchema } from "@rtsm-core/schemas";
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

export const kitRoutes: FastifyPluginAsync = async (app) => {
  /**
   * Defines a kit type — one entry of the kit-to-arm map. The response never
   * echoes the arm; it re-enters circulation only through the unblinded
   * listing below (ADR-0003 pattern).
   */
  app.post(
    "/studies/:studyId/kit-types",
    { preHandler: requirePermission("kit.manage", (r) => ({ studyId: studyIdOf(r) })) },
    async (request, reply) => {
      const parsed = kitTypeCreateSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
      const user = request.user as AuthenticatedUser;
      try {
        await loadStudy(request.server.db, studyIdOf(request));
        const kitType = await withActor(
          request.server.db,
          { userId: user.id, label: user.username },
          async (tx) => {
            const [row] = await tx
              .insert(kitTypes)
              .values({
                studyId: studyIdOf(request),
                code: parsed.data.code,
                arm: parsed.data.arm,
                description: parsed.data.description ?? "",
              })
              .returning();
            if (!row) throw new Error("kit type insert returned no row");
            return row;
          },
        );
        return reply
          .code(201)
          .send({ id: kitType.id, code: kitType.code, description: kitType.description });
      } catch (err) {
        if (isUniqueViolation(err)) {
          return reply.code(409).send({ error: "kit type code already exists in this study" });
        }
        if (await replyDomainError(reply, err)) return;
        throw err;
      }
    },
  );

  /** The kit-to-arm map, arms included: unblinded read, logged. */
  app.get(
    "/studies/:studyId/kit-types",
    { preHandler: requirePermission("kit.read_unblinded", (r) => ({ studyId: studyIdOf(r) })) },
    async (request) => {
      const user = request.user as AuthenticatedUser;
      const studyId = studyIdOf(request);
      return withActor(request.server.db, { userId: user.id, label: user.username }, async (tx) => {
        await recordUnblindedAccess(tx, {
          studyId,
          userId: user.id,
          context: "kit_types.list",
          entityType: "kit_type",
        });
        return tx
          .select({
            id: kitTypes.id,
            code: kitTypes.code,
            arm: kitTypes.arm,
            description: kitTypes.description,
          })
          .from(kitTypes)
          .where(eq(kitTypes.studyId, studyId))
          .orderBy(asc(kitTypes.code));
      });
    },
  );

  /** Imports a kit shipment CSV, optionally shipped to one site. */
  app.post(
    "/studies/:studyId/kits",
    { preHandler: requirePermission("kit.manage", (r) => ({ studyId: studyIdOf(r) })) },
    async (request, reply) => {
      const parsed = kitImportSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
      const user = request.user as AuthenticatedUser;
      try {
        await loadStudy(request.server.db, studyIdOf(request));
        const result = await withActor(
          request.server.db,
          { userId: user.id, label: user.username },
          (tx) =>
            importKits(tx, {
              studyId: studyIdOf(request),
              csv: parsed.data.csv,
              ...(parsed.data.siteId !== undefined ? { siteId: parsed.data.siteId } : {}),
              createdBy: user.id,
            }),
        );
        return reply.code(201).send(result);
      } catch (err) {
        if (isUniqueViolation(err)) {
          return reply.code(409).send({ error: "a kit number in this shipment already exists" });
        }
        if (await replyDomainError(reply, err)) return;
        throw err;
      }
    },
  );

  /**
   * Blinded inventory: kit numbers, lots, expiry, status, site — and no kit
   * type identifier at all. With one kit type per arm, even the type code
   * would leak the allocation, so it simply is not in this serialization.
   */
  app.get("/studies/:studyId/kits", { preHandler: requireMembership() }, async (request) => {
    return request.server.db
      .select({
        id: kits.id,
        kitNumber: kits.kitNumber,
        lot: kits.lot,
        expiresOn: kits.expiresOn,
        status: kits.status,
        statusReason: kits.statusReason,
        siteCode: sites.code,
      })
      .from(kits)
      .leftJoin(sites, eq(sites.id, kits.siteId))
      .where(eq(kits.studyId, studyIdOf(request)))
      .orderBy(asc(kits.kitNumber));
  });

  /** Inventory with the kit-to-arm join: unblinded read, logged. */
  app.get(
    "/studies/:studyId/kits/unblinded",
    { preHandler: requirePermission("kit.read_unblinded", (r) => ({ studyId: studyIdOf(r) })) },
    async (request) => {
      const user = request.user as AuthenticatedUser;
      const studyId = studyIdOf(request);
      return withActor(request.server.db, { userId: user.id, label: user.username }, async (tx) => {
        await recordUnblindedAccess(tx, {
          studyId,
          userId: user.id,
          context: "kits.list_unblinded",
          entityType: "kit",
        });
        return tx
          .select({
            id: kits.id,
            kitNumber: kits.kitNumber,
            kitTypeCode: kitTypes.code,
            arm: kitTypes.arm,
            lot: kits.lot,
            expiresOn: kits.expiresOn,
            status: kits.status,
            statusReason: kits.statusReason,
            siteCode: sites.code,
          })
          .from(kits)
          .innerJoin(kitTypes, eq(kitTypes.id, kits.kitTypeId))
          .leftJoin(sites, eq(sites.id, kits.siteId))
          .where(eq(kits.studyId, studyId))
          .orderBy(asc(kits.kitNumber));
      });
    },
  );

  /**
   * Pharmacist inventory act: site transfer and/or status change, reason
   * required. Dispensed kits are immutable here — dispensing (and any future
   * return flow) owns that state.
   */
  app.put(
    "/studies/:studyId/kits/:kitId",
    { preHandler: requirePermission("kit.manage", (r) => ({ studyId: studyIdOf(r) })) },
    async (request, reply) => {
      const parsed = kitUpdateSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
      if (parsed.data.status === undefined && parsed.data.siteId === undefined) {
        return reply.code(400).send({ error: "nothing to change: provide status and/or siteId" });
      }
      const user = request.user as AuthenticatedUser;
      const { kitId } = request.params as { kitId: string };
      const db = request.server.db;
      const studyId = studyIdOf(request);

      const [kit] = await db
        .select()
        .from(kits)
        .where(and(eq(kits.id, kitId), eq(kits.studyId, studyId)))
        .limit(1);
      if (!kit) return reply.code(404).send({ error: "kit not found" });
      if (kit.status === "dispensed") {
        return reply.code(409).send({ error: "kit is dispensed and can no longer be changed" });
      }
      if (parsed.data.siteId) {
        const [site] = await db
          .select({ id: sites.id })
          .from(sites)
          .where(and(eq(sites.id, parsed.data.siteId), eq(sites.studyId, studyId)))
          .limit(1);
        if (!site) return reply.code(404).send({ error: "site not found in this study" });
      }

      const updated = await withActor(db, { userId: user.id, label: user.username }, async (tx) => {
        const [row] = await tx
          .update(kits)
          .set({
            ...(parsed.data.status !== undefined ? { status: parsed.data.status } : {}),
            ...(parsed.data.siteId !== undefined ? { siteId: parsed.data.siteId } : {}),
            statusReason: parsed.data.reason,
            updatedAt: new Date(),
          })
          .where(eq(kits.id, kitId))
          .returning();
        if (!row) throw new Error("kit update returned no row");
        return row;
      });
      return {
        id: updated.id,
        kitNumber: updated.kitNumber,
        status: updated.status,
        statusReason: updated.statusReason,
        siteId: updated.siteId,
      };
    },
  );
};
