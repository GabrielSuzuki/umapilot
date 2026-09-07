/**
 * What a turn is worth.
 *
 * The rollout policy has to choose a facility every turn, and for most of this
 * project it chose with hand-set weights -- `rainbows * 10 + shortfall * 3 +
 * placed * 0.5` in `competentPolicy`, and 12 / 4 / 0.5 / 2 in `focusedPolicy`.
 * Those weights were standing in for real quantities. Computing the quantities
 * instead is worth +100 stat points a career (n=300 paired careers, se 15,
 * t=6.5). Read the caveat on `valuePolicy` before making it the default: it
 * wins on stats and loses on lessons, and the model is known to under-price
 * lessons.
 *
 * The first version of this measurement said +158 off eight seeds. It was
 * noise: at twenty-four seeds it was +31 with a 95% interval of -80..+142.
 * Paired seeds do not cancel between two POLICIES the way they cancel between
 * two states -- the runs diverge on their first disagreement and never
 * re-couple, so each career is close to an independent draw and the spread is
 * the full spread of careers, sd ~265. Three hundred careers cost four seconds.
 * There was no reason to read this one off eight.
 *
 * Everything here is in `shortfallScore` units -- the objective's own currency
 * -- and there is not one tuning constant in the file. Every number is either
 * read out of `master.mdb`, measured by running the training formula twice and
 * differencing, or taken from the run's own history. That is deliberate: the
 * last several things that went wrong in this planner were invented weights.
 */

import { STATS, type Stat, type StatVector } from "../../../data/src/types";
import {
  USES_PER_LEVEL, MAX_FACILITY_LEVEL, BOND_GAIN_OWN, REST_ENERGY_MEAN,
  type GrandConcertScenario, type GcRunState,
} from "../scenarios/grand-concert";
import { RAINBOW_BOND } from "../scenarios/grand-concert/training";
import type { Policy, PolicyContext } from "../policy";
import { shortfallScore, type CompiledTarget } from "./objective";

/**
 * The score of this state with a different stat line and SP total.
 *
 * `shortfallScore` reads exactly two fields off a state, so a shallow spread is
 * enough and a full clone would be waste in a function the policy calls five
 * times a turn.
 */
function scoreWith(
  state: GcRunState,
  stats: StatVector,
  skillPoints: number,
  target: CompiledTarget,
): number {
  return shortfallScore({ ...state, stats, skillPoints }, target);
}

/** What adding these gains would be worth, from where the run stands now. */
export function gainValue(
  state: GcRunState,
  target: CompiledTarget,
  gains: Partial<Record<Stat, number>>,
  skillPoints = 0,
): number {
  const before = shortfallScore(state, target);
  const stats = { ...state.stats };
  for (const stat of STATS) stats[stat] += gains[stat] ?? 0;
  return scoreWith(state, stats, state.skillPoints + skillPoints, target) - before;
}

/**
 * How the run has been spending its turns, read off its own history.
 *
 * `facilityUses` counts trainings, so the ratio of that total to elapsed turns
 * is how often this run trains at all, and each facility's share of it is where
 * those trainings go. Both are needed to turn "+1 speed per training" into a
 * number, and both are properties of the run rather than assumptions about it.
 *
 * At turn 1 there is no history. The prior is one training per turn spread
 * evenly, which is the shape of a career that trains whenever it can -- and
 * being wrong about turn 1 costs nothing, because at turn 1 no song is
 * affordable anyway.
 */
export function trainingProfile(
  scenario: GrandConcertScenario,
  state: GcRunState,
): { remainingTrainings: number; share: Record<Stat, number> } {
  const s = state.scenario;
  const elapsed = Math.max(0, state.turn - 1);
  const totalUses = STATS.reduce((a, f) => a + s.facilityUses[f], 0);
  const remainingTurns = Math.max(0, scenario.careerTurns - state.turn + 1);

  const trainRate = elapsed === 0 ? 1 : totalUses / elapsed;
  const share = {} as Record<Stat, number>;
  for (const f of STATS) {
    share[f] = totalUses === 0 ? 1 / STATS.length : s.facilityUses[f] / totalUses;
  }
  return { remainingTrainings: remainingTurns * trainRate, share };
}

// ---------------------------------------------------------------------------
// Valuing one song
// ---------------------------------------------------------------------------

