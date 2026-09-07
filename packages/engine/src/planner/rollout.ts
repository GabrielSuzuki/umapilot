/**
 * Playing a partial run out to the end.
 *
 * Everything the planner claims rests on this: a state is worth whatever the
 * rest of the career is worth from it, and the only way to find that out with
 * this model is to play it. A rollout is the leaf evaluation for the beam, the
 * baseline the search must beat, and the estimator behind every reported
 * probability.
 *
 * The rollout policy is NOT the recommender. It is the fast, plausible,
 * good-enough player the search assumes will take over after the horizon. Its
 * job is to be unbiased about which state is better, not to play well in
 * absolute terms -- a rollout policy that is uniformly mediocre still ranks
 * states correctly, while one that is mediocre only when tired systematically
 * undervalues energy.
 *
 * RANDOMNESS IS ADDRESSED, NOT STREAMED. A rollout does not hold one generator
 * for its whole life. Each turn draws from a generator derived from
 * (seed, turn), and the shop draws from a second one derived from
 * (seed, turn, salt).
 *
 * That is the difference between common random numbers working and merely being
 * claimed. Two rollouts compared under one sequential generator -- a baseline
 * and a state with ten more energy, say -- stay in step only until the first
 * turn where they act differently. A training draws a failure roll and a token
 * roll; a rest draws one number. One divergence at turn 3 shifts every draw
 * after it, so by turn 10 the two runs are seeing unrelated placements and the
 * measured difference is mostly noise. Addressing the draws by turn means a
 * divergence costs only that turn: at turn t+1 both runs are back on the same
 * numbers. What is left in the difference is the decision's real consequence.
 *
 * This is what shadow prices and leaf values are differences OF, so it is the
 * foundation both of them rest on.
 */

import { mulberry32, type Rng } from "../rng";
import type { GrandConcertScenario, GcRunState } from "../scenarios/grand-concert";
import type { ShopAction } from "../scenario";
import type { Policy } from "../policy";
import { focusedPolicy, competentPolicy } from "../policy";
import { TOKENS, type Stat } from "../../../data/src/types";
import {
  shortfallScore, meetsTarget, goalEstimate,
  type CompiledTarget, type GoalEstimate,
} from "./objective";

/** Hard stop so a modelling bug cannot hang the caller. */
const MAX_TURNS = 300;

/**
 * The generator for one turn of one rollout.
 *
 * Keyed by the GAME turn rather than by how many steps this rollout has taken,
 * so two rollouts that reach turn 40 by different routes still draw the same
 * numbers there. `salt` separates the streams that must not share draws within
 * a turn -- the turn itself and the shop that follows it.
 */
export function turnRng(seed: number, turn: number, salt: number): Rng {
  // Mixing rather than adding: mulberry32 is a counter-based generator, so
  // seeds that differ by one produce sequences that differ by one step, and
  // "the same numbers, offset by one" is precisely the failure being fixed.
  let h = (seed ^ Math.imul(turn + 1, 0x9e3779b1) ^ Math.imul(salt + 1, 0x85ebca6b)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b) >>> 0;
  return mulberry32((h ^ (h >>> 16)) >>> 0);
}

export interface RolloutOptions {
  policy: Policy;
  /** Stat targets passed through to the policy, which uses them to steer. */
  policyTarget: Partial<Record<Stat, number | null>>;
  /** Buys per turn during a rollout. */
  maxBuysPerTurn: number;
  /** Stop after this many turns instead of at career end. 0 = play to the end. */
  truncateAfter: number;
}

export const DEFAULT_ROLLOUT: Omit<RolloutOptions, "policyTarget"> = {
  policy: competentPolicy,
  maxBuysPerTurn: 4,
  truncateAfter: 0,
};

