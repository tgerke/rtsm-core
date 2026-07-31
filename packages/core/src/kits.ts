import { depots, kits, kitTypes } from "@rtsm-core/db";
import { and, eq } from "drizzle-orm";
import type { Tx } from "./actor.js";
import { DomainError } from "./errors.js";

export interface KitRow {
  kitNumber: string;
  kitTypeCode: string;
  lot: string;
  expiresOn: string;
}

/**
 * Parses a kit shipment CSV: header `kit_number,kit_type,lot,expiry`, one kit
 * per line, expiry as YYYY-MM-DD. Same deliberately narrow dialect as the
 * randomization-list parser (no quoting, no embedded commas).
 */
export function parseKitCsv(csv: string): KitRow[] {
  const lines = csv
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const header = lines.shift()?.toLowerCase();
  if (header !== "kit_number,kit_type,lot,expiry") {
    throw new DomainError('header must be "kit_number,kit_type,lot,expiry"');
  }
  if (lines.length === 0) throw new DomainError("shipment has no kits");

  const seen = new Set<string>();
  return lines.map((line, i) => {
    const cols = line.split(",");
    const rowNum = i + 2;
    if (cols.length !== 4) {
      throw new DomainError(`row ${rowNum}: expected 4 columns, got ${cols.length}`);
    }
    const [kitNumber, kitTypeCode, lot, expiresOn] = cols.map((c) => c.trim()) as [
      string,
      string,
      string,
      string,
    ];
    if (!kitNumber) throw new DomainError(`row ${rowNum}: kit_number must not be empty`);
    if (seen.has(kitNumber)) {
      throw new DomainError(`row ${rowNum}: duplicate kit_number ${kitNumber}`);
    }
    seen.add(kitNumber);
    if (!kitTypeCode) throw new DomainError(`row ${rowNum}: kit_type must not be empty`);
    if (!lot) throw new DomainError(`row ${rowNum}: lot must not be empty`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(expiresOn) || Number.isNaN(Date.parse(expiresOn))) {
      throw new DomainError(`row ${rowNum}: expiry must be a YYYY-MM-DD date`);
    }
    return { kitNumber, kitTypeCode, lot, expiresOn };
  });
}

/**
 * Imports a manufacturer batch to a depot (ADR-0009: import lands at a
 * depot; depot-to-site is always a shipment). Kit type codes must already
 * exist in the study; each kit row is trigger-audited individually (0005) —
 * kit lifecycle is per-kit, unlike list entries. Must run inside withActor.
 */
export async function importKits(
  tx: Tx,
  input: { studyId: string; csv: string; depotId: string; createdBy: string },
): Promise<{ count: number }> {
  const rows = parseKitCsv(input.csv);

  const [depot] = await tx
    .select({ status: depots.status })
    .from(depots)
    .where(and(eq(depots.id, input.depotId), eq(depots.studyId, input.studyId)))
    .limit(1);
  if (!depot) throw new DomainError("depot not found in this study", 404);
  if (depot.status !== "active") throw new DomainError("depot is closed", 409);

  const types = await tx
    .select({ id: kitTypes.id, code: kitTypes.code })
    .from(kitTypes)
    .where(eq(kitTypes.studyId, input.studyId));
  const typeIdByCode = new Map(types.map((t) => [t.code, t.id]));
  for (const row of rows) {
    if (!typeIdByCode.has(row.kitTypeCode)) {
      throw new DomainError(`unknown kit type "${row.kitTypeCode}"`);
    }
  }

  for (let i = 0; i < rows.length; i += 500) {
    await tx.insert(kits).values(
      rows.slice(i, i + 500).map((r) => ({
        studyId: input.studyId,
        // biome-ignore lint/style/noNonNullAssertion: presence checked above
        kitTypeId: typeIdByCode.get(r.kitTypeCode)!,
        kitNumber: r.kitNumber,
        lot: r.lot,
        expiresOn: r.expiresOn,
        depotId: input.depotId,
        createdBy: input.createdBy,
      })),
    );
  }
  return { count: rows.length };
}
