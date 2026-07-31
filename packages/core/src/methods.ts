import { randomBytes } from "node:crypto";
import {
  assignments,
  randomizationDraws,
  randomizationEntries,
  randomizationLists,
  randomizationMethods,
} from "@rtsm-core/db";
import { type MinimizationConfigRequest, minimizationConfigSchema } from "@rtsm-core/schemas";
import { and, eq, max, sql } from "drizzle-orm";
import type { Tx } from "./actor.js";
import { DomainError } from "./errors.js";
import {
  type CountsSnapshot,
  ENGINE_VERSION,
  type MinimizationConfig,
  methodSha256,
  minimize,
  RNG_ALGORITHM,
  uniformDraw,
} from "./minimize.js";

/**
 * Creates the next draft method version for the study (ADR-0008). The seed
 * is statistician-supplied or CSPRNG-generated (decision 8); the sha256
 * anchors config + seed reference exactly as the file hash anchors an
 * uploaded list. The returned row carries the seed — callers serialize it
 * only under list.read_unblinded.
 */
export async function createMethodDraft(
  tx: Tx,
  input: { studyId: string; config: MinimizationConfigRequest; seed?: string; createdBy: string },
) {
  const config = input.config as MinimizationConfig;
  const seed = input.seed ?? randomBytes(32).toString("hex");

  const [prior] = await tx
    .select({ v: max(randomizationMethods.version) })
    .from(randomizationMethods)
    .where(eq(randomizationMethods.studyId, input.studyId));
  const version = (prior?.v ?? 0) + 1;

  const [method] = await tx
    .insert(randomizationMethods)
    .values({
      studyId: input.studyId,
      version,
      config,
      sha256: methodSha256(config, seed),
      engineVersion: ENGINE_VERSION,
      seed,
      createdBy: input.createdBy,
    })
    .returning();
  if (!method) throw new Error("method insert returned no row");
  return method;
}

/**
 * Activates a draft method, retiring the study's outgoing randomization
 * source — the prior method and any active uploaded list — and creating the
 * generated list the engine will materialize entries onto. The caller MUST
 * have already re-authenticated the actor's password (P11-06), exactly as
 * for list activation; the route owns the step-up.
 */
export async function activateMethod(
  tx: Tx,
  input: { studyId: string; methodId: string; activatedBy: string; reason: string },
) {
  const [method] = await tx
    .select()
    .from(randomizationMethods)
    .where(
      and(
        eq(randomizationMethods.id, input.methodId),
        eq(randomizationMethods.studyId, input.studyId),
      ),
    )
    .limit(1);
  if (!method) throw new DomainError("method not found", 404);
  if (method.status !== "draft") {
    throw new DomainError(`method is ${method.status}; only a draft can be activated`, 409);
  }

  const now = new Date();
  // One active source (ADR-0008): the activation act switches the study to
  // this method, so the outgoing source retires in the same transaction —
  // uploaded and generated lists alike, plus the predecessor method. The
  // rtsm_one_active_source trigger backstops any path that skips this.
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
    .update(randomizationMethods)
    .set({
      status: "active",
      activatedBy: input.activatedBy,
      activatedAt: now,
      activationReason: input.reason,
    })
    .where(eq(randomizationMethods.id, input.methodId))
    .returning();
  if (!activated) throw new Error("method activation returned no row");

  const [priorList] = await tx
    .select({ v: max(randomizationLists.version) })
    .from(randomizationLists)
    .where(eq(randomizationLists.studyId, input.studyId));
  const [generatedList] = await tx
    .insert(randomizationLists)
    .values({
      studyId: input.studyId,
      version: (priorList?.v ?? 0) + 1,
      status: "active",
      kind: "generated",
      methodId: activated.id,
      filename: `generated-method-v${activated.version}`,
      sha256: activated.sha256,
      rowCount: 0,
      createdBy: input.activatedBy,
      activatedBy: input.activatedBy,
      activatedAt: now,
      activationReason: input.reason,
    })
    .returning();
  if (!generatedList) throw new Error("generated list insert returned no row");

  return activated;
}

/** Explicit zeros for every (factor, level, arm), so the persisted snapshot
 * is self-contained and the replay needs nothing but the draw row. */
