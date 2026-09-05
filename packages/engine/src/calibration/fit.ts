/**
 * Residual analysis and the base-value solver.
 *
 * The model is multiplicative, so the informative comparison is a ratio, not a
 * difference:
 *
 *     residual = observedGain / predictedGain
 *
 * The average residual tells you the model is wrong. What tells you *where* it
 * is wrong is the residual's STRUCTURE: bucket the observations by each term's
 * input and look for a trend. A term that is mis-specified makes the residual
 * vary with its own input; an innocent term leaves it flat.
 *
 * That is the whole point of M2. docs/m1-status.md lists candidate causes and
 * deliberately refuses to rank them, because ranking without data is guessing.
 * This ranks them.
 */

import { STATS, type Stat, type StatVector } from "../../../data/src/types";
import {
  computeTraining, resolveBaseTraining, isRainbow,
  MOOD_VALUES, type FacilityTable, type PlacedCard,
} from "../scenarios/grand-concert/training";
import type { Observation } from "./log";

// ---------------------------------------------------------------------------
// Prediction
// ---------------------------------------------------------------------------

export interface CardEffectLookup {
  (cardId: number): PlacedCard["effects"];
}

const NO_CAP: StatVector = {
  speed: Infinity, stamina: Infinity, power: Infinity, guts: Infinity, wit: Infinity,
};
const ZERO: StatVector = { speed: 0, stamina: 0, power: 0, guts: 0, wit: 0 };

export interface Residual {
  observation: Observation;
  observed: number;
  predicted: number;
  /** observed / predicted. 1.0 is a match. */
  ratio: number;
  rainbowCount: number;
  cardCount: number;
}

/** Predict the facility's own-stat gain for one observation. */
export function predictOwnStat(
  o: Observation,
  facilityTable: FacilityTable,
  effectsFor: CardEffectLookup,
): number {
  const cards: PlacedCard[] = o.cards.map((c) => ({
    cardId: c.cardId,
    bond: c.bond,
    stat: c.stat,
    effects: effectsFor(c.cardId),
  }));

  const result = computeTraining({
    facility: o.facility,
    facilityLevel: o.facilityLevel,
    mood: o.mood,
    growthRate: o.growthRate ?? {},
    cards,
    facilityTable,
    // Caps must not clip a calibration prediction -- we are comparing against
    // the game's displayed number, which is pre-cap.
    statCaps: NO_CAP,
    currentStats: ZERO,
  });
  return result.gains[o.facility];
}

