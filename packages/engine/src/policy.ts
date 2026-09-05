/**
 * Baseline policies.
 *
 * IMPORTANT DISTINCTION, and one this project got wrong for a while:
 *
 *   MODEL error  = the formula disagrees with the game about what a given
 *                  training yields. Measured by comparing a prediction against
 *                  the number the training screen displays for the same state.
 *                  That is what M2's residual analysis does.
 *
 *   POLICY error = the simulated player makes worse choices than a real one.
 *                  Measured by comparing end-of-career totals.
 *
 * `m1-status.md` originally reported a "3.1x gap" from comparing a simulated
 * career against a real logged one. That number conflates the two. A naive
 * policy would under-perform a skilled player even with a perfect model, so
 * that figure was never a clean measurement of the formula.
 *
 * These policies exist so that projections are not sabotaged by a strawman
 * player. They are NOT the recommender -- the recommender searches. A policy is
 * the fast rollout heuristic a search needs at its leaves, and the yardstick a
 * search has to beat to be worth anything.
 */

import { STATS, type Stat } from "../../data/src/types";
import type { GrandConcertScenario, GcRunState } from "./scenarios/grand-concert";
import type { TurnAction } from "./scenario";

export interface PolicyContext {
  scenario: GrandConcertScenario;
  target?: Partial<Record<Stat, number | null>>;
}

export type Policy = (state: GcRunState, ctx: PolicyContext) => TurnAction;

/**
 * What a competent player actually does, as three rules.
 *
 * 1. **Respect the failure threshold.** Training much above ~15% failure is a
 *    losing trade: a failed training costs the turn, the energy and some mood.
 *    Below that, take it.
 *
 * 2. **Wit is the low-energy click.** It is the only facility that restores
 *    energy (+5 rather than -19 to -26) and its failure base is ~40% lower than
 *    anything else (320 vs 507-548 in `single_mode_training`). So a tired turn
 *    goes to Wit rather than to Rest, which spends the whole turn on nothing
 *    else.
 *
 * 3. **Build bonds before chasing stats.** Rainbow training needs bond >= 80 on
 *    a card sitting on its own facility, and it is the single largest multiplier
 *    in the game. Early turns spent where cards are stacked pay for themselves
 *    many times over later. A policy that just trains the lowest stat never
 *    reaches rainbow and badly under-projects a whole career -- which is exactly
 *    what the first version of this simulator did.
 */
export const competentPolicy: Policy = (state, { scenario, target = {} }) => {
  const s = state.scenario;
  const energy = state.energy;

  // Mood is a multiplier on every training; topping it up is usually worth more
  // than the training the outing displaces.
  if (state.mood < 2 && energy > 45 && state.turn % 7 === 0) return { kind: "outing" };
  if (state.mood <= -1) return { kind: "outing" };

  const FAILURE_LIMIT = 0.15;
  const candidates = STATS.filter((f) => scenario.failureChanceFor(state, f) <= FAILURE_LIMIT);

  // Nothing safe to train. Wit first if it is safe, since it refunds energy;
  // otherwise rest.
  if (candidates.length === 0) {
    if (scenario.failureChanceFor(state, "wit") <= 0.3) return { kind: "train", facility: "wit" };
    return { kind: "rest" };
  }

  // Low energy: prefer Wit, which pays energy back instead of costing it.
  // But only while Wit is still wanted -- an energy refund is not a reason to
  // dump 600 points into a stat with a 400 target. Past the target, Wit clicks
  // are just an expensive Rest.
  const witWanted = target.wit == null || state.stats.wit < target.wit;
  if (energy < 35 && candidates.includes("wit") && witWanted) {
    return { kind: "train", facility: "wit" };
  }
  if (energy < 30) return { kind: "rest" };

  // Bond-building phase. While cards are short of rainbow, train wherever the
  // most not-yet-rainbow cards of that facility's own type are sitting -- that
  // is what converts early turns into a late-career multiplier.
  const buildingBonds = s.cards.some((c) => c.stat !== null && c.bond < 80);
  if (buildingBonds && state.turn <= 30) {
    let best: Stat | null = null;
    let bestScore = 0;
    for (const facility of candidates) {
      let score = 0;
      for (const idx of s.placement[facility]) {
        const card = s.cards[idx];
        if (!card) continue;
        // A card on its own facility is worth far more: only those can rainbow.
        score += card.stat === facility ? (card.bond < 80 ? 3 : 1) : 0.5;
      }
      if (score > bestScore) { bestScore = score; best = facility; }
    }
    if (best && bestScore >= 2) return { kind: "train", facility: best };
  }

  // Otherwise: take rainbow where it exists, then whichever target is furthest
  // from being met.
  let best: Stat = candidates[0]!;
  let bestScore = -Infinity;
  for (const facility of candidates) {
    const rainbows = s.placement[facility].filter((i) => {
      const c = s.cards[i];
      return c && c.stat === facility && c.bond >= 80;
    }).length;

    const want = target[facility] ?? scenario.statCaps[facility];
    const shortfall = Math.max(0, (want ?? 0) - state.stats[facility]) / Math.max(1, want ?? 1);

    // Rainbow dominates; shortfall breaks ties.
    const score = rainbows * 10 + shortfall * 3 + s.placement[facility].length * 0.5;
    if (score > bestScore) { bestScore = score; best = facility; }
  }
  return { kind: "train", facility: best };
};