function emptyCounts(config: MinimizationConfig): CountsSnapshot {
  const counts: CountsSnapshot = {};
  for (const factor of config.factors) {
    const byLevel: Record<string, Record<string, number>> = {};
    for (const level of factor.levels) {
      const byArm: Record<string, number> = {};
      for (const arm of config.arms) byArm[arm] = 0;
      byLevel[level] = byArm;
    }
    counts[factor.name] = byLevel;
  }
  return counts;
}

/**
 * The adaptive allocation path of randomizeSubject (ADR-0008). Must run
 * inside withActor, after the caller's site and duplicate-subject checks.
 *
 * Serialization is a correctness property, not a throughput concession:
 * minimization's output depends on arrival order, so the per-study advisory
 * lock fully serializes adaptive randomization within the study. Counts are
 * recomputed from full assignment history inside the transaction — the
 * blinded-join pattern of dispenseKit; no counts leave the transaction
 * (decision 5: history recomputes under the current factor set, prior
 * subjects contributing whatever covariates their strata recorded).
 */
export async function randomizeAdaptive(
  tx: Tx,
  method: typeof randomizationMethods.$inferSelect,
  input: {
    studyId: string;
    subjectKey: string;
    covariates: Record<string, string>;
    siteId?: string;
    siteCode?: string;
    createdBy: string;
  },
) {
  const config = minimizationConfigSchema.parse(method.config) as MinimizationConfig;

  // Site is a minimization factor by default (decision 2): when the config
  // has a "site" factor and the request named a site, the site code fills
  // the covariate unless the caller supplied one explicitly.
  const covariates = { ...input.covariates };
  if (
    covariates.site === undefined &&
    input.siteCode !== undefined &&
    config.factors.some((f) => f.name === "site")
  ) {
    covariates.site = input.siteCode;
  }

  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended('rtsm_randomize:' || ${input.studyId}, 0))`,
  );

  const [generatedList] = await tx
    .select({ id: randomizationLists.id })
    .from(randomizationLists)
    .where(and(eq(randomizationLists.methodId, method.id), eq(randomizationLists.status, "active")))
    .limit(1);
  if (!generatedList) throw new DomainError("active method has no generated list", 409);

  const counts = emptyCounts(config);
  const history = await tx
    .select({ arm: randomizationEntries.arm, strata: assignments.strata })
    .from(assignments)
    .innerJoin(randomizationEntries, eq(assignments.entryId, randomizationEntries.id))
    .where(eq(assignments.studyId, input.studyId));
  for (const row of history) {
    const strata = (row.strata ?? {}) as Record<string, string>;
    for (const factor of config.factors) {
      const level = strata[factor.name];
      if (level === undefined) continue;
      const byArm = counts[factor.name]?.[level];
      if (byArm && row.arm in byArm) byArm[row.arm] = (byArm[row.arm] as number) + 1;
    }
  }

  const [lastSeq] = await tx
    .select({ s: max(randomizationEntries.seq) })
    .from(randomizationEntries)
    .where(eq(randomizationEntries.listId, generatedList.id));
  const drawIndex = (lastSeq?.s ?? 0) + 1;

  const uniform = uniformDraw(method.seed, drawIndex);
  const result = minimize(config, counts, covariates, uniform);

  const [entry] = await tx
    .insert(randomizationEntries)
    .values({
      listId: generatedList.id,
      seq: drawIndex,
      arm: result.chosenArm,
      generated: true,
    })
    .returning({ id: randomizationEntries.id });
  if (!entry) throw new Error("generated entry insert returned no row");

  const [assignment] = await tx
    .insert(assignments)
    .values({
      studyId: input.studyId,
      entryId: entry.id,
      subjectKey: input.subjectKey,
      siteId: input.siteId ?? null,
      strata: covariates,
      createdBy: input.createdBy,
    })
    .returning();
  if (!assignment) throw new Error("assignment insert returned no row");

  // The reproducibility record (EMA A5.2.4): everything the engine saw and
  // produced. engine_version is the runtime engine, which after an upgrade
  // may be newer than the one stamped on the method at creation — the draw
  // records what actually ran.
  await tx.insert(randomizationDraws).values({
    studyId: input.studyId,
    methodId: method.id,
    configVersion: method.version,
    engineVersion: ENGINE_VERSION,
    rngAlgorithm: RNG_ALGORITHM,
    drawIndex,
    uniformValue: uniform,
    countsSnapshot: counts,
    imbalanceScores: result.imbalanceScores,
    armProbabilities: result.armProbabilities,
    chosenArm: result.chosenArm,
    entryId: entry.id,
  });

  return assignment;
}
