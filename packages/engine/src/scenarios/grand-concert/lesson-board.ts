/**
 * The lesson board: three offers, redrawn on every purchase.
 *
 * The engine used to treat the shop as a catalogue -- `legalShopActions`
 * returned every affordable technique, up to 248 of them, and the planner
 * naturally picked the globally cheapest. The game shows **three**, and buying
 * one draws three more. There is no reroll and no skip: the only way to change
 * the board is to purchase.
 *
 * So the old recommendation ("buy technique #1043") was not merely suboptimal.
 * It named something that was almost certainly not on the player's screen, and
 * advice you cannot follow is worse than none.
 *
 * ---------------------------------------------------------------------------
 * Where each number here comes from -- and this matters
 * ---------------------------------------------------------------------------
 *
 * EXTRACTED. The catalogue: 269 squares with exact effect text and exact
 * costs. Every square's family and tier is derived from that text, not from a
 * table someone typed up. Reconstructing it from the database found three
 * places where the community guide is wrong or incomplete:
 *
 *   - Skill Hint tier 3 costs 30, not 35.
 *   - "Stat & SP" and "2 Stats" have THREE tiers, not two; the guide stops at
 *     +6 and the data carries +8 as well.
 *   - An entire family is missing from the guide -- the random-range
 *     techniques ("Guts +3 to 7" for Vi8), 18 squares of them.
 *
 * OBSERVED IN GAME. Three offers, refresh on purchase, no reroll. Derived from
 * Gabriel's own screenshots: two consecutive boards differ only in Visual
 * (10 -> 0), the first offered Makeup Basics at Vi 10, and the board that came
 * back was three songs. That is also what proves songs and techniques share one
 * pool.
 *
 * COMMUNITY-SOURCED, AND FLAGGED. The tier gating and the song unlock gates are
 * NOT in master.mdb -- a schema search over all 416 tables found nothing that
 * could express which squares are on offer when. They come from uma.guide and
 * are marked as such in every projection. They are modelling constants living
 * in the scenario, never in the extracted dataset, because CONTRIBUTING.md's
 * one rule is that a guess never enters the data.
 *
 * NOT KNOWN AT ALL. Whether the three are drawn uniformly or weighted. Uniform
 * is what this implements, and it is flagged. Only logged lesson screens can
 * settle it.
 */

import type { Technique, Song, GrandConcertDataset } from "../../../../data/src/types";
import type { Rng } from "../../rng";

/** How many lessons the board shows at once. Observed in game. */
export const LESSON_OFFERS = 3;

export type LessonFamily =
  | "energy"
  | "skillHint"
  | "skillPoints"
  | "specificStat"
  | "statAndSkillPoints"
  | "twoStats"
  | "statRange";

export interface Classified {
  family: LessonFamily;
  /** 1, 2 or 3. Derived from the effect's own magnitude, not from the cost. */
  tier: number;
}

// The effect text is the game's, already localized, and it names its own
// magnitude -- which is what makes the tier derivable rather than assumed.
const RE_ENERGY = /^Energy \+(\d+)$/i;
const RE_HINT = /^Skill Hint Lvl \+(\d+)/i;
const RE_HINT_APT = /^Skill hint appropriate for aptitude$/i;
const RE_SP = /^Skill Pts \+(\d+)$/i;
const RE_STAT = /^(?:Speed|Stamina|Power|Guts|Wit) \+(\d+)$/i;
const RE_STAT_SP = /^(?:Speed|Stamina|Power|Guts|Wit) \+(\d+) \/ Skill Pts \+\d+$/i;
const RE_TWO_STATS =
  /^(?:Speed|Stamina|Power|Guts|Wit) \+(\d+) \/ (?:Speed|Stamina|Power|Guts|Wit) \+\d+$/i;
const RE_RANGE = /\+\d+ to \d+/i;

/** Magnitude -> tier, per family. Straight from the catalogue dump. */
const TIER_BY_VALUE: Record<string, Record<number, number>> = {
  energy: { 20: 1, 30: 2, 40: 3 },
  skillHint: { 1: 1, 2: 2, 3: 3 },
  skillPoints: { 5: 1, 8: 2, 12: 3 },
  specificStat: { 5: 1, 8: 2, 12: 3 },
  statAndSkillPoints: { 4: 1, 6: 2, 8: 3 },
  twoStats: { 4: 1, 6: 2, 8: 3 },
};

/**
 * Which family and tier a technique belongs to, read off its own effect text.
 *
 * Returns null when nothing matches, and the caller treats that as
 * always-available rather than dropping it. A square the classifier does not
 * recognise must never silently vanish from the board -- that would be a
 * planner quietly refusing to consider a purchase the player can actually see.
 */
export function classify(effectText: string | null): Classified | null {
  if (!effectText) return null;
  const t = effectText.trim();

  let m: RegExpMatchArray | null;
  if ((m = t.match(RE_ENERGY))) {
    return tier("energy", Number(m[1]));
  }
  if (RE_HINT_APT.test(t)) return { family: "skillHint", tier: 1 };
  if ((m = t.match(RE_HINT))) return tier("skillHint", Number(m[1]));
  // The range family must be tested BEFORE the flat ones, since "Guts +3 to 7"
  // would otherwise fall through to a stat match on the first number.
  if (RE_RANGE.test(t)) return { family: "statRange", tier: 1 };
  if ((m = t.match(RE_SP))) return tier("skillPoints", Number(m[1]));
  if ((m = t.match(RE_STAT_SP))) return tier("statAndSkillPoints", Number(m[1]));
  if ((m = t.match(RE_TWO_STATS))) return tier("twoStats", Number(m[1]));
  if ((m = t.match(RE_STAT))) return tier("specificStat", Number(m[1]));
  return null;
}