export function computeResiduals(
  observations: Observation[],
  facilityTable: FacilityTable,
  effectsFor: CardEffectLookup,
): Residual[] {
  const out: Residual[] = [];
  for (const o of observations) {
    const observed = o.predictedGains[o.facility];
    if (observed === undefined) continue;
    const predicted = predictOwnStat(o, facilityTable, effectsFor);
    if (predicted <= 0) continue;
    out.push({
      observation: o,
      observed,
      predicted,
      ratio: observed / predicted,
      rainbowCount: o.cards.filter((c) => c.stat === o.facility && c.bond >= 80).length,
      cardCount: o.cards.length,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

export interface Bucket {
  key: string;
  n: number;
  meanRatio: number;
  minRatio: number;
  maxRatio: number;
}

export interface Grouping {
  /** Which model term this grouping implicates. */
  term: string;
  groupedBy: string;
  buckets: Bucket[];
  /**
   * Max bucket mean minus min bucket mean. Large spread means the residual
   * varies with this term's input, which is what a mis-specified term looks
   * like. Flat means the term is innocent.
   */
  spread: number;
  /** Buckets with only one or two samples are noise; this counts the solid ones. */
  bucketsWithEnoughData: number;
}

function summarise(key: string, ratios: number[]): Bucket {
  const n = ratios.length;
  const mean = ratios.reduce((a, b) => a + b, 0) / n;
  return {
    key, n,
    meanRatio: round(mean),
    minRatio: round(Math.min(...ratios)),
    maxRatio: round(Math.max(...ratios)),
  };
}

function round(x: number): number {
  return Math.round(x * 1000) / 1000;
}

function group(
  residuals: Residual[],
  term: string,
  groupedBy: string,
  keyOf: (r: Residual) => string,
  minSamples = 3,
): Grouping {
  const byKey = new Map<string, number[]>();
  for (const r of residuals) {
    const k = keyOf(r);
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k)!.push(r.ratio);
  }

  const buckets = [...byKey.entries()]
    .map(([k, ratios]) => summarise(k, ratios))
    .sort((a, b) => a.key.localeCompare(b.key, undefined, { numeric: true }));

  const solid = buckets.filter((b) => b.n >= minSamples);
  const means = solid.map((b) => b.meanRatio);
  const spread = means.length >= 2 ? round(Math.max(...means) - Math.min(...means)) : 0;

  return { term, groupedBy, buckets, spread, bucketsWithEnoughData: solid.length };
}

export interface Diagnosis {
  sampleCount: number;
  overallMeanRatio: number;
  /** Sorted by spread, worst first. The top entry is the leading suspect. */
  groupings: Grouping[];
  /** Plain-language reading of the table. */
  verdict: string[];
}

export function diagnose(residuals: Residual[]): Diagnosis {
  const ratios = residuals.map((r) => r.ratio);
  const overall = ratios.length
    ? round(ratios.reduce((a, b) => a + b, 0) / ratios.length)
    : 0;

  const groupings = [
    group(residuals, "friendship bonus", "rainbow card count",
      (r) => `rainbow=${r.rainbowCount}`),
    group(residuals, "facility level base values (2-4 are interpolated)", "facility level",
      (r) => `level=${r.observation.facilityLevel}`),
    group(residuals, "card count term (1 + 0.05n)", "cards on the facility",
      (r) => `cards=${r.cardCount}`),
    group(residuals, "mood multiplier", "mood",
      (r) => `mood=${r.observation.mood}`),
    group(residuals, "per-facility base values", "facility",
      (r) => `facility=${r.observation.facility}`),
  ].sort((a, b) => b.spread - a.spread);

  const verdict: string[] = [];
  if (residuals.length < 20) {
    verdict.push(
      `Only ${residuals.length} observations. Treat everything below as provisional; ` +
      `aim for 60+ spread across levels, moods and bond states.`,
    );
  }
  if (Math.abs(overall - 1) < 0.05) {
    verdict.push(`Overall ratio ${overall} -- the model is close on average.`);
  } else if (overall > 1) {
    verdict.push(
      `Overall ratio ${overall}: the model UNDER-predicts by about ` +
      `${Math.round((overall - 1) * 100)}%.`,
    );
  } else {
    verdict.push(
      `Overall ratio ${overall}: the model OVER-predicts by about ` +
      `${Math.round((1 - overall) * 100)}%.`,
    );
  }

  const top = groupings[0];
  if (top && top.spread >= 0.1 && top.bucketsWithEnoughData >= 2) {
    verdict.push(
      `Leading suspect: ${top.term}. Residual varies by ${top.spread} across ` +
      `${top.groupedBy}, which is what a mis-specified term looks like.`,
    );
    const flat = groupings.filter((g) => g.spread < 0.05 && g.bucketsWithEnoughData >= 2);
    if (flat.length) {
      verdict.push(
        `Probably innocent (residual flat across their input): ` +
        flat.map((g) => g.term).join("; ") + ".",
      );
    }
  } else if (top) {
    verdict.push(
      `No term shows a clear trend (largest spread ${top.spread}). If the overall ` +
      `ratio is also off, the error is a flat scale factor -- suspect base values ` +
      `or growth rate rather than any multiplier.`,
    );
  }

  return { sampleCount: residuals.length, overallMeanRatio: overall, groupings, verdict };
}

// ---------------------------------------------------------------------------
// Solver: recover the base values master.mdb does not contain
// ---------------------------------------------------------------------------

export interface SolvedBase {
  facility: Stat;
  level: number;
  samples: number;
  /** Implied base value, median across samples. */
  implied: number;
  min: number;
  max: number;
  /** (max - min) / median. Small means the rest of the model is consistent. */
  spread: number;
  currentInterpolated: number;
}

/**
 * With every other term known, the base value falls straight out:
 *
 *     base = observed / (friendship x mood x effectiveness x count x growth)
 *
 * A tight spread across samples means the rest of the model is right and the
 * number can be trusted. A wide spread means something else is wrong -- fix the
 * diagnostics before believing the solved value.
 */
export function solveBaseValues(
  observations: Observation[],
  facilityTable: FacilityTable,
  effectsFor: CardEffectLookup,
  levels = [2, 3, 4],
): SolvedBase[] {
  const byKey = new Map<string, number[]>();

  for (const o of observations) {
    if (!levels.includes(o.facilityLevel)) continue;
    const observed = o.predictedGains[o.facility];
    if (observed === undefined || observed <= 0) continue;

    const cards: PlacedCard[] = o.cards.map((c) => ({
      cardId: c.cardId, bond: c.bond, stat: c.stat, effects: effectsFor(c.cardId),
    }));

    let friendship = 1;
    for (const c of cards) {
      if (isRainbow(c, o.facility)) friendship *= 1 + (c.effects.friendship_bonus ?? 0) / 100;
    }
    let moodEffect = 0, trainingEff = 0, flatBonus = 0;
    for (const c of cards) {
      moodEffect += c.effects.mood_effect ?? 0;
      trainingEff += c.effects.training_effectiveness ?? 0;
      const key = `${o.facility}_bonus` as keyof PlacedCard["effects"];
      flatBonus += (c.effects[key] as number | undefined) ?? 0;
    }
    const moodTerm = 1 + MOOD_VALUES[o.mood] * (1 + moodEffect / 100);
    const effTerm = 1 + trainingEff / 100;
    const countTerm = 1 + 0.05 * cards.length;
    const growthTerm = 1 + (o.growthRate?.[o.facility] ?? 0) / 100;

    const denom = friendship * moodTerm * effTerm * countTerm * growthTerm;
    if (denom <= 0) continue;

    // observed = floor((base + flatBonus) * denom)  =>  base ~= observed/denom - flatBonus
    const implied = observed / denom - flatBonus;
    const key = `${o.facility}|${o.facilityLevel}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key)!.push(implied);
  }

  const out: SolvedBase[] = [];
  for (const [key, values] of byKey) {
    const [facility, levelStr] = key.split("|") as [Stat, string];
    const level = Number(levelStr);
    const sorted = [...values].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)]!;
    const min = sorted[0]!;
    const max = sorted[sorted.length - 1]!;
    const interpolated =
      (resolveBaseTraining(facilityTable, facility, level).values as Record<string, number>)[facility] ?? 0;

    out.push({
      facility, level,
      samples: values.length,
      implied: round(median),
      min: round(min),
      max: round(max),
      spread: median !== 0 ? round((max - min) / Math.abs(median)) : 0,
      currentInterpolated: interpolated,
    });
  }

  return out.sort((a, b) =>
    a.facility.localeCompare(b.facility) || a.level - b.level);
}

export { STATS };
