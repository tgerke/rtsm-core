import { createHash } from "node:crypto";
import { randomizationEntries, randomizationLists, randomizationMethods } from "@rtsm-core/db";
import { and, eq, max } from "drizzle-orm";
import type { Tx } from "./actor.js";
import { DomainError } from "./errors.js";

export interface ListRow {
  seq: number;
  arm: string;
  stratum: string;
}

/**
 * Parses the statistician's CSV (ADR-0001): header `seq,arm[,stratum]`, one
 * entry per line. Deliberately not a general CSV parser — fields must not
 * contain commas or quotes, which keeps the accepted format identical to the
 * documented one and leaves nothing to interpretation.
 */
export function parseListCsv(csv: string): ListRow[] {
  const lines = csv
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const header = lines.shift()?.toLowerCase();
  if (header !== "seq,arm" && header !== "seq,arm,stratum") {
    throw new DomainError('header must be "seq,arm" or "seq,arm,stratum"');
  }
  if (lines.length === 0) throw new DomainError("list has no entries");

  const seen = new Set<number>();
  return lines.map((line, i) => {
    const cols = line.split(",");
    const rowNum = i + 2; // 1-based, after the header
    if (cols.length < 2 || cols.length > 3) {
      throw new DomainError(`row ${rowNum}: expected 2 or 3 columns, got ${cols.length}`);
    }
    const seq = Number(cols[0]);
    if (!Number.isInteger(seq) || seq < 1) {
      throw new DomainError(`row ${rowNum}: seq must be a positive integer`);
    }
    if (seen.has(seq)) throw new DomainError(`row ${rowNum}: duplicate seq ${seq}`);
    seen.add(seq);
    const arm = (cols[1] ?? "").trim();
    if (!arm) throw new DomainError(`row ${rowNum}: arm must not be empty`);
    if (arm.length > 500) throw new DomainError(`row ${rowNum}: arm exceeds 500 characters`);
    return { seq, arm, stratum: (cols[2] ?? "").trim() };
  });
}

/**
 * Imports a list as the next draft version for the study. The file checksum
 * is the integrity anchor: entries are append-only once inserted, so the
 * stored content stays tied to exactly what the statistician generated.
 */
export async function importList(
  tx: Tx,
  input: { studyId: string; filename: string; csv: string; createdBy: string },
) {
  const rows = parseListCsv(input.csv);
  const sha256 = createHash("sha256").update(input.csv).digest("hex");

  const [prior] = await tx
    .select({ v: max(randomizationLists.version) })
    .from(randomizationLists)
    .where(eq(randomizationLists.studyId, input.studyId));
  const version = (prior?.v ?? 0) + 1;

  const [list] = await tx
    .insert(randomizationLists)
    .values({
      studyId: input.studyId,
      version,
      filename: input.filename,
      sha256,
      rowCount: rows.length,
      createdBy: input.createdBy,
    })
    .returning();
  if (!list) throw new Error("list insert returned no row");

  for (let i = 0; i < rows.length; i += 1000) {
    await tx.insert(randomizationEntries).values(
      rows.slice(i, i + 1000).map((r) => ({
        listId: list.id,
        seq: r.seq,
        arm: r.arm,
        stratum: r.stratum,
      })),
    );
  }
  return list;
}

/**
 * Activates a draft list, retiring any currently active one. The caller MUST
 * have already re-authenticated the actor's password (P11-06) — this function
 * only records the activation; the route owns the step-up.
 */
export async function activateList(
  tx: Tx,
  input: { studyId: string; listId: string; activatedBy: string; reason: string },
) {
  const [list] = await tx
    .select()
    .from(randomizationLists)
    .where(
      and(eq(randomizationLists.id, input.listId), eq(randomizationLists.studyId, input.studyId)),
    )
    .limit(1);
  if (!list) throw new DomainError("list not found", 404);
  if (list.status !== "draft") {
    throw new DomainError(`list is ${list.status}; only a draft can be activated`, 409);
  }

  // One active source (ADR-0008): activating a list retires whatever the
  // study ran on before — the prior list (uploaded or generated) and any
  // active method. The rtsm_one_active_source trigger backstops this.
  const now = new Date();
  await tx
    .update(randomizationLists)
    .set({ status: "retired", retiredAt: now })
    .where(
      and(eq(randomizationLists.studyId, input.studyId), eq(randomizationLists.status, "active")),
    );
  await tx
    .update(randomizationMethods)
    .set({ status: "retired", retiredAt: now })
    .where(
      and(
        eq(randomizationMethods.studyId, input.studyId),
        eq(randomizationMethods.status, "active"),
      ),
    );

  const [activated] = await tx
    .update(randomizationLists)
    .set({
      status: "active",
      activatedBy: input.activatedBy,
      activatedAt: new Date(),
      activationReason: input.reason,
    })
    .where(eq(randomizationLists.id, input.listId))
    .returning();
  if (!activated) throw new Error("list activation returned no row");
  return activated;
}