function tier(family: LessonFamily, value: number): Classified {
  return { family, tier: TIER_BY_VALUE[family]?.[value] ?? 1 };
}

/**
 * Concerts that must have happened before a (family, tier) can appear.
 *
 * COMMUNITY-SOURCED (uma.guide), corroborated by Gabriel's play: "the 3 tiers
 * increase after each concert; for the 2 stats it only exists after the 1st
 * concert."
 *
 * Skill Hint and Energy are available throughout at every tier -- which is why
 * a screenshot from very early in a run showed Energy +30, a tier-2 effect,
 * sitting alongside tier-1 cards. That looked like a contradiction until this
 * table explained it.
 *
 * `null` means the gate is NOT documented anywhere. The guide lists only two
 * tiers for the two combination families while the database carries three, so
 * the top tier of each is gated with the tier below it and flagged, rather
 * than invented or silently dropped.
 */
export const TIER_GATE: Record<LessonFamily, Array<number | null>> = {
  //                        tier1  tier2  tier3
  energy: [0, 0, 0],
  skillHint: [0, 0, 0],
  skillPoints: [0, 1, 4],
  specificStat: [0, 1, 4],
  statAndSkillPoints: [1, 4, 4],
  twoStats: [1, 4, 4],
  // Not in the guide at all. Treated as always available rather than hidden:
  // a square the player can see must stay reachable by the planner.
  statRange: [0, 0, 0],
};

export const TIER_GATE_SOURCE =
  "technique tier gating is community-sourced (uma.guide) and corroborated by " +
  "play, not extracted -- master.mdb has nothing that expresses which squares " +
  "are on offer when. The top tier of 'Stat & SP' and '2 Stats' is undocumented " +
  "and shares the gate below it.";

/**
 * Techniques that must be bought before the Nth song of a phase unlocks.
 *
 * COMMUNITY-SOURCED. Cumulative within a phase, and the count RESETS after
 * every concert. Seven entries per phase, three phases, 21 songs -- which
 * matches the 21 purchasable song squares exactly, and that agreement is the
 * only independent check available on these numbers.
 */
export const SONG_GATES: Record<"first" | "middle" | "final", number[]> = {
  first: [1, 2, 3, 4, 4, 2, 3],
  middle: [2, 2, 2, 4, 5, 2, 2],
  final: [2, 2, 2, 4, 3, 2, 2],
};

export const SONG_GATE_SOURCE =
  "song unlock gates are community-sourced (uma.guide), not extracted; they " +
  "reset after each concert and are cumulative within a phase";

/** Techniques needed to unlock the `nth` (0-based) song of this phase. */
export function songGateFor(concertsHeld: number, nth: number): number {
  const band = concertsHeld === 0 ? "first" : concertsHeld >= 4 ? "final" : "middle";
  const seq = SONG_GATES[band];
  let total = 0;
  for (let i = 0; i <= nth && i < seq.length; i++) total += seq[i]!;
  // Past the documented sequence the phase has no more songs to give.
  return nth < seq.length ? total : Number.POSITIVE_INFINITY;
}

export interface EligibilityInput {
  concertsHeld: number;
  techniquesThisPhase: number;
  songsThisPhase: number;
  songsOwned: number[];
}

/**
 * Every square that could appear on the board right now.
 *
 * Affordability is deliberately NOT considered. The game shows lessons you
 * cannot afford -- greyed, and schedulable, with the shortfall displayed on the
 * point bar. A pool filtered by what is currently affordable would model a
 * different game, and would hide from the planner exactly the case where saving
 * up is the right play.
 */
export function eligibleSquares(
  dataset: GrandConcertDataset,
  state: EligibilityInput,
): number[] {
  const out: number[] = [];

  for (const tech of dataset.techniques as Technique[]) {
    const c = classify(tech.effect.text);
    if (!c) { out.push(tech.id); continue; }
    const gate = TIER_GATE[c.family][c.tier - 1];
    if (gate === null || gate === undefined) continue;
    if (state.concertsHeld >= gate) out.push(tech.id);
  }

  const needed = songGateFor(state.concertsHeld, state.songsThisPhase);
  if (state.techniquesThisPhase >= needed) {
    for (const song of dataset.songs as Song[]) {
      if (!state.songsOwned.includes(song.id)) out.push(song.id);
    }
  }

  return out;
}

/**
 * Draw the board.
 *
 * Uniform without replacement, which is a MODELLING CHOICE and flagged as one.
 * Nothing in master.mdb describes how the three are picked, and a weighted draw
 * would change which purchases a plan can count on. Logged lesson screens would
 * settle it; until then this is the assumption that adds the least.
 */
export function rollOffers(pool: number[], rng: Rng, count = LESSON_OFFERS): number[] {
  if (pool.length <= count) return [...pool];
  const bag = [...pool];
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    const j = Math.floor(rng() * bag.length);
    out.push(bag[j]!);
    bag.splice(j, 1);
  }
  return out;
}

export const OFFER_DRAW_SOURCE =
  "the three offers are drawn uniformly without replacement from everything " +
  "currently eligible; master.mdb does not say how the game picks them, so " +
  "any weighting is unmodelled";