/**
 * Spend performance tokens: buy what is on the board, songs first.
 *
 * ---------------------------------------------------------------------------
 * This used to be much more elaborate, and all of it was compensating for a
 * wrong model of the board.
 * ---------------------------------------------------------------------------
 *
 * Three successive fixes lived here: reserve the cheapest unowned song's cost
 * and spend only the per-currency surplus above it; reserve against the board
 * rather than the catalogue; and wait for a board song when nearly affordable
 * rather than buying past it. Each fixed a real, measured pathology -- zero
 * songs in a career, then zero techniques, then zero songs again.
 *
 * Every one of those pathologies was an artifact of believing a board could
 * mix songs and techniques. It cannot: a board is entirely one or the other,
 * measured over 60 captured boards. So the situations all that machinery
 * existed to arbitrate -- "should I spend on a technique when a song I want is
 * also available?" -- never actually arise. On a technique board there is no
 * song to reserve for; on a song board there is no technique to buy instead.
 *
 * The proof is that it stopped changing anything. With the board modelled
 * correctly, the elaborate rule and the naive "songs first, then techniques"
 * rule produce byte-identical careers: 5 songs, 10 techniques, SP 363 for both.
 *
 * So it is gone. What remains is the rule this project started with, which was
 * never wrong about preference -- only about what it was choosing between.
 *
 * ---------------------------------------------------------------------------
 * ONE THING IT WAS STILL ARBITRARY ABOUT: WHICH CURRENCY IT SPENDS
 * ---------------------------------------------------------------------------
 *
 * When two or three techniques are affordable the choice between them was the
 * board's order, which is nothing. It matters because a run's currencies are
 * wildly unequal: on a frozen turn `competentPolicy` holds 213 performance
 * points against a cheapest offer of 35, and 75% of what it holds is in
 * currencies that offer cannot use (`stranded-tokens.md`). Spending a scarce
 * currency when an abundant one would have done is pure waste, and choosing not
 * to costs nothing at all -- same turn, same board, same purchase count this
 * turn, same stats per training.
 *
 * So among affordable techniques this takes the one leaving the healthiest
 * balance behind: maximise the smallest per-currency holding after paying.
 * Songs still come first and are never reordered -- they are worth more and
 * their cost is not optional.
 *
 * MEASURED, n=2500 careers, real deck, `competentPolicy`:
 *
 *     purchases     28.3 -> 29.1   +0.8   t 4.52
 *     songs          7.1 ->  7.4   +0.2   t 4.63
 *     tokens unspent 299 ->  279   -19.4  t -4.57
 *     frozen turns  59.9 -> 59.6   -0.3   t -3.23
 *     final stats   2271 -> 2278   +6.8   t 1.25   95% CI -3.9..17.4
 *
 * The mechanism is confirmed; the STAT effect is not, and is stated that way on
 * purpose. This is here because it is free and strictly better reasoning, not
 * because it was shown to win a career. Do not quote the +6.8.
 */
export function greedyShop(
  scenario: GrandConcertScenario,
  state: GcRunState,
  maxBuys: number,
  rng: Rng,
): GcRunState {
  let next = state;
  for (let i = 0; i < maxBuys; i++) {
    const actions = scenario.legalShopActions(next);
    const pick =
      actions.find((a) => a.kind === "song") ?? thriftiest(scenario, next, actions);
    // Nothing affordable on the board. Buying is the only thing that redraws
    // it, so this waits -- which is what the game makes you do too.
    if (!pick) break;
    next = scenario.buy(next, pick, rng);
  }
  return next;
}

/**
 * Of the affordable techniques, the one that leaves the largest smallest
 * remaining balance -- i.e. that spends what this run has most of.
 *
 * Ties keep board order, so this stays a total order and the rollout stays a
 * pure function of its seed.
 */
function thriftiest(
  scenario: GrandConcertScenario,
  state: GcRunState,
  actions: ShopAction[],
): ShopAction | undefined {
  const held = state.scenario.tokens;
  let board: ReturnType<GrandConcertScenario["offersOnBoard"]> | null = null;
  let best: ShopAction | undefined;
  let bestFloor = -Infinity;
  for (const a of actions) {
    if (a.kind !== "technique") continue;
    board ??= scenario.offersOnBoard(state);
    const cost = board.find(
      (o) => o.action.kind === "technique" && o.action.id === a.id,
    )?.cost;
    if (!cost) continue;
    let floor = Infinity;
    for (const t of TOKENS) floor = Math.min(floor, held[t] - cost[t]);
    if (floor > bestFloor) { bestFloor = floor; best = a; }
  }
  return best;
}

/**
 * Play from `state` to the end of the career (or `truncateAfter` turns).
 *
 * Takes a SEED, not a generator, because the stream discipline is part of what
 * a rollout is: the caller cannot supply a generator without also supplying the
 * sequential coupling this is built to avoid.
 */
export function rollout(
  scenario: GrandConcertScenario,
  state: GcRunState,
  seed: number,
  opts: RolloutOptions,
): GcRunState {
  let cur = state;
  let played = 0;
  let guard = 0;

  while (!scenario.isTerminal(cur) && guard++ < MAX_TURNS) {
    if (opts.truncateAfter > 0 && played >= opts.truncateAfter) break;
    const action = opts.policy(cur, { scenario, target: opts.policyTarget });
    const turn = cur.turn;
    cur = scenario.step(cur, action, turnRng(seed, turn, 0));
    cur = greedyShop(scenario, cur, opts.maxBuysPerTurn, turnRng(seed, turn, 1));
    played++;
  }
  return cur;
}

