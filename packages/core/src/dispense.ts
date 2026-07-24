import { assignments, dispenseEvents, kits, randomizationEntries, sites } from "@rtsm-core/db";
import { and, eq, sql } from "drizzle-orm";
import type { Tx } from "./actor.js";
import { DomainError } from "./errors.js";

/**
 * Dispenses a kit to a randomized subject at a site. The blinding-preserving
 * move of the whole supply model: the subject's arm and the kit-to-arm map
 * meet only inside this transaction, and what comes back is a kit number.
 *
 * Selection is the earliest-expiring available, unexpired kit at the site
 * whose type maps to the subject's arm (FEFO), taken with FOR UPDATE SKIP
 * LOCKED so concurrent dispenses get distinct kits. Repeatable by design —
 * each visit's dispense appends its own event. Must run inside withActor.
 */
export async function dispenseKit(
  tx: Tx,
  input: { studyId: string; subjectKey: string; siteId: string; dispensedBy: string },
) {
  const [site] = await tx
    .select({ status: sites.status })
    .from(sites)
    .where(and(eq(sites.id, input.siteId), eq(sites.studyId, input.studyId)))
    .limit(1);
  if (!site) throw new DomainError("site not found in this study", 404);
  if (site.status !== "active") throw new DomainError("site is closed", 409);

  const [assignment] = await tx
    .select({ id: assignments.id, entryId: assignments.entryId })
    .from(assignments)
    .where(
      and(eq(assignments.studyId, input.studyId), eq(assignments.subjectKey, input.subjectKey)),
    )
    .limit(1);
  if (!assignment) throw new DomainError("subject is not randomized", 409);

  const [entry] = await tx
    .select({ arm: randomizationEntries.arm })
    .from(randomizationEntries)
    .where(eq(randomizationEntries.id, assignment.entryId))
    .limit(1);
  if (!entry) throw new Error("assignment entry missing");

  const locked = await tx.execute(sql`
    SELECT k.id FROM kit k
    JOIN kit_type t ON t.id = k.kit_type_id
    WHERE k.study_id = ${input.studyId}
      AND k.site_id = ${input.siteId}
      AND k.status = 'available'
      AND k.expires_on >= CURRENT_DATE
      AND t.arm = ${entry.arm}
    ORDER BY k.expires_on, k.kit_number
    LIMIT 1
    FOR UPDATE OF k SKIP LOCKED`);
  const kitId = (locked as unknown as Array<{ id: string }>)[0]?.id;
  if (!kitId) {
    throw new DomainError("no suitable kit is available for this subject at this site", 409);
  }

  const [kit] = await tx
    .update(kits)
    .set({ status: "dispensed", updatedAt: new Date() })
    .where(eq(kits.id, kitId))
    .returning({ kitNumber: kits.kitNumber, lot: kits.lot, expiresOn: kits.expiresOn });
  if (!kit) throw new Error("kit update returned no row");

  const [event] = await tx
    .insert(dispenseEvents)
    .values({
      studyId: input.studyId,
      assignmentId: assignment.id,
      kitId,
      siteId: input.siteId,
      createdBy: input.dispensedBy,
    })
    .returning({ id: dispenseEvents.id, createdAt: dispenseEvents.createdAt });
  if (!event) throw new Error("dispense event insert returned no row");

  // Blinded by construction: nothing here can express an arm or a kit type.
  return {
    dispenseEventId: event.id,
    kitNumber: kit.kitNumber,
    lot: kit.lot,
    expiresOn: kit.expiresOn,
    dispensedAt: event.createdAt,
  };
}
