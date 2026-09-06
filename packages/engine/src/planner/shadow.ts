/**
 * What a unit of each resource is actually worth, right now.
 *
 * This is the piece the design notes called the elegant part, and it is what
 * makes the recommender a search rather than a scoring heuristic.
 *
 * The problem it solves, restated: a training yields stats now, a rest yields
 * zero stats. Any "expected stats this turn" comparison therefore ranks every
 * training above every rest, always -- structurally, not by a tuning margin. No
 * weight you can pick fixes it, because the value of rest is not stats, it is
 * *energy*, and energy has no value except through the trainings it later buys.
 *
 * So price it by measurement. Take the state, add one unit of the resource,
 * play both out under identical luck, and see what the difference is worth.
 * That number is the resource's shadow price, in the same units as the
 * objective, and it is a fact about this state rather than a constant somebody
 * chose.
 *
 * Three consequences fall out for free:
 *
 *   - Energy, mood and performance tokens are priced by one mechanism, so they
 *     are comparable. Rest, recreation and "hold tokens for a song" become
 *     rankable against training without a fudge factor.
 *   - The prices are time-varying. A mood point in Junior year multiplies
 *     ~60 remaining trainings; in Senior November it multiplies almost none.
 *     Measured prices show that; a constant cannot.
 *   - Token prices are Layer B's dual. "How much is a Visual token worth" is
 *     answered by the same rollouts that value everything else.
 *
 * COMMON RANDOM NUMBERS ARE LOAD-BEARING. The perturbation is one energy point
 * against a career whose outcome varies by hundreds of stat points between
 * seeds. Measured with independent randomness the signal is invisible. Measured
 * with the same seeds on both sides, the noise cancels and what is left is the
 * effect. Every function here pairs its samples.
 */

import { TOKENS, type Token, type TokenVector } from "../../../data/src/types";
import type { GrandConcertScenario, GcRunState } from "../scenarios/grand-concert";
import type { CompiledTarget } from "./objective";
import { stateValue, type RolloutOptions } from "./rollout";

export interface ShadowPrices {
  /** Objective units per energy point. */
  energy: number;
  /** Objective units per mood step. */
  mood: number;
  /** Objective units per token, per currency. */
  tokens: TokenVector;
  /** Objective units per bond point, summed across the deck. */
  bond: number;
  /** Objective units per skill point. */
  skillPoint: number;
  /** How the prices were obtained, so a caller never mistakes them for constants. */
  method: {
    samples: number;
    deltas: { energy: number; mood: number; token: number; bond: number; skillPoint: number };
    note: string;
  };
}

export interface ShadowOptions {
  /** Paired rollouts per side of each difference. */
  samples: number;
  seed: number;
  rollout: RolloutOptions;
}

/**
 * Perturbation sizes.
 *
 * Large enough that the effect clears the residual noise the paired seeds do
 * not cancel, small enough to stay in the locally-linear region. A one-point
 * energy bump is not measurable at any affordable sample count; ten is, and the
 * result is divided back down to a per-unit price.
 */
const D_ENERGY = 10;
const D_MOOD = 1;
const D_TOKEN = 25;
const D_BOND = 5;
const D_SP = 100;

/**
 * A perturbation, and the amount that was actually applied.
 *
 * The distinction matters more than it looks. Energy starts a career at 100,
 * which is its ceiling, so "add 10 energy" applies zero -- and the price comes
 * back as a flat 0.0 for the single most important state the planner will ever
 * be asked about. That is not "energy is worthless at turn 1", it is the
 * measurement silently not happening, and it is indistinguishable from the real
 * zero at turn 72 unless the applied delta is tracked.
 *
 * So every bump reports what it managed to apply, and a resource already at its
 * ceiling is perturbed DOWNWARD instead. The price of losing a unit and the
 * price of gaining one are the same quantity to first order, which is exactly
 * the regime finite differences assume.
 */
interface Bump {
  state: GcRunState;
  /** Signed, and never zero unless the resource cannot move at all. */
  applied: number;
}

/** Move `value` by `by`, flipping direction if that would clip against a bound. */
function signedDelta(value: number, by: number, lo: number, hi: number): number {
  if (value + by <= hi) return by;
  if (value - by >= lo) return -by;
  // Pinned between the bounds: take whatever room exists, in either direction.
  const up = hi - value;
  const down = lo - value;
  return Math.abs(up) >= Math.abs(down) ? up : down;
}

function bumpEnergy(state: GcRunState, by: number): Bump {
  const d = signedDelta(state.energy, by, 0, 100);
  return {
    state: { ...state, stats: { ...state.stats }, energy: state.energy + d },
    applied: d,
  };
}

function bumpMood(state: GcRunState, by: number): Bump {
  const d = signedDelta(state.mood, by, -2, 2);
  return {
    state: { ...state, stats: { ...state.stats }, mood: (state.mood + d) as GcRunState["mood"] },
    applied: d,
  };
}

