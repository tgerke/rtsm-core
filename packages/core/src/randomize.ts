import { assignments, randomizationLists, sites } from "@rtsm-core/db";
import { and, eq, sql } from "drizzle-orm";
import type { Tx } from "./actor.js";
import { DomainError } from "./errors.js";

/**
 * Allocates the next unused entry in the subject's stratum and records the
 * assignment. Concurrency-safe: the entry row is taken with
 * FOR UPDATE SKIP LOCKED, so two simultaneous randomizations get distinct
 * entries, and the schema backstops the logic (entry_id UNIQUE, one
 * assignment per (study, subject)). Must run inside withActor.
 *
 * Returns the assignment only — never the arm. The arm leaves this system
 * exclusively through the delivery client (to the EDC's blinded item) and
 * the unblinded read path (ADR-0003).
 */
export async function randomizeSubject(
  tx: Tx,
  input: {
    studyId: string;
    subjectKey: string;
    stratum?: string;
    strata?: Record<string, string>;
    siteId?: string;
    createdBy: string;
  },
) {
  const stratum = input.stratum ?? "";

  if (input.siteId) {
    const [site] = await tx
      .select({ status: sites.status })
      .from(sites)
      .where(and(eq(sites.id, input.siteId), eq(sites.studyId, input.studyId)))
      .limit(1);
    if (!site) throw new DomainError("site not found in this study", 404);
    if (site.status !== "active") throw new DomainError("site is closed", 409);
  }

  const [active] = await tx
    .select()
    .from(randomizationLists)
    .where(
      and(eq(randomizationLists.studyId, input.studyId), eq(randomizationLists.status, "active")),
    )
    .limit(1);
  if (!active) throw new DomainError("study has no active randomization list", 409);

  const [existing] = await tx
    .select({ id: assignments.id })
    .from(assignments)
    .where(
      and(eq(assignments.studyId, input.studyId), eq(assignments.subjectKey, input.subjectKey)),
    )
    .limit(1);
  if (existing) throw new DomainError("subject is already randomized", 409);

  const locked = await tx.execute(sql`
    SELECT e.id FROM randomization_entry e
    WHERE e.list_id = ${active.id}
      AND e.stratum = ${stratum}
      AND NOT EXISTS (SELECT 1 FROM assignment a WHERE a.entry_id = e.id)
    ORDER BY e.seq
    LIMIT 1
    FOR UPDATE OF e SKIP LOCKED`);
  const entryId = (locked as unknown as Array<{ id: string }>)[0]?.id;
  if (!entryId) {
    throw new DomainError(
      stratum
        ? `randomization list is exhausted for stratum "${stratum}"`
        : "randomization list is exhausted",
      409,
    );
  }

  const [assignment] = await tx
    .insert(assignments)
    .values({
      studyId: input.studyId,
      entryId,
      subjectKey: input.subjectKey,
      siteId: input.siteId ?? null,
      strata: input.strata ?? (stratum ? { stratum } : null),
      createdBy: input.createdBy,
    })
    .returning();
  if (!assignment) throw new Error("assignment insert returned no row");
  return assignment;
}
