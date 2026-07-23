import { unblindedAccess } from "@rtsm-core/db";
import type { Tx } from "./actor.js";

/** Placeholder blinded viewers see wherever an arm (or strata) would appear. */
export const MASKED = "[masked]";

/**
 * Masks the blinded fields of a stored delivery payload (ADR-0003), mirroring
 * edc-core's rtsm_events listing: everything about the transfer is visible —
 * subject, timing, outcome — except what was assigned.
 */
export function maskDeliveryPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const masked = { ...payload, arm: MASKED };
  if ("strata" in masked && masked.strata != null) masked.strata = MASKED;
  return masked;
}

/**
 * Records an arm exposure in the append-only unblinded-access log (ADR-0003).
 * Must be called inside the same withActor transaction that reads the
 * unblinded data — the audit trigger chains the row, and a read without a
 * log row is a blinding-control failure, not an optimization.
 */
export async function recordUnblindedAccess(
  tx: Tx,
  input: {
    studyId: string;
    userId: string;
    context: string;
    entityType: string;
    entityId?: string;
  },
): Promise<void> {
  await tx.insert(unblindedAccess).values({
    studyId: input.studyId,
    userId: input.userId,
    context: input.context,
    entityType: input.entityType,
    entityId: input.entityId ?? null,
  });
}
