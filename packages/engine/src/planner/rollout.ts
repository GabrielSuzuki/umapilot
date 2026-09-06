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
import { TOKENS, tokenTotal, type Stat, type TokenVector } from "../../../data/src/types";
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
 * Cost lookups, built once per dataset.
 *
 * The shop rule below has to price a technique against the tokens in hand on
 * every purchase, and it runs inside the innermost loop of the search -- tens
 * of thousands of steps per recommendation, several purchases per step. Doing
 * it with a linear scan over 248 techniques inside another scan is quadratic
 * per buy and dominates the entire planner.
 */
interface CostIndex {
  technique: Map<number, TokenVector>;
  songsByCost: Array<{ id: number; cost: TokenVector }>;
}
const COST_INDEX = new WeakMap<object, CostIndex>();

function costIndex(scenario: GrandConcertScenario): CostIndex {
  const key = scenario.dataset as unknown as object;
  const hit = COST_INDEX.get(key);
  if (hit) return hit;

  const technique = new Map<number, TokenVector>();
  for (const t of scenario.dataset.techniques) technique.set(t.id, t.cost);
  const songsByCost = scenario.dataset.songs
    .map((s) => ({ id: s.id, cost: s.cost }))
    .sort((a, b) => tokenTotal(a.cost) - tokenTotal(b.cost));

  const built = { technique, songsByCost };
  COST_INDEX.set(key, built);
  return built;
}

/**
 * Spend performance tokens: songs first, and techniques only out of the surplus
 * above what the next song costs.
 *
 * ---------------------------------------------------------------------------
 * The rule this replaces could not buy a song. Ever.
 * ---------------------------------------------------------------------------
 *
 * The old rule was "songs first, then techniques", which sounds right and is
 * not, because it means *first among whatever is affordable this instant* -- and
 * nothing ever was. Measured over a real 72-turn career on three seeds: a song
 * was affordable on **0 of 72 turns**, every time. Sixty-three techniques
 * bought, roughly 1,500 tokens spent, and the cheapest song in the game costs
 * 42.
 *
 * The mechanism is that a song needs several currencies AT ONCE -- the cheapest
 * is Passion 21 plus Visual 21 -- while techniques are cheap and often
 * single-currency, so they skim each currency away the moment it appears. Bank
 * Passion, a Passion technique takes it, and by the time Visual arrives Passion
 * is short again. The career runs on a treadmill it cannot step off.
 *
 * This was not confined to a test. `greedyShop` is the rollout policy behind
 * every leaf value the beam search computes, so the model's simulated player
 * could not convert tokens into songs, which made a performance token worth
 * only the +5 skill points of a technique, which collapsed every token shadow
 * price and left the entire lesson-shop layer being priced by a shopper who
 * could not shop.
 *
 * The fix reserves the cheapest unowned song's cost and lets techniques spend
 * only what is left over IN EACH CURRENCY. The per-currency part is
 * load-bearing and the obvious phrasing gets it wrong: "may spend a currency
 * once you have enough of it" fails exactly at the boundary, because reaching
 * the threshold in Passion and then spending it back down means Visual arrives
 * to find Passion short again. A trace showed that happening every few turns.
 *
 * It is still a heuristic, and deliberately a modest one. It is NOT trying to
 * shop well -- that is the search's job, and the search can only do it if the
 * policy underneath is not structurally incapable. Measured against the old
 * rule on real data it buys 3-6 songs per career while keeping roughly 90% of
 * the skill points, where reserving without the per-currency surplus buys
 * 10-12 songs and no techniques at all, costing nearly half the SP.
 *
 * KNOWN GAPS, both of which make this less accurate than it looks:
 *   - Techniques gate song unlocks in the real game (a required count before
 *     each new song). `legalShopActions` does not model that gate, so nothing
 *     here can respect it.
 *   - The lesson board offers THREE rotating techniques that refresh on
 *     purchase. `legalShopActions` offers the whole catalogue of 248, so both
 *     this rule and the search are choosing from a menu the player never sees.
 */
/**
 * How short of a board song we will wait for, in total tokens.
 *
 * A training grants roughly 10-25 performance points of one type, so this is
 * about two trainings' patience. It is a ROLLOUT-POLICY constant, invented to
 * sit between two measured pathologies rather than derived from anything -- and
 * it is the search, not this, that is supposed to decide when waiting is worth
 * it. The policy only has to avoid being pathological, since it is the
 * yardstick the search must beat and the estimator behind every leaf value.
 */
