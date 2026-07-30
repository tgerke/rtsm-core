import { assignments, codeBreaks, randomizationEntries } from "@rtsm-core/db";
import { and, eq } from "drizzle-orm";
import type { Tx } from "./actor.js";
import { DomainError } from "./errors.js";
import { recordUnblindedAccess } from "./masking.js";

/**
 * Emergency code-break (ADR-0007): returns one subject's arm to an authorized
 * caller. The code_break row carries no arm — the exposure is the
 * unblinded_access row written here in the same transaction. Must run inside
 * withActor; the route owns the permission check (the site rule binds to the
 * assignment's site) and the password step-up.
 */
export async function breakCode(
  tx: Tx,
  input: { studyId: string; subjectKey: string; reason: string; performedBy: string },
) {
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

  const [event] = await tx
    .insert(codeBreaks)
    .values({
      studyId: input.studyId,
      assignmentId: assignment.id,
      reason: input.reason,
      createdBy: input.performedBy,
    })
    .returning({ id: codeBreaks.id, createdAt: codeBreaks.createdAt });
  if (!event) throw new Error("code break insert returned no row");

  await recordUnblindedAccess(tx, {
    studyId: input.studyId,
    userId: input.performedBy,
    context: "codebreak",
    entityType: "assignment",
    entityId: assignment.id,
  });

  return {
    codeBreakId: event.id,
    subjectKey: input.subjectKey,
    arm: entry.arm,
    createdAt: event.createdAt,
  };
}