function bumpToken(state: GcRunState, token: Token, by: number): Bump {
  const s = state.scenario;
  const d = signedDelta(s.tokens[token], by, 0, s.tokenCaps[token]);
  return {
    state: {
      ...state,
      stats: { ...state.stats },
      scenario: { ...s, tokens: { ...s.tokens, [token]: s.tokens[token] + d } },
    },
    applied: d,
  };
}

/**
 * Bond is per-card and clips at 100, so the applied amount is the SUM of what
 * each card could actually take. A deck where every card is already at 100 has
 * a bond price of zero, and that is the true answer.
 */
function bumpBond(state: GcRunState, by: number): Bump {
  const s = state.scenario;
  let applied = 0;
  const cards = s.cards.map((c) => {
    const d = signedDelta(c.bond, by, 0, 100);
    applied += d;
    return { ...c, bond: c.bond + d };
  });
  return {
    state: { ...state, stats: { ...state.stats }, scenario: { ...s, cards } },
    applied,
  };
}

function bumpSkillPoints(state: GcRunState, by: number): Bump {
  return {
    state: { ...state, stats: { ...state.stats }, skillPoints: state.skillPoints + by },
    applied: by,
  };
}

/**
 * Price every resource at this state.
 *
 * Cost is `(2 + 2*5 + 2 + 2 + 2) * samples` rollouts -- one paired difference
 * per resource, five of them tokens. At the default sample count that is the
 * single most expensive thing the planner does, and it is done once per
 * recommendation rather than once per node, which is why the beam can afford to
 * use the answer as its heuristic.
 *
 * A price can legitimately come back at or below zero. Energy is worth nothing
 * at turn 72 because there is nothing left to spend it on, and a token you can
 * no longer convert into a purchase before the last concert is worth nothing
 * either. Those zeroes are information -- they are exactly when the tool should
 * stop telling you to rest.
 */
export function shadowPrices(
  scenario: GrandConcertScenario,
  state: GcRunState,
  target: CompiledTarget,
  opts: ShadowOptions,
): ShadowPrices {
  const { samples, seed, rollout: ro } = opts;

  // One shared seed base per resource: baseline and perturbed use the SAME
  // seeds, so the two rollouts see the same failures, the same token rolls and
  // the same card placements. Without this the difference is noise.
  const price = (bump: Bump, salt: number): number => {
    if (bump.applied === 0) return 0;
    const s = seed + salt * 100003;
    const base = stateValue(scenario, state, target, s, samples, ro);
    const bumped = stateValue(scenario, bump.state, target, s, samples, ro);
    return (bumped - base) / bump.applied;
  };

  const tokens = {} as TokenVector;
  TOKENS.forEach((t, i) => {
    tokens[t] = price(bumpToken(state, t, D_TOKEN), 10 + i);
  });

  return {
    energy: price(bumpEnergy(state, D_ENERGY), 1),
    mood: price(bumpMood(state, D_MOOD), 2),
    tokens,
    bond: price(bumpBond(state, D_BOND), 3),
    skillPoint: price(bumpSkillPoints(state, D_SP), 4),
    method: {
      samples,
      deltas: { energy: D_ENERGY, mood: D_MOOD, token: D_TOKEN, bond: D_BOND, skillPoint: D_SP },
      note:
        "finite differences on paired rollouts under common random numbers; " +
        "a resource already at its ceiling is perturbed downward instead, and " +
        "the price is divided by the delta actually applied; units are " +
        "objective-score per resource unit, valid near this state only. " +
        "A small NEGATIVE price is residual sampling noise, not a finding -- " +
        "raise the sample count rather than reading meaning into it. A price of " +
        "exactly zero usually means the resource is not binding here: energy at " +
        "the last turn, or a token whose supply already exceeds what the shop " +
        "can absorb.",
    },
  };
}

/**
 * The shadow-priced value of the resources a state is holding.
 *
 * Added to the objective score, this is the potential function the beam uses to
 * order interior nodes. It is the entire reason the search does not collapse
 * into greed: two states with identical stats but different energy, mood, bond
 * and token balances now score differently, and they score differently by a
 * measured amount rather than a chosen one.
 */
export function resourceValue(state: GcRunState, prices: ShadowPrices): number {
  const s = state.scenario;
  let v = 0;
  v += prices.energy * state.energy;
  v += prices.mood * state.mood;
  for (const t of TOKENS) v += prices.tokens[t] * s.tokens[t];
  v += prices.bond * s.cards.reduce((sum, c) => sum + c.bond, 0);
  v += prices.skillPoint * state.skillPoints;
  return v;
}

/** Zero prices. Used when the caller asks for no shadow pass at all. */
export function zeroPrices(): ShadowPrices {
  return {
    energy: 0, mood: 0, bond: 0, skillPoint: 0,
    tokens: { dance: 0, passion: 0, vocal: 0, visual: 0, mental: 0 },
    method: { samples: 0, deltas: { energy: 0, mood: 0, token: 0, bond: 0, skillPoint: 0 },
      note: "shadow pricing disabled -- interior ordering is greedy" },
  };
}