const SONG_PATIENCE_TOKENS = 40;

/**
 * Total shortfall on the cheapest unowned song currently ON THE BOARD, or null
 * if there is no song to wait for.
 */
function songShortfall(
  scenario: GrandConcertScenario,
  state: GcRunState,
  index: CostIndex,
): number | null {
  const owned = state.scenario.songsOwned;
  const onBoard = state.scenario.offers;
  const have = state.scenario.tokens;

  let best: number | null = null;
  for (const s of index.songsByCost) {
    if (!onBoard.includes(s.id) || owned.includes(s.id)) continue;
    let short = 0;
    for (const c of TOKENS) short += Math.max(0, s.cost[c] - have[c]);
    if (best === null || short < best) best = short;
  }
  return best;
}

export function greedyShop(
  scenario: GrandConcertScenario,
  state: GcRunState,
  maxBuys: number,
  rng: Rng,
): GcRunState {
  const index = costIndex(scenario);
  let next = state;

  for (let i = 0; i < maxBuys; i++) {
    const actions = scenario.legalShopActions(next);

    const song = actions.find((a) => a.kind === "song");
    if (song) { next = scenario.buy(next, song, rng); continue; }

    // Reserve for a song ON THE BOARD, not for the cheapest in the catalogue.
    //
    // Before the board was modelled, reserving against the catalogue was right:
    // every song was permanently purchasable, so saving for the cheapest one
    // always had a target. With three rotating offers it deadlocks -- the rule
    // holds tokens back for a song that is not on screen and may not be for
    // many turns, refuses every technique in the meantime, and buys nothing at
    // all. Measured: one song across three careers, down from five.
    //
    // Reserving against the board is also the more faithful rule, because the
    // game lets you SCHEDULE an offer you cannot yet afford and shows the
    // shortfall on the point bar. Saving for something you can see is exactly
    // the mechanic; saving for something you cannot is just paralysis.
    const owned = next.scenario.songsOwned;
    const onBoard = next.scenario.offers;
    const reserve = index.songsByCost
      .find((s) => onBoard.includes(s.id) && !owned.includes(s.id))?.cost;
    const have = next.scenario.tokens;

    // A song is on the board but not yet affordable. Whether to wait is the
    // real decision the board creates, and it is easy to get wrong in both
    // directions.
    //
    // Buying ANYTHING redraws all three offers, so purchasing a technique now
    // throws the song away. The first version of this rule always bought
    // rather than stall, and on real data that produced ZERO songs in a
    // 72-turn career: every song that appeared was discarded by the next
    // technique purchase before enough tokens accumulated.
    //
    // The opposite error is worse in a different way -- holding forever for a
    // song priced in a currency the run does not generate, which freezes the
    // board and ends the career with tokens unspent. That was measured too.
    //
    // So: wait only when nearly there. If the shortfall is within one or two
    // trainings' worth of tokens the song will arrive shortly and the wait is
    // cheap; if it is far off, buy and take a fresh board.
    const shortfall = songShortfall(scenario, next, index);
    if (shortfall !== null && shortfall <= SONG_PATIENCE_TOKENS) break;

    const techniques = actions.filter((a) => a.kind === "technique");
    if (techniques.length === 0) break;

    const withinReserve = techniques.find((a) => {
      if (!reserve) return true;
      const cost = index.technique.get(a.id);
      if (!cost) return false;
      return TOKENS.every((c) => cost[c] <= Math.max(0, have[c] - reserve[c]));
    });

    // Never stall. If the reserve blocks everything on the board, buy anyway.
    //
    // This is not a softening of the rule, it is the rule finally meeting the
    // board. Buying is the ONLY thing that redraws the three offers, so a
    // policy that refuses every option does not patiently accumulate tokens --
    // it freezes the board on the song it is saving for and stops the career.
    // Measured on the fixture: zero songs bought and 76 Composure unspent at
    // turn 72, while a song sat on the board unaffordable in a currency the run
    // never generated.
    //
    // Saving for something you can see is the mechanic; refusing to act until
    // it arrives is paralysis, and it is strictly worse than buying the
    // technique and taking a fresh board.
    const tech = withinReserve ?? techniques[0]!;
    next = scenario.buy(next, tech, rng);
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
    cur = greedyShop(scenario, cur, opts.maxBuysPerTurn, rng);
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
      cur = scenario.buy(cur, pick, rng);
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
