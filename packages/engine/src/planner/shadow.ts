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
 * effect. Every function here pairs its samples -- and the pairing is only real
 * because `rollout` addresses its draws by turn; see the note there.
 *
 * A PRICE CARRIES ITS OWN ERROR BAR, AND IS WEIGHTED BY IT.
 *
 * This file used to return five bare numbers, in a project whose stated rule is
 * that a sampled quantity is never rendered without an interval. The prices are
 * the most heavily sampled quantities in the planner and were the only ones
 * exempt, and the exemption cost something specific and measurable.
 *
 * Measured on real data at 12 samples: the true energy price is about 0.0002
 * objective units per point, and a single estimate of it has a standard error
 * of roughly the same size. So the ESTIMATE'S SIGN is close to a coin flip --
 * across nine states of one career it came back negative on four. `resourceValue`
 * then multiplies that number by an energy stock of 20-80, which turns a coin
 * flip into a +/-0.03 term added to interior scores whose real differences are
 * about +/-0.007. The beam was pruning on noise, four times louder than the
 * signal, and the interior ranking of rest against training disagreed with a
 * 200-rollout ground truth on four states out of nine.
 *
 * Reading that as "energy is priced too high" is the trap: the draw is just as
 * often negative, and a session spent chasing the price downward would have been
 * chasing half of a symmetric distribution. It is a variance problem.
 *
 * So each price is now shrunk toward zero by its own measured signal-to-noise,
 * w = m^2 / (m^2 + se^2): a price measured cleanly is used at face value, a
 * price indistinguishable from zero is used as nearly zero, and the search falls
 * back to ordering by shortfall alone rather than by a random number times a
 * stock. There is no tuning constant in that -- w is computed from the samples
 * every time, and both the unshrunk value and the standard error are reported.
 */

import { TOKENS, type Token, type TokenVector } from "../../../data/src/types";
import type { GrandConcertScenario, GcRunState } from "../scenarios/grand-concert";
import type { CompiledTarget } from "./objective";
import { stateSamples, type RolloutOptions } from "./rollout";

/** One price per resource, in objective units per unit of that resource. */
export interface PriceVector {
  energy: number;
  mood: number;
  tokens: TokenVector;
  bond: number;
  skillPoint: number;
}

export interface ShadowPrices extends PriceVector {
  /**
   * Standard error of each price, same units.
   *
   * Read this before reading the price. An `energy` of 0.0006 with an `stderr`
   * of 0.0005 is not a finding about energy, it is one draw from a distribution
   * that straddles zero.
   */
  stderr: PriceVector;
  /** The finite differences before shrinkage, for auditing the estimator. */
  raw: PriceVector;
  /** How the prices were obtained, so a caller never mistakes them for constants. */
  method: {
    samples: number;
    deltas: { energy: number; mood: number; token: number; bond: number; skillPoint: number };
    /** Shrinkage weight actually applied to each price, in [0, 1]. */
    weights: PriceVector;
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

/** A price, what it is worth on its own evidence, and how that was judged. */
interface Priced {
  /** The price to use: `raw`, shrunk by `weight`. */
  value: number;
  se: number;
  raw: number;
  weight: number;
}

/**
 * Mean of the paired differences, shrunk toward zero by its own signal-to-noise.
 *
 * w = m^2 / (m^2 + se^2) is the posterior weight on the measurement when the
 * prior on the price is centred at zero with a scale of about the measurement
 * itself -- the honest statement of "I have no idea what this is worth except
 * what I just measured". It needs no tuning constant, it goes to 1 as the
 * measurement sharpens, and it goes to 0 exactly when the estimate is
 * indistinguishable from noise.
 *
 * Shrinking toward ZERO specifically, rather than toward some prior price, is
 * the conservative direction: a price of zero makes the beam order interior
 * nodes by shortfall alone, which is a worse search but never a search steered
 * by a random number.
 */
function shrink(diffs: number[]): Priced {
  const n = diffs.length;
  const m = diffs.reduce((a, b) => a + b, 0) / n;
  if (n < 2) return { value: m, se: 0, raw: m, weight: 1 };
  const variance = diffs.reduce((a, b) => a + (b - m) ** 2, 0) / (n - 1);
  const se = Math.sqrt(variance / n);
  const w = se === 0 ? 1 : (m * m) / (m * m + se * se);
  return { value: m * w, se, raw: m, weight: w };
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
  //
  // The difference is taken SAMPLE BY SAMPLE rather than between the two means.
  // Arithmetically that is the same number; statistically it is the difference
  // between having an error bar and not having one, because the spread of the
  // paired differences is what says whether the price is measured or guessed.
  const price = (bump: Bump, salt: number): Priced => {
    if (bump.applied === 0) return { value: 0, se: 0, raw: 0, weight: 0 };
    const s = seed + salt * 100003;
    const base = stateSamples(scenario, state, target, s, samples, ro);
    const bumped = stateSamples(scenario, bump.state, target, s, samples, ro);
    const diffs = base.map((b, i) => (bumped[i]! - b) / bump.applied);
    return shrink(diffs);
  };

  const priced = {
    energy: price(bumpEnergy(state, D_ENERGY), 1),
    mood: price(bumpMood(state, D_MOOD), 2),
    bond: price(bumpBond(state, D_BOND), 3),
    skillPoint: price(bumpSkillPoints(state, D_SP), 4),
    tokens: {} as Record<Token, Priced>,
  };
  TOKENS.forEach((t, i) => {
    priced.tokens[t] = price(bumpToken(state, t, D_TOKEN), 10 + i);
  });

  const pick = (f: (p: Priced) => number): PriceVector => {
    const tokens = {} as TokenVector;
    for (const t of TOKENS) tokens[t] = f(priced.tokens[t]);
    return {
      energy: f(priced.energy), mood: f(priced.mood), tokens,
      bond: f(priced.bond), skillPoint: f(priced.skillPoint),
    };
  };

  return {
    ...pick((p) => p.value),
    stderr: pick((p) => p.se),
    raw: pick((p) => p.raw),
    method: {
      samples,
      deltas: { energy: D_ENERGY, mood: D_MOOD, token: D_TOKEN, bond: D_BOND, skillPoint: D_SP },
      weights: pick((p) => p.weight),
      note:
        "finite differences on paired rollouts under common random numbers; " +
        "a resource already at its ceiling is perturbed downward instead, and " +
        "the price is divided by the delta actually applied; units are " +
        "objective-score per resource unit, valid near this state only. " +
        "Each price is shrunk toward zero by its own signal-to-noise, " +
        "w = m^2/(m^2+se^2), so a price that cannot be distinguished from zero " +
        "at this sample count contributes almost nothing to the search instead " +
        "of contributing a random number times a resource stock; `raw` holds " +
        "the unshrunk difference and `stderr` the error bar it was judged by. " +
        "A price of exactly zero usually means the resource is not binding " +
        "here: energy at the last turn, or a token whose supply already exceeds " +
        "what the shop can absorb.",
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
  const zero = (): PriceVector => ({
    energy: 0, mood: 0, bond: 0, skillPoint: 0,
    tokens: { dance: 0, passion: 0, vocal: 0, visual: 0, mental: 0 },
  });
  return {
    ...zero(),
    stderr: zero(),
    raw: zero(),
    method: { samples: 0, deltas: { energy: 0, mood: 0, token: 0, bond: 0, skillPoint: 0 },
      weights: zero(),
      note: "shadow pricing disabled -- interior ordering is greedy" },
  };
}
