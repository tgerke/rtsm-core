import { resupplyRequests, resupplySchemes } from "@rtsm-core/db";
import { and, eq, sql } from "drizzle-orm";
import type { Tx } from "./actor.js";

/**
 * Re-evaluates one site/kit-type pair against its resupply scheme, called
 * inside any transaction that reduces the site's available count (dispense,
 * damage, quarantine, receipt shortfall — ADR-0009). Counts available at the
 * site plus in-transit to the site so stock already on the truck is not
 * requested twice. At or below the trigger, opens one request proposing
 * target minus counted; the partial unique index makes "one open request per
 * scheme" a database fact, so a concurrent duplicate resolves to a no-op.
 */
export async function evaluateResupply(
  tx: Tx,
  input: { studyId: string; siteId: string; kitTypeId: string },
): Promise<void> {
  const [scheme] = await tx
    .select({
      triggerLevel: resupplySchemes.triggerLevel,
      targetLevel: resupplySchemes.targetLevel,
    })
    .from(resupplySchemes)
    .where(
      and(
        eq(resupplySchemes.studyId, input.studyId),
        eq(resupplySchemes.siteId, input.siteId),
        eq(resupplySchemes.kitTypeId, input.kitTypeId),
      ),
    )
    .limit(1);
  if (!scheme) return;

  const counted = await tx.execute(sql`
    SELECT count(*)::int AS stock FROM (
      SELECT k.id FROM kit k
      WHERE k.study_id = ${input.studyId}
        AND k.site_id = ${input.siteId}
        AND k.kit_type_id = ${input.kitTypeId}
        AND k.status = 'available'
        AND k.expires_on >= CURRENT_DATE
      UNION ALL
      SELECT k.id FROM kit k
      JOIN shipment_kit sk ON sk.kit_id = k.id
      JOIN shipment s ON s.id = sk.shipment_id
      WHERE k.study_id = ${input.studyId}
        AND s.site_id = ${input.siteId}
        AND k.kit_type_id = ${input.kitTypeId}
        AND k.status = 'in_transit'
    ) stock`);
  const stock = (counted as unknown as Array<{ stock: number }>)[0]?.stock ?? 0;
  if (stock > scheme.triggerLevel) return;

  await tx
    .insert(resupplyRequests)
    .values({
      studyId: input.studyId,
      siteId: input.siteId,
      kitTypeId: input.kitTypeId,
      quantity: scheme.targetLevel - stock,
    })
    .onConflictDoNothing();
}
