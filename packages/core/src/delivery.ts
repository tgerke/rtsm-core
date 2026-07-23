import { assignments, type Db, deliveryEvents, randomizationEntries, studies } from "@rtsm-core/db";
import type { EdcAssignmentPayload } from "@rtsm-core/schemas";
import { eq } from "drizzle-orm";
import { type Actor, withActor } from "./actor.js";
import { DomainError } from "./errors.js";

/** Intake status mapping (edc-core ADR-0010). */
export type DeliveryOutcome = "applied" | "duplicate" | "conflict" | "rejected" | "error";

export function outcomeFromStatus(status: number): DeliveryOutcome {
  switch (status) {
    case 201:
      return "applied";
    case 200:
      return "duplicate";
    case 409:
      return "conflict";
    case 422:
      return "rejected";
    default:
      return "error";
  }
}

export interface DeliveryResult {
  outcome: DeliveryOutcome;
  httpStatus: number | null;
  reason: string | null;
  edcEventId: string | null;
}

/**
 * Posts an assignment to the EDC's ADR-0010 intake and appends the
 * delivery_event transfer-log row (E6(R3) §4.2.5). Safe to call again for the
 * same assignment: the intake is idempotent, an identical replay comes back
 * as `duplicate` (200), and every attempt — including failures — is logged.
 *
 * The arm travels only here: from the entry row into the request body, over
 * TLS, to a blinded EDC item. The intake response never echoes it.
 */
export async function deliverAssignment(
  db: Db,
  assignmentId: string,
  actor: Actor,
  fetchImpl: typeof fetch = fetch,
): Promise<DeliveryResult> {
  const [row] = await db
    .select({ assignment: assignments, entry: randomizationEntries, study: studies })
    .from(assignments)
    .innerJoin(randomizationEntries, eq(assignments.entryId, randomizationEntries.id))
    .innerJoin(studies, eq(assignments.studyId, studies.id))
    .where(eq(assignments.id, assignmentId))
    .limit(1);
  if (!row) throw new DomainError("assignment not found", 404);
  if (!row.study.enabled) throw new DomainError("study is disabled", 409);

  const payload: EdcAssignmentPayload = {
    subjectKey: row.assignment.subjectKey,
    arm: row.entry.arm,
    randomizationId: row.assignment.randomizationId,
    assignedAt: row.assignment.createdAt.toISOString(),
    ...(row.assignment.strata ? { strata: row.assignment.strata as Record<string, string> } : {}),
    source: "rtsm-core",
  };

  const url = `${row.study.edcBaseUrl.replace(/\/$/, "")}/studies/${encodeURIComponent(
    row.study.edcStudyId,
  )}/rtsm/assignments`;

  let httpStatus: number | null = null;
  let outcome: DeliveryOutcome = "error";
  let reason: string | null = null;
  let edcEventId: string | null = null;
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${row.study.edcApiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    httpStatus = response.status;
    outcome = outcomeFromStatus(response.status);
    try {
      const body = (await response.json()) as { reason?: string; eventId?: string };
      reason = body.reason ?? null;
      edcEventId = body.eventId ?? null;
    } catch {
      reason = outcome === "error" ? `unexpected response (HTTP ${response.status})` : null;
    }
  } catch (err) {
    reason = err instanceof Error ? err.message : "delivery request failed";
  }

  await withActor(db, actor, async (tx) => {
    await tx.insert(deliveryEvents).values({
      assignmentId,
      studyId: row.assignment.studyId,
      payload,
      outcome,
      httpStatus,
      edcEventId,
      reason,
      createdBy: actor.userId ?? row.assignment.createdBy,
    });
  });

  return { outcome, httpStatus, reason, edcEventId };
}
