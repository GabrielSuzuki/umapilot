/**
 * The training stat-gain calculation.
 *
 * This is the single most load-bearing piece of arithmetic in the project. Every
 * recommendation is a comparison of projected stat gains, so an error here is
 * invisible and poisons everything downstream. It is therefore written to be
 * auditable rather than clever: each multiplier is a named term, and the result
 * carries the terms that produced it.
 *
 * NOTHING HERE IS PROVEN YET. The formula shape is community-derived
 * (uma.guide), the support-card effect ids are community-derived, and facility
 * levels 2-4 are not in master.mdb at all. M1's job is to check the output
 * against logged real runs; until that happens every result is flagged with the
 * assumptions it rests on.
 */

import { STATS, type Stat, type StatVector, ZERO_STATS } from "../../../../data/src/types";

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/** Mood, as the game shows it. The multiplier is `1 + moodValue * (1 + moodEffect)`. */
export const MOOD_VALUES = {
  awful: -0.2,
  bad: -0.1,
  normal: 0,
  good: 0.1,
  great: 0.2,
} as const;
export type Mood = keyof typeof MOOD_VALUES;

/** Base per-facility values as extracted, keyed by level as a string. */
export interface FacilityLevelValues {
  speed?: number;
  stamina?: number;
  power?: number;
  guts?: number;
  wit?: number;
  energy?: number;
  skill_points?: number;
  source?: string;
  commandId?: number;
}

export type FacilityTable = Record<Stat, Record<string, FacilityLevelValues>>;

/** One support card as it sits on a training this turn. */
export interface PlacedCard {
  cardId: number;
  /** 0-100. Rainbow (rented-out max) training requires a full gauge and a matching facility. */
  bond: number;
  /** Which facility this card specialises in; null for friend/group cards. */
  stat: Stat | null;
  /** Resolved effect values at this card's level. Percentages except the flat stat bonuses. */
  effects: {
    friendship_bonus?: number;
    mood_effect?: number;
    training_effectiveness?: number;
    speed_bonus?: number;
    stamina_bonus?: number;
    power_bonus?: number;
    guts_bonus?: number;
    wit_bonus?: number;
    skill_point_bonus?: number;
  };
}

export interface TrainingInput {
  facility: Stat;
  /**
   * Flat per-training bonuses from songs already learned
   * ("Training Speed Gain +1"). These add to the BASE value before every
   * multiplier, so an early purchase compounds across the whole remaining
   * career -- which is exactly the time-value effect the planner exists to
   * exploit. Decode them with `accumulatePerTrainingBonuses`.
   */
  songBonuses?: Partial<Record<Stat, number>>;
  songSkillPointBonus?: number;
  facilityLevel: number;
  mood: Mood;
  /** Trainee growth rate for this stat, as a percentage (e.g. 10 for +10%). */
  growthRate: Partial<Record<Stat, number>>;
  cards: PlacedCard[];
  facilityTable: FacilityTable;
  /** Caps for this run. Gains never push a stat above its cap. */
  statCaps: StatVector;
  currentStats: StatVector;
}

export interface TrainingResult {
  gains: StatVector;
  /** Gains before the cap was applied -- useful for spotting wasted training. */
  uncappedGains: StatVector;
  energy: number;
  skillPoints: number;
  /** Every multiplier, so a recommendation can show its working. */
  terms: {
    base: StatVector;
    statBonus: StatVector;
    songBonus: Partial<Record<Stat, number>>;
    friendship: number;
    mood: number;
    trainingEffectiveness: number;
    cardCount: number;
    growth: Partial<Record<Stat, number>>;
  };
  /** Anything the result rests on that has not been verified against a real run. */
  assumptions: string[];
}

// ---------------------------------------------------------------------------
// Base values
// ---------------------------------------------------------------------------

export interface ResolvedBase {
  values: FacilityLevelValues;
  source: "master.mdb" | "interpolated";
}

/**
 * Base values for a facility at a level.
 *
 * master.mdb only contains levels 1 and 5. For 2-4 we interpolate linearly and
 * SAY SO -- the caller propagates that into `assumptions`, so no projection can
 * quietly present an interpolated number as extracted fact. Calibrating these
 * from logged runs is an M1/M2 deliverable.
 */
export function resolveBaseTraining(
  table: FacilityTable,
  facility: Stat,
  level: number,
): ResolvedBase {
  const levels = table[facility];
  if (!levels) throw new Error(`no training data for facility ${facility}`);

  const exact = levels[String(level)];
  if (exact) return { values: exact, source: "master.mdb" };

  const lo = levels["1"];
  const hi = levels["5"];
  if (!lo || !hi) {
    throw new Error(`cannot interpolate ${facility} level ${level}: need levels 1 and 5`);
  }

  const t = (Math.min(Math.max(level, 1), 5) - 1) / 4;
  const keys = new Set([...Object.keys(lo), ...Object.keys(hi)]);
  const out: FacilityLevelValues = {};
  for (const k of keys) {
    if (k === "source" || k === "commandId") continue;
    const a = (lo as Record<string, number>)[k] ?? 0;
    const b = (hi as Record<string, number>)[k] ?? 0;
    // Round toward zero so an interpolated energy cost is never harsher than
    // the level-5 value it sits below.
    (out as Record<string, number>)[k] = Math.trunc(a + (b - a) * t);
  }
  return { values: out, source: "interpolated" };
}