/**
 * What a training is worth, including the two things it buys that are not on
 * the screen.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 *
 * The song term below is a lookahead: it knows what owning a song is worth for
 * the rest of the career. Scoring it against the stat points a training shows
 * *this turn* is not a comparison, it is a rigged one -- and it lost 42 points
 * a career doing exactly that, while buying almost one extra song. The song
 * was not overpriced. The training was underpriced.
 *
 * A training buys three things:
 *
 *   IMMEDIATE  the stat points and skill points. What the screen shows.
 *
 *   LEVEL      one quarter of a facility level, and a level raises the BASE
 *              value of every future training there. Priced by asking
 *              `previewTraining` what the same training would pay one level up,
 *              amortised over the four uses a level costs, and multiplied by
 *              the trainings this run still expects to spend on that facility.
 *
 *   BOND       progress toward rainbow on every card of that facility's own
 *              type sitting there. Rainbow is the largest multiplier in the
 *              game, so this is usually the biggest of the three early on --
 *              and it is precisely what the base policy's hand-set weight of
 *              10 or 12 was standing in for. Priced by asking
 *              `previewTraining` what the training would pay if that card were
 *              already at rainbow, scaled by the fraction of the remaining
 *              distance this one training covers.
 *
 * The last two are why `competentPolicy` trains where the cards are stacked
 * instead of where the stat is short, and why doing otherwise wrecks a career.
 * Naming them as values rather than as weights is what lets the song plan
 * argue with them honestly.
 */
export interface TrainingValue {
  immediate: number;
  level: number;
  bond: number;
  /**
   * Energy this training spends, as a positive number. Wit REFUNDS energy, so
   * its figure is negative.
   *
   * Not folded into `total`, because pricing it needs to know what a turn of
   * this run is worth and that is only knowable once every facility has been
   * scored. `priceEnergy` does it in a second pass.
   */
  energyCost: number;
  total: number;
}

export function trainingValue(
  scenario: GrandConcertScenario,
  state: GcRunState,
  facility: Stat,
  target: CompiledTarget,
): TrainingValue {
  const s = state.scenario;
  const { remainingTrainings, share } = trainingProfile(scenario, state);
  const future = remainingTrainings * share[facility];

  const base = scenario.previewTraining(state, facility);
  const immediate = gainValue(state, target, base.gains, base.skillPoints);

  // --- the level term -------------------------------------------------------
  //
  // Bounded by the levels that are actually left. `future` is how many more
  // trainings this run expects to spend here, and it is routinely far more than
  // the facility can still use: at level 4 only four more uses buy anything at
  // all, because `levelUpFacility` caps at MAX_FACILITY_LEVEL. Pricing
  // `future / USES_PER_LEVEL` levels when only `MAX - current` exist over-values
  // concentration, and over-values it MOST on a facility that is nearly capped.
  //
  // That was not a rounding error. Unbounded, `valuePolicy`'s sign flipped with
  // the starting facility levels -- +79 at all-1, -76 at all-2, -12 at all-3,
  // +80 at all-4, every one of them significant at n=1500 -- and the flips
  // tracked how much rainbow it gave up chasing levels it could never reach.
  let level = 0;
  const current = s.facilityLevels[facility];
  if (current < MAX_FACILITY_LEVEL) {
    const up = scenario.previewTraining(state, facility, { facilityLevel: current + 1 });
    const delta: Partial<Record<Stat, number>> = {};
    for (const stat of STATS) delta[stat] = up.gains[stat] - base.gains[stat];
    const usesLeftToCap = (MAX_FACILITY_LEVEL - current) * USES_PER_LEVEL;
    level = gainValue(state, target, delta, up.skillPoints - base.skillPoints)
      * Math.min(future, usesLeftToCap) / USES_PER_LEVEL;
  }

  // --- the bond term --------------------------------------------------------
  let bond = 0;
  for (const idx of s.placement[facility]) {
    const card = s.cards[idx];
    if (!card || card.stat !== facility || card.bond >= RAINBOW_BOND) continue;
    const distance = RAINBOW_BOND - card.bond;
    const progress = Math.min(1, BOND_GAIN_OWN / distance);

    const cards = s.cards.slice();
    cards[idx] = { ...card, bond: RAINBOW_BOND };
    const glowing = scenario.previewTraining(
      { ...state, scenario: { ...s, cards } }, facility,
    );
    const delta: Partial<Record<Stat, number>> = {};
    for (const stat of STATS) delta[stat] = glowing.gains[stat] - base.gains[stat];
    bond += gainValue(state, target, delta, glowing.skillPoints - base.skillPoints)
      * progress * future;
  }

  return {
    immediate, level, bond,
    energyCost: -base.energy,
    total: immediate + level + bond,
  };
}