/**
 * A rollout that records what it bought and when.
 *
 * The searched prefix is only `horizon` turns long, so a plan built from it
 * alone stops at turn 6 and shows nothing about the songs the run will actually
 * want -- which is most of what a player wants from a plan. Worse, when a
 * purchase is worth the same as holding (which it currently is, because song
 * effects are undecoded), the beam has no reason to put a buy on its best path
 * at all, and the plan comes back empty on a run that will certainly buy things.
 *
 * So the schedule is the searched buys followed by the buys the fallback policy
 * projects. The two are labelled differently where they surface, because they
 * are not equally trustworthy: one was chosen by the search, the other is what
 * a greedy shopper would do.
 */
export function rolloutTrace(
  scenario: GrandConcertScenario,
  state: GcRunState,
  seed: number,
  opts: RolloutOptions,
): { end: GcRunState; buys: Array<{ turn: number; action: ShopAction }> } {
  let cur = state;
  const buys: Array<{ turn: number; action: ShopAction }> = [];
  let played = 0;
  let guard = 0;

  while (!scenario.isTerminal(cur) && guard++ < MAX_TURNS) {
    if (opts.truncateAfter > 0 && played >= opts.truncateAfter) break;
    const turn = cur.turn;
    cur = scenario.step(cur, opts.policy(cur, { scenario, target: opts.policyTarget }), turnRng(seed, turn, 0));

    const shopRng = turnRng(seed, turn, 1);
    for (let i = 0; i < opts.maxBuysPerTurn; i++) {
      const actions = scenario.legalShopActions(cur);
      const pick = actions.find((a) => a.kind === "song") ?? actions.find((a) => a.kind === "technique");
      if (!pick) break;
      buys.push({ turn: cur.turn, action: pick });
      cur = scenario.buy(cur, pick, shopRng);
    }
    played++;
  }
  return { end: cur, buys };
}

/**
 * The value of a state: the mean score of `samples` rollouts from it.
 *
 * `seed` is the caller's, and every sample uses `seed + i`. That is not an
 * implementation detail -- it is what lets two states be compared under
 * *identical* luck. Comparing a baseline against a perturbed state with
 * independent randomness buries a small real difference under sampling noise;
 * comparing them under the same seeds cancels most of that noise out. Every
 * shadow price in this planner depends on it.
 *
 * The cancelling is only real because `rollout` addresses its draws by turn.
 * Sharing a seed between two states that then consume one sequential generator
 * at different rates cancels nothing past the first divergence, which is how
 * this estimator came to be read off noise once already.
 */
export function stateValue(
  scenario: GrandConcertScenario,
  state: GcRunState,
  target: CompiledTarget,
  seed: number,
  samples: number,
  opts: RolloutOptions,
): number {
  const xs = stateSamples(scenario, state, target, seed, samples, opts);
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/**
 * The individual sample scores behind `stateValue`.
 *
 * Exposed because a mean without its spread is exactly the thing this planner
 * keeps getting wrong: the caller that differences two of these needs to know
 * how much of the difference is real. Sample `i` uses `seed + i` on both sides,
 * so callers can pair them.
 */
export function stateSamples(
  scenario: GrandConcertScenario,
  state: GcRunState,
  target: CompiledTarget,
  seed: number,
  samples: number,
  opts: RolloutOptions,
): number[] {
  if (samples <= 0) return [shortfallScore(state, target)];
  const out: number[] = [];
  for (let i = 0; i < samples; i++) {
    out.push(shortfallScore(rollout(scenario, state, seed + i, opts), target));
  }
  return out;
}

/**
 * P(target met) from `state`, by sampling.
 *
 * The headline number. It comes back with an interval and a sample count
 * because a bare percentage from a sampled estimator is false precision, and
 * this project's own design notes say never to render one.
 */
export function goalProbability(
  scenario: GrandConcertScenario,
  state: GcRunState,
  target: CompiledTarget,
  seed: number,
  samples: number,
  opts: RolloutOptions,
): GoalEstimate {
  let hits = 0;
  for (let i = 0; i < samples; i++) {
    const end = rollout(scenario, state, seed + i, opts);
    if (meetsTarget(end, target)) hits++;
  }
  return goalEstimate(hits, samples);
}

export { focusedPolicy, competentPolicy };
export type { Policy };
