import { createShipment, receiveShipment, withActor } from "@rtsm-core/core";
import { depots, kits, shipmentKits, shipments, sites } from "@rtsm-core/db";
import { shipmentCreateSchema, shipmentReceiveSchema } from "@rtsm-core/schemas";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { requirePermission } from "../auth/plugin.js";
import { hasPermission } from "../auth/rbac.js";
import type { AuthenticatedUser } from "../auth/service.js";
import { replyDomainError, requireMembership, studyIdOf } from "./helpers.js";

export const shipmentRoutes: FastifyPluginAsync = async (app) => {
  /**
   * Create-and-dispatch (ADR-0009): quantities by type in, concrete FEFO
   * kits out. The response names kit types — this surface is kit.manage
   * territory (type-code-bearing blinding class), like the request payload
   * that asked for them.
   */
  app.post(
    "/studies/:studyId/shipments",
    { preHandler: requirePermission("kit.manage", (r) => ({ studyId: studyIdOf(r) })) },
    async (request, reply) => {
      const parsed = shipmentCreateSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
      const user = request.user as AuthenticatedUser;
      try {
        const result = await withActor(
          request.server.db,
          { userId: user.id, label: user.username },
          (tx) =>
            createShipment(tx, {
              studyId: studyIdOf(request),
              depotId: parsed.data.depotId,
              siteId: parsed.data.siteId,
              items: parsed.data.items,
              minShelfLifeDays: parsed.data.minShelfLifeDays ?? 0,
              createdBy: user.id,
            }),
        );
        return reply.code(201).send(result);
      } catch (err) {
        if (await replyDomainError(reply, err)) return;
        throw err;
      }
    },
  );

  /** Blinded shipment list: origin, destination, status, size — no types. */
  app.get("/studies/:studyId/shipments", { preHandler: requireMembership() }, async (request) => {
    return request.server.db
      .select({
        id: shipments.id,
        depotCode: depots.code,
        siteCode: sites.code,
        status: shipments.status,
        kitCount: sql<number>`count(${shipmentKits.kitId})::int`,
        createdAt: shipments.createdAt,
        receivedAt: shipments.receivedAt,
      })
      .from(shipments)
      .innerJoin(depots, eq(depots.id, shipments.depotId))
      .innerJoin(sites, eq(sites.id, shipments.siteId))
      .leftJoin(shipmentKits, eq(shipmentKits.shipmentId, shipments.id))
      .where(eq(shipments.studyId, studyIdOf(request)))
      .groupBy(shipments.id, depots.code, sites.code)
      .orderBy(desc(shipments.createdAt));
  });

  /**
   * Blinded shipment manifest: the receiving surface. Kit numbers, lots,
   * expiry, dispositions — and no kit-type identifier at all (ADR-0006 rule,
   * unchanged by ADR-0009).
   */
  app.get(
    "/studies/:studyId/shipments/:shipmentId",
    { preHandler: requireMembership() },
    async (request, reply) => {
      const { shipmentId } = request.params as { shipmentId: string };
      const studyId = studyIdOf(request);
      const [shipment] = await request.server.db
        .select({
          id: shipments.id,
          depotCode: depots.code,
          siteCode: sites.code,
          status: shipments.status,
          minShelfLifeDays: shipments.minShelfLifeDays,
          createdAt: shipments.createdAt,
          receivedAt: shipments.receivedAt,
        })
        .from(shipments)
        .innerJoin(depots, eq(depots.id, shipments.depotId))
        .innerJoin(sites, eq(sites.id, shipments.siteId))
        .where(and(eq(shipments.id, shipmentId), eq(shipments.studyId, studyId)))
        .limit(1);
      if (!shipment) return reply.code(404).send({ error: "shipment not found" });
      const manifest = await request.server.db
        .select({
          kitNumber: kits.kitNumber,
          lot: kits.lot,
          expiresOn: kits.expiresOn,
          disposition: shipmentKits.disposition,
          dispositionReason: shipmentKits.dispositionReason,
        })
        .from(shipmentKits)
        .innerJoin(kits, eq(kits.id, shipmentKits.kitId))
        .where(eq(shipmentKits.shipmentId, shipmentId))
        .orderBy(asc(kits.kitNumber));
      return { ...shipment, kits: manifest };
    },
  );

  /**
   * The blinded receiving act. The permission check runs in the handler, not
   * a preHandler, because the site binding comes from the shipment row: a
   * site-scoped shipment.receive grant reaches only shipments addressed to
   * that site (the codebreak pattern).
   */
  app.post(
    "/studies/:studyId/shipments/:shipmentId/receive",
    { preHandler: requireMembership() },
    async (request, reply) => {
      const parsed = shipmentReceiveSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
      const user = request.user as AuthenticatedUser;
      const { shipmentId } = request.params as { shipmentId: string };
      const studyId = studyIdOf(request);

      const [shipment] = await request.server.db
        .select({ siteId: shipments.siteId })
        .from(shipments)
        .where(and(eq(shipments.id, shipmentId), eq(shipments.studyId, studyId)))
        .limit(1);
      if (!shipment) return reply.code(404).send({ error: "shipment not found" });
      const allowed = await hasPermission(request.server.db, user.id, "shipment.receive", {
        studyId,
        siteId: shipment.siteId,
      });
      if (!allowed) {
        return reply.code(403).send({ error: "missing permission: shipment.receive" });
      }
      try {
        const result = await withActor(
          request.server.db,
          { userId: user.id, label: user.username },
          (tx) =>
            receiveShipment(tx, {
              studyId,
              shipmentId,
              dispositions: parsed.data.dispositions,
              receivedBy: user.id,
            }),
        );
        return result;
      } catch (err) {
        if (await replyDomainError(reply, err)) return;
        throw err;
      }
    },
  );
};