// ---------------------------------------------------------------------------
// The calculation
// ---------------------------------------------------------------------------

const STAT_BONUS_KEY: Record<Stat, keyof PlacedCard["effects"]> = {
  speed: "speed_bonus",
  stamina: "stamina_bonus",
  power: "power_bonus",
  guts: "guts_bonus",
  wit: "wit_bonus",
};

/** Is this card contributing a friendship (rainbow) bonus on this facility? */
export function isRainbow(card: PlacedCard, facility: Stat): boolean {
  return card.stat === facility && card.bond >= 80;
}

export function computeTraining(input: TrainingInput): TrainingResult {
  const {
    facility, facilityLevel, mood, growthRate, cards,
    facilityTable, statCaps, currentStats,
    songBonuses = {}, songSkillPointBonus = 0,
  } = input;

  const assumptions: string[] = [
    "stat-gain formula shape is community-derived (uma.guide), not verified against a logged run",
    "support card effect type ids are community-derived, not decoded from master.mdb",
  ];
  if (Object.keys(songBonuses).length === 0) {
    assumptions.push(
      "no song bonuses supplied -- if songs were owned at this point, their " +
      "per-training stat bonuses are missing and the gain will be under-predicted",
    );
  }

  const resolved = resolveBaseTraining(facilityTable, facility, facilityLevel);
  if (resolved.source === "interpolated") {
    assumptions.push(
      `facility level ${facilityLevel} base values are linearly interpolated between ` +
      `levels 1 and 5; master.mdb does not contain levels 2-4`,
    );
  }
  const base = resolved.values;

  // --- term 1: base + flat bonuses from cards AND from learned songs -------
  //
  // Song bonuses are additive on the base, exactly like a card's stat bonus,
  // and they apply on every facility rather than only where a card sits.
  const baseVec: StatVector = { ...ZERO_STATS };
  const statBonus: StatVector = { ...ZERO_STATS };
  for (const stat of STATS) {
    baseVec[stat] = (base as Record<string, number>)[stat] ?? 0;
    for (const card of cards) {
      statBonus[stat] += card.effects[STAT_BONUS_KEY[stat]] ?? 0;
    }
    statBonus[stat] += songBonuses[stat] ?? 0;
  }

  // --- term 2: friendship, multiplicative across rainbow cards -------------
  let friendship = 1;
  for (const card of cards) {
    if (!isRainbow(card, facility)) continue;
    friendship *= 1 + (card.effects.friendship_bonus ?? 0) / 100;
  }

  // --- term 3: mood --------------------------------------------------------
  let moodEffectSum = 0;
  for (const card of cards) moodEffectSum += card.effects.mood_effect ?? 0;
  const moodTerm = 1 + MOOD_VALUES[mood] * (1 + moodEffectSum / 100);

  // --- term 4: training effectiveness --------------------------------------
  let trainingEff = 0;
  for (const card of cards) trainingEff += card.effects.training_effectiveness ?? 0;
  const effTerm = 1 + trainingEff / 100;

  // --- term 5: card count --------------------------------------------------
  const countTerm = 1 + 0.05 * cards.length;

  // --- combine -------------------------------------------------------------
  const uncappedGains: StatVector = { ...ZERO_STATS };
  const gains: StatVector = { ...ZERO_STATS };
  for (const stat of STATS) {
    if (baseVec[stat] === 0 && statBonus[stat] === 0) continue;
    const growthTerm = 1 + (growthRate[stat] ?? 0) / 100;
    const raw =
      (baseVec[stat] + statBonus[stat]) *
      friendship * moodTerm * effTerm * countTerm * growthTerm;
    const value = Math.floor(raw);
    uncappedGains[stat] = value;
    gains[stat] = Math.max(0, Math.min(value, statCaps[stat] - currentStats[stat]));
  }

  let skillPoints = (base.skill_points ?? 0) + songSkillPointBonus;
  for (const card of cards) skillPoints += card.effects.skill_point_bonus ?? 0;

  return {
    gains,
    uncappedGains,
    energy: base.energy ?? 0,
    skillPoints,
    terms: {
      base: baseVec,
      statBonus,
      friendship,
      mood: moodTerm,
      trainingEffectiveness: effTerm,
      cardCount: countTerm,
      growth: growthRate,
      songBonus: songBonuses,
    },
    assumptions,
  };
}
