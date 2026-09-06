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

export type CardKind = "stat" | "friend" | "group";

/** Resolved effect values at a card's level. Percentages except flat stat bonuses. */
export interface CardEffects {
  friendship_bonus?: number;
  mood_effect?: number;
  training_effectiveness?: number;
  speed_bonus?: number;
  stamina_bonus?: number;
  power_bonus?: number;
  guts_bonus?: number;
  wit_bonus?: number;
  skill_point_bonus?: number;
}

/**
 * An effect that only switches on once the card's bond gauge reaches a
 * threshold -- `support_card_unique_effect` type 101.
 *
 * Team Sirius's is worth a lot: training_effectiveness +10 at bond 80, on a card
 * that has no facility of its own and so appears everywhere.
 */
export interface BondThresholdEffect {
  bondAtLeast: number;
  effect: keyof CardEffects;
  amount: number;
}

/** One support card as it sits on a training this turn. */
export interface PlacedCard {
  cardId: number;
  /** 0-100. Rainbow (rented-out max) training requires a full gauge and a matching facility. */
  bond: number;
  /** Which facility this card specialises in; null for friend AND group cards. */
  stat: Stat | null;
  /**
   * What kind of card this is. NOT derivable from `stat`: a friend card and a
   * group card both have `stat: null`, but they behave differently, and that
   * conflation was a real bug -- see `contributesFriendship`.
   *
   * Defaults to being inferred from `stat` when absent, so existing callers keep
   * working, but a group card MUST set it explicitly or its friendship bonus is
   * silently dropped.
   */
  kind?: CardKind;
  effects: CardEffects;
  /** Bond-gated bumps to the values in `effects`. Applied before any multiplier. */
  bondThresholdEffects?: BondThresholdEffect[];
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
    /** Cards showing the rainbow glow (stat cards on their own facility). */
    rainbowCards: number;
    /** Cards contributing a friendship bonus -- rainbow cards plus group cards. */
    friendshipCards: number;
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

/** The bond a card needs before its friendship bonus applies. */
export const RAINBOW_BOND = 80;

/** A card's kind, inferred from `stat` when it was not set explicitly. */
export function cardKind(card: PlacedCard): CardKind {
  return card.kind ?? (card.stat === null ? "friend" : "stat");
}

/**
 * Is this card showing RAINBOW training on this facility?
 *
 * Rainbow is the visible gold-glow state, and it is a stat-card-only thing: it
 * needs the card to be sitting on the facility it specialises in, with a full
 * bond gauge. A card with no specialty can never show it.
 */
export function isRainbow(card: PlacedCard, facility: Stat): boolean {
  return cardKind(card) === "stat" && card.stat === facility && card.bond >= RAINBOW_BOND;
}

/**
 * Is this card contributing its friendship bonus to this training?
 *
 * This is DELIBERATELY not the same question as `isRainbow`, and collapsing the
 * two is the bug this function exists to prevent.
 *
 * What master.mdb says, measured across all 235 cards:
 *
 *   - stat cards   command_id 101-106, friendship_bonus on 223/223
 *   - friend cards command_id 0,       friendship_bonus on   0/10
 *   - group cards  command_id 0,       friendship_bonus on   2/2
 *
 * So a group card carries a real friendship bonus (Heirs to the Throne 10 -> 35%,
 * Team Sirius 5 -> 15%) while having no facility to match against. Under the old
 * `card.stat === facility` test that bonus could never fire, on any facility,
 * ever -- the card was extracted, stored, placed, and then silently ignored by
 * the only term that made it worth playing.
 *
 * UNVERIFIED, and flagged as such in `assumptions`: master.mdb stores the value
 * but not the condition, so "a group card's friendship bonus applies at bond 80
 * on whichever facility it lands on" is the modelling choice, not a decoded
 * fact. It is the reading that makes the extracted number mean anything -- a
 * bonus with no facility that can ever satisfy it would be dead data -- but the
 * alternative (it applies unconditionally, with no bond gate) predicts a
 * measurably different curve early in a career. A single logged run with a group
 * card in the deck separates them, which is why `GROUP_FRIENDSHIP_ASSUMPTION` is
 * a named string rather than a comment.
 */
export function contributesFriendship(card: PlacedCard, facility: Stat): boolean {
  const kind = cardKind(card);
  if (kind === "stat") return card.stat === facility && card.bond >= RAINBOW_BOND;
  // Friend cards genuinely have no friendship bonus in the data, so this is
  // only ever true for a group card -- but it is written as a bond test rather
  // than a kind test so a friend card with a nonzero curve would not be dropped.
  if (kind === "group") return card.bond >= RAINBOW_BOND;
  return false;
}

export const GROUP_FRIENDSHIP_ASSUMPTION =
  "a group card's friendship bonus is modelled as applying at bond >= 80 on " +
  "whichever facility it lands on; master.mdb stores the value but not the " +
  "condition, so this is unverified and needs a logged run with a group card";

/**
 * A card's effects with its bond-gated unique effect folded in.
 *
 * `support_card_unique_effect` type 101 is a conditional: at bond N, add M to
 * effect T. Team Sirius gets training_effectiveness +10 at bond 80 this way,
 * which is larger than most of its base curve.
 */
export function effectiveEffects(card: PlacedCard): CardEffects {
  const gated = card.bondThresholdEffects;
  if (!gated || gated.length === 0) return card.effects;
  const out: CardEffects = { ...card.effects };
  for (const g of gated) {
    if (card.bond < g.bondAtLeast) continue;
    out[g.effect] = (out[g.effect] ?? 0) + g.amount;
  }
  return out;
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
  // Fold each card's bond-gated unique effect into its effect values ONCE, so
  // every term below reads the same numbers.
  const resolvedEffects = new Map<PlacedCard, CardEffects>();
  for (const card of cards) resolvedEffects.set(card, effectiveEffects(card));
  const eff = (card: PlacedCard): CardEffects => resolvedEffects.get(card)!;

  for (const card of cards) {
    if ((card.bondThresholdEffects?.length ?? 0) > 0 && card.bond >= 80) {
      assumptions.push(
        `card ${card.cardId} bond-threshold unique effect is applied; the type-101 ` +
        `decode is inferred from the row shape, not decoded from the game`,
      );
    }
  }

  const baseVec: StatVector = { ...ZERO_STATS };
  const statBonus: StatVector = { ...ZERO_STATS };
  for (const stat of STATS) {
    baseVec[stat] = (base as Record<string, number>)[stat] ?? 0;
    for (const card of cards) {
      statBonus[stat] += eff(card)[STAT_BONUS_KEY[stat]] ?? 0;
    }
    statBonus[stat] += songBonuses[stat] ?? 0;
  }

  // --- term 2: friendship, multiplicative across contributing cards --------
  //
  // NOT the same set as "cards showing rainbow". A group card has no facility,
  // so it never shows the rainbow glow, but it does carry a friendship bonus --
  // see contributesFriendship() for the measurement and the open question.
  let friendship = 1;
  let groupFriendshipUsed = false;
  for (const card of cards) {
    if (!contributesFriendship(card, facility)) continue;
    friendship *= 1 + (eff(card).friendship_bonus ?? 0) / 100;
    if (cardKind(card) === "group") groupFriendshipUsed = true;
  }
  if (groupFriendshipUsed) assumptions.push(GROUP_FRIENDSHIP_ASSUMPTION);

  // --- term 3: mood --------------------------------------------------------
  let moodEffectSum = 0;
  for (const card of cards) moodEffectSum += eff(card).mood_effect ?? 0;
  const moodTerm = 1 + MOOD_VALUES[mood] * (1 + moodEffectSum / 100);

  // --- term 4: training effectiveness --------------------------------------
  let trainingEff = 0;
  for (const card of cards) trainingEff += eff(card).training_effectiveness ?? 0;
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
  for (const card of cards) skillPoints += eff(card).skill_point_bonus ?? 0;

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
      rainbowCards: cards.filter((c) => isRainbow(c, facility)).length,
      friendshipCards: cards.filter((c) => contributesFriendship(c, facility)).length,
    },
    assumptions,
  };
}