/**
 * The original naive policy, kept for comparison.
 *
 * Trains whichever stat is furthest from its cap and rests when tired. It never
 * builds bonds deliberately, so it almost never triggers rainbow training.
 * Keeping it lets the projection difference between the two be measured, which
 * is how much of the reported gap was policy rather than model.
 */
export const naivePolicy: Policy = (state, { scenario, target = {} }) => {
  if (state.energy < 30) return { kind: "rest" };
  let pick: Stat = "speed";
  let worst = Infinity;
  for (const stat of STATS) {
    const want = target[stat] ?? scenario.statCaps[stat];
    const ratio = state.stats[stat] / Math.max(1, want ?? 1);
    if (ratio < worst) { worst = ratio; pick = stat; }
  }
  return { kind: "train", facility: pick };
};

/**
 * Concentrate on a small set of facilities.
 *
 * Derived from a real logged career, which ended with Speed 5 / Wit 5 and
 * Stamina, Power and Guts still at level 1 -- untouched for 72 turns. That was
 * a surprise: the assumption had been that a good run levels most facilities to
 * 4-5. It does not. It picks two and hammers them.
 *
 * The mechanism matters more than the observation. Concentrating is not about
 * facility level directly; it is that repeatedly training the same facility is
 * what drives the cards specialising in it to bond 80, which is what unlocks
 * rainbow, which is the largest multiplier in the game. Facility level is a
 * side effect of concentration, not an independent lever -- which is why
 * "facility levels never rise" was the wrong diagnosis.
 */
export function focusedPolicy(focus: Stat[]): Policy {
  return (state, ctx) => {
    const { scenario, target = {} } = ctx;
    const s = state.scenario;

    // Mood is a multiplier on every training, and these cards carry large
    // mood_effect values (30-40 each), so the gap between normal and great is
    // worth roughly 38% on everything. Managing it beats one extra training.
    if (state.mood < 2 && state.energy > 45 && state.turn % 7 === 0) {
      return { kind: "outing" };
    }
    if (state.mood <= -1) return { kind: "outing" };

    const FAILURE_LIMIT = 0.15;
    const safe = (f: Stat) => scenario.failureChanceFor(state, f) <= FAILURE_LIMIT;

    // Wit is the low-energy click: it refunds energy and its failure base is
    // ~40% lower than anything else.
    const witWanted = target.wit == null || state.stats.wit < target.wit;
    if (state.energy < 35) {
      if (safe("wit") && witWanted) return { kind: "train", facility: "wit" };
      return { kind: "rest" };
    }

    const pool = focus.filter(safe);
    if (pool.length === 0) return { kind: "rest" };

    let best = pool[0]!;
    let bestScore = -Infinity;
    for (const facility of pool) {
      const placed = s.placement[facility];
      const rainbows = placed.filter((i) => {
        const c = s.cards[i];
        return c && c.stat === facility && c.bond >= 80;
      }).length;
      const onType = placed.filter((i) => s.cards[i]?.stat === facility).length;

      const want = target[facility] ?? scenario.statCaps[facility];
      const shortfall = Math.max(0, (want ?? 0) - state.stats[facility]) / Math.max(1, want ?? 1);

      // Rainbow first; then cards that could still become rainbow; then need.
      const score = rainbows * 12 + onType * 4 + placed.length * 0.5 + shortfall * 2;
      if (score > bestScore) { bestScore = score; best = facility; }
    }
    return { kind: "train", facility: best };
  };
}

export const POLICIES: Record<string, Policy> = {
  competent: competentPolicy,
  naive: naivePolicy,
  // The two facilities the real logged run actually levelled.
  focused: focusedPolicy(["speed", "wit"]),
};
