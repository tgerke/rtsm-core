import { maskDeliveryPayload, recordUnblindedAccess, withActor } from "@rtsm-core/core";
import { deliveryEvents } from "@rtsm-core/db";
import { desc, eq } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { hasPermission } from "../auth/rbac.js";
import type { AuthenticatedUser } from "../auth/service.js";
import { requireMembership, studyIdOf } from "./helpers.js";

export const deliveryRoutes: FastifyPluginAsync = async (app) => {
  /**
   * The transfer log (E6(R3) §4.2.5), reconcilable against edc-core's
   * rtsm_events. Members see everything about each transfer except the arm;
   * list.read_unblinded holders see the full payload, and that exposure is
   * logged (ADR-0003) — mirroring how edc-core masks its events listing.
   */
  app.get("/studies/:studyId/deliveries", { preHandler: requireMembership() }, async (request) => {
    const user = request.user as AuthenticatedUser;
    const db = request.server.db;
    const studyId = studyIdOf(request);
    const rows = await db
      .select()
      .from(deliveryEvents)
      .where(eq(deliveryEvents.studyId, studyId))
      .orderBy(desc(deliveryEvents.createdAt))
      .limit(200);

    const unblinded = await hasPermission(db, user.id, "list.read_unblinded", { studyId });
    if (!unblinded) {
      return rows.map((row) => ({
        ...row,
        payload: maskDeliveryPayload(row.payload as Record<string, unknown>),
      }));
    }
    return withActor(db, { userId: user.id, label: user.username }, async (tx) => {
      await recordUnblindedAccess(tx, {
        studyId,
        userId: user.id,
        context: "deliveries.list",
        entityType: "delivery_event",
      });
      return rows;
    });
  });
};
