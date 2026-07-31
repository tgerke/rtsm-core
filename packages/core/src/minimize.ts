import { createHash } from "node:crypto";
import { DomainError } from "./errors.js";

/**
 * Pocock–Simon minimization engine (ADR-0008). A pure function: no I/O, no
 * clock, no RNG — the uniform draw comes in as an argument, and everything
 * seen and produced is persisted in the draw record, so any assignment
 * replays exactly. Errors below are arm-free by construction: they may name
 * factors and levels, never arms or counts.
 */

export const ENGINE_VERSION = "pocock-simon-ts-1.0.0";
export const RNG_ALGORITHM = "sha256-ctr-u52-v1";

export interface MinimizationFactor {
  name: string;
  levels: string[];
  weight: number;
}

export interface MinimizationConfig {
  method: "pocock-simon";
  imbalanceMetric: "range";
  arms: string[];
  factors: MinimizationFactor[];
  p: number;
}

/** factor name → level → arm → count of prior assignments. */
export type CountsSnapshot = Record<string, Record<string, Record<string, number>>>;

export interface MinimizationResult {
  imbalanceScores: Record<string, number>;
  armProbabilities: Record<string, number>;
  chosenArm: string;
}

/**
 * Counter-based uniform draw: sha256(seed:index), first 52 bits scaled to
 * [0, 1). No mutable generator state to persist — the seed and the draw
 * index reproduce the value (EMA A5.2.4: seed maintained, process
 * reconstructable).
 */
export function uniformDraw(seed: string, drawIndex: number): number {
  const digest = createHash("sha256").update(`${seed}:${drawIndex}`).digest();
  const hi = digest.readUInt32BE(0) >>> 0;
  const lo = digest.readUInt32BE(4) >>> 0;
  // 52 bits: 20 from hi, 32 from lo — exactly representable in a float64.
  return ((hi >>> 12) * 2 ** 32 + lo) / 2 ** 52;
}

/** JSON with object keys sorted at every depth, so the hash is stable. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * The prespecification anchor (FDA adaptive-designs guidance §VIII.B): a
 * checksum over the canonical config plus a seed *reference* (the seed's
 * own sha256, per ADR-0008) — the anchor pins the seed's identity while the
 * hash itself stays safe to show on blinded surfaces.
 */
export function methodSha256(config: MinimizationConfig, seed: string): string {
  const seedSha256 = createHash("sha256").update(seed).digest("hex");
  return createHash("sha256").update(canonicalJson({ config, seedSha256 })).digest("hex");
}

/**
 * One Pocock–Simon step with the range metric (ADR-0008 decision 1): for
 * each candidate arm, hypothetically assign the subject and score the
 * weighted sum, across factors, of the range (max − min) of arm counts at
 * the subject's level. The minimizing arm is favored with probability p,
 * ties splitting the favored probability equally; an all-arm tie (the first
 * subject included) is a pure equal-probability draw (decision 4).
 */
export function minimize(
  config: MinimizationConfig,
  counts: CountsSnapshot,
  covariates: Record<string, string>,
  uniform: number,
): MinimizationResult {
  const { arms, factors, p } = config;
  if (!(uniform >= 0 && uniform < 1)) throw new Error("uniform draw must be in [0, 1)");

  for (const factor of factors) {
    const level = covariates[factor.name];
    if (level === undefined) {
      throw new DomainError(`missing covariate for factor "${factor.name}"`);
    }
    if (!factor.levels.includes(level)) {
      throw new DomainError(`"${level}" is not a configured level of factor "${factor.name}"`);
    }
  }

  const imbalanceScores: Record<string, number> = {};
  for (const candidate of arms) {
    let score = 0;
    for (const factor of factors) {
      const level = covariates[factor.name];
      const levelCounts = counts[factor.name]?.[level as string] ?? {};
      let min = Number.POSITIVE_INFINITY;
      let max = Number.NEGATIVE_INFINITY;
      for (const arm of arms) {
        const n = (levelCounts[arm] ?? 0) + (arm === candidate ? 1 : 0);
        if (n < min) min = n;
        if (n > max) max = n;
      }
      score += factor.weight * (max - min);
    }
    imbalanceScores[candidate] = score;
  }

  const best = Math.min(...arms.map((a) => imbalanceScores[a] as number));
  const favored = arms.filter((a) => imbalanceScores[a] === best);

  const armProbabilities: Record<string, number> = {};
  if (favored.length === arms.length) {
    for (const arm of arms) armProbabilities[arm] = 1 / arms.length;
  } else {
    for (const arm of arms) {
      armProbabilities[arm] = favored.includes(arm)
        ? p / favored.length
        : (1 - p) / (arms.length - favored.length);
    }
  }

  // Deterministic selection: arms in config order, first cumulative bucket
  // containing the draw; the last arm absorbs float rounding.
  let cumulative = 0;
  let chosenArm = arms[arms.length - 1] as string;
  for (const arm of arms) {
    cumulative += armProbabilities[arm] as number;
    if (uniform < cumulative) {
      chosenArm = arm;
      break;
    }
  }

  return { imbalanceScores, armProbabilities, chosenArm };
}
