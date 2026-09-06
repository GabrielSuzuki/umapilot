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
 */

import { mulberry32, type Rng } from "../rng";
import type { GrandConcertScenario, GcRunState } from "../scenarios/grand-concert";
import type { ShopAction } from "../scenario";
import type { Policy } from "../policy";
import { focusedPolicy, competentPolicy } from "../policy";
import type { Stat } from "../../../data/src/types";
import {
  shortfallScore, meetsTarget, goalEstimate,
  type CompiledTarget, type GoalEstimate,
} from "./objective";

/** Hard stop so a modelling bug cannot hang the caller. */
const MAX_TURNS = 300;

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
 * Spend performance tokens greedily: songs first, then techniques.
 *
 * Songs first because a song carries a permanent per-training bonus and counts
 * toward the Great Success gate, so holding tokens past an affordable song
 * throws away compounding. This is knowingly not optimal -- *which* song and
 * *when* is the Layer B question the beam search exists to answer, and this
 * rule is only what the rollout does after the search's horizon runs out.
 *
 * Exported because the CLI's projection uses the same rule, and a projection
 * whose shopping differs from the planner's rollout is not measuring the same
 * player.
 */
export function greedyShop(
  scenario: GrandConcertScenario,
  state: GcRunState,
  maxBuys: number,
): GcRunState {
  let next = state;
  for (let i = 0; i < maxBuys; i++) {
    const actions = scenario.legalShopActions(next);
    const pick = actions.find((a) => a.kind === "song") ?? actions.find((a) => a.kind === "technique");
    if (!pick) break;
    next = scenario.buy(next, pick);
  }
  return next;
}

/** Play from `state` to the end of the career (or `truncateAfter` turns). */
export function rollout(
  scenario: GrandConcertScenario,
  state: GcRunState,
  rng: Rng,
  opts: RolloutOptions,
): GcRunState {
  let cur = state;
  let played = 0;
  let guard = 0;

  while (!scenario.isTerminal(cur) && guard++ < MAX_TURNS) {
    if (opts.truncateAfter > 0 && played >= opts.truncateAfter) break;
    const action = opts.policy(cur, { scenario, target: opts.policyTarget });
    cur = scenario.step(cur, action, rng);
    cur = greedyShop(scenario, cur, opts.maxBuysPerTurn);
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
  rng: Rng,
  opts: RolloutOptions,
): { end: GcRunState; buys: Array<{ turn: number; action: ShopAction }> } {
  let cur = state;
  const buys: Array<{ turn: number; action: ShopAction }> = [];
  let played = 0;
  let guard = 0;

  while (!scenario.isTerminal(cur) && guard++ < MAX_TURNS) {
    if (opts.truncateAfter > 0 && played >= opts.truncateAfter) break;
    cur = scenario.step(cur, opts.policy(cur, { scenario, target: opts.policyTarget }), rng);

    for (let i = 0; i < opts.maxBuysPerTurn; i++) {
      const actions = scenario.legalShopActions(cur);
      const pick = actions.find((a) => a.kind === "song") ?? actions.find((a) => a.kind === "technique");
      if (!pick) break;
      buys.push({ turn: cur.turn, action: pick });
      cur = scenario.buy(cur, pick);
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
 */
export function stateValue(
  scenario: GrandConcertScenario,
  state: GcRunState,
  target: CompiledTarget,
  seed: number,
  samples: number,
  opts: RolloutOptions,
): number {
  if (samples <= 0) return shortfallScore(state, target);
  let total = 0;
  for (let i = 0; i < samples; i++) {
    total += shortfallScore(rollout(scenario, state, mulberry32(seed + i), opts), target);
  }
  return total / samples;
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
    const end = rollout(scenario, state, mulberry32(seed + i), opts);
    if (meetsTarget(end, target)) hits++;
  }
  return goalEstimate(hits, samples);
}

export { focusedPolicy, competentPolicy };
export type { Policy };