/**
 * What a point of energy is worth to this run, in the same units as everything
 * else.
 *
 * Energy is not free and a greedy score that ignores it will always pick the
 * facility with the biggest number on it -- which is the one that drains 26
 * energy and forces a Rest two turns later. A Rest costs a whole turn and buys
 * back `REST_ENERGY_MEAN` energy, so a point of energy is worth one turn's
 * training divided by that. Both halves come from the run itself: the mean of
 * the values just computed for its own facilities, and the scenario's own rest
 * gain.
 *
 * This is why Wit is the right click on a tired turn even when its stat gain is
 * small -- it REFUNDS energy, so its energy term is a credit rather than a
 * charge, and at low energy that credit is the largest term on the board.
 */
export function priceEnergy(values: TrainingValue[]): number {
  if (values.length === 0) return 0;
  const mean = values.reduce((a, v) => a + v.total, 0) / values.length;
  return mean / REST_ENERGY_MEAN;
}


/**
 * Choose the facility with the highest total value.
 *
 * Wraps a base policy rather than replacing it: whatever `base` decides about
 * resting, recreation and racing stands, because those are energy and mood
 * decisions and this has nothing to say about them. It only ever changes WHICH
 * facility a training goes to.
 *
 * Measured against `competentPolicy` on a real six-card deck, 300 paired
 * careers: 2871 total stats against 2770, +100, se 15, t=6.5.
 *
 * THE GAIN IS THE ENERGY TERM. Without it the same argmax LOSES 61 points,
 * because a score that reads only the stat gain always picks the facility with
 * the biggest number on it -- which is the one that drains 26 energy and forces
 * a Rest two turns later. That is worth stating plainly: the bond and level
 * terms alone did not beat the hand-set weights they replaced. Pricing energy
 * did, and it did it by finding four more trainings a career (61.3 against
 * 57.6) rather than better ones.
 *
 * NOT THE DEFAULT, DELIBERATELY. The same 300 careers buy 5.87 songs against
 * 8.02 and 18.2 techniques against 23.9, and end with MORE performance tokens
 * unspent (728 against 635). It concentrates into Wit -- the facility that
 * refunds energy -- which pays mental and passion, and then cannot afford a
 * board asking for dance and visual. So the +100 is a trade: stat points for
 * lessons. The model prices that trade as a win, and the model is known to
 * under-price lessons, because Concert Bonus opcodes are not decoded and are
 * currently worth zero (see `buy`). Until they are, this is offered rather than
 * imposed.
 *
 * The stranded tokens are the finding worth chasing next, and they are not a
 * song problem: both policies leave 600-700 points unspendable at the end of a
 * career because a concentrated deck earns two currencies and the shop asks for
 * five.
 */
export function valuePolicy(base: Policy, target: CompiledTarget): Policy {
  return (state, ctx: PolicyContext) => {
    const action = base(state, ctx);
    if (action.kind !== "train") return action;
    const { scenario } = ctx;

    // Reusing the base policy's own failure threshold rather than inventing a
    // second one, so the two disagree about preference only, never legality.
    const FAILURE_LIMIT = 0.15;
    const candidates = STATS.filter(
      (f) => scenario.failureChanceFor(state, f) <= FAILURE_LIMIT,
    );
    if (candidates.length === 0) return action;

    const values = candidates.map((f) => trainingValue(scenario, state, f, target));
    const energyPrice = priceEnergy(values);

    let best = action.facility;
    let bestScore = -Infinity;
    candidates.forEach((facility, i) => {
      const v = values[i]!;
      const survive = 1 - scenario.failureChanceFor(state, facility);
      const score = (v.total - v.energyCost * energyPrice) * survive;
      if (score > bestScore) { bestScore = score; best = facility; }
    });
    return { kind: "train", facility: best };
  };
}
