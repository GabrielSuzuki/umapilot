/**
 * plan() -- the M3 recommender.
 *
 * Takes a run state and a target, returns every action ranked, each with the
 * decomposition that produced its score, plus the shop schedule the search
 * intends to follow and the measured price of every resource.
 *
 * Three things it is careful about, all of them lessons this project already
 * paid for once:
 *
 *   It never returns a bare number. Sampled quantities carry intervals, the
 *   spread across worlds is reported, and when the top two actions cannot be
 *   told apart the result says so instead of drawing an arrow.
 *
 *   It never hides what it assumed. Every assumption the simulator accumulated
 *   rides along, and the planner adds its own -- the search horizon, the
 *   rollout policy, and the fact that song and concert-bonus effects are still
 *   undecoded, which is the largest known hole in the value it computes.
 *
 *   It is a pure function of its inputs and the seed. Same state, same target,
 *   same seed, same recommendation -- otherwise none of it is testable.
 */

import { STATS, TOKENS, type Stat } from "../../../data/src/types";
import type { TurnAction, ShopAction, Recommendation, ValueBreakdown, PlanStep } from "../scenario";
import type { GrandConcertScenario, GcRunState } from "../scenarios/grand-concert";
import { mulberry32 } from "../rng";
import { competentPolicy } from "../policy";
import type { RunTarget } from "../target";
import {
  compileTarget, shortfallScore, shortfallByStat, separable,
  type CompiledTarget, type GoalEstimate, type ObjectiveMode,
} from "./objective";
import { goalProbability, stateValue, rolloutTrace, type RolloutOptions, DEFAULT_ROLLOUT } from "./rollout";
import { shadowPrices, zeroPrices, type ShadowPrices } from "./shadow";
import {
  beamSearch, actionKey, shopPlan,
  DEFAULT_BEAM, type BeamOptions, type PlannedAction,
} from "./beam";

export interface PlanOptions extends Partial<Omit<BeamOptions, "rollout">> {
  /**
   * Which objective decides the ranking.
   *
   *   "shortfall"       -- the fast scalar. Deterministic, no rollout sampling
   *                        at the root. Use for tests and for tuning the beam.
   *   "goalProbability" -- rank by P(target met). The honest objective, and the
   *                        slowest.
   *   "hybrid"          -- default. Rank by the scalar, then report goal
   *                        probability for the top `probabilityFor` actions.
   *                        This is the one to ship: the ranking is cheap, the
   *                        headline number is real, and where they disagree the
   *                        result says so rather than quietly picking one.
   */
  objective?: ObjectiveMode;
  /** Rollouts behind each reported goal probability. */
  probabilitySamples?: number;
  /** How many top actions get a goal probability. */
  probabilityFor?: number;
  /** Paired rollouts per side of each shadow-price difference. 0 disables pricing. */
  shadowSamples?: number;
  rollout?: Partial<RolloutOptions>;
}

export interface PlanResult {
  /** Every action, best first. */
  recommendations: Array<Recommendation<TurnAction>>;
  /** The shop schedule along the best line found. */
  plan: PlanStep[];
  prices: ShadowPrices;
  /**
   * Value of this state with no search: the rollout policy simply playing on.
   * Every `ev` is measured against it, so a positive ev means the search beat
   * doing nothing clever.
   */
  baseline: number;
  /**
   * True when the top two actions are statistically indistinguishable at this
   * sample count. The UI is expected to present them as a tie.
   */
  topIsClear: boolean;
  search: {
    width: number; horizon: number; worlds: number;
    nodesExpanded: number; rollouts: number; ms: number;
    objective: ObjectiveMode;
  };
  assumptions: string[];
  warning?: string;
}

export function plan(
  scenario: GrandConcertScenario,
  state: GcRunState,
  target: RunTarget,
  options: PlanOptions = {},
): PlanResult {
  const t0 = Date.now();
  const compiled = compileTarget(target);

  const policyTarget: Partial<Record<Stat, number | null>> = {};
  for (const stat of STATS) policyTarget[stat] = target.stats[stat];

  const ro: RolloutOptions = {
    ...DEFAULT_ROLLOUT,
    policy: options.rollout?.policy ?? competentPolicy,
    maxBuysPerTurn: options.rollout?.maxBuysPerTurn ?? DEFAULT_ROLLOUT.maxBuysPerTurn,
    truncateAfter: options.rollout?.truncateAfter ?? DEFAULT_ROLLOUT.truncateAfter,
    policyTarget,
  };

  const beamOpts: BeamOptions = {
    width: options.width ?? DEFAULT_BEAM.width,
    horizon: options.horizon ?? DEFAULT_BEAM.horizon,
    worlds: options.worlds ?? DEFAULT_BEAM.worlds,
    maxBuysPerTurn: options.maxBuysPerTurn ?? DEFAULT_BEAM.maxBuysPerTurn,
    leafSamples: options.leafSamples ?? DEFAULT_BEAM.leafSamples,
    seed: options.seed ?? DEFAULT_BEAM.seed,
    companions: options.companions ?? DEFAULT_BEAM.companions,
    rollout: ro,
  };

  const objective: ObjectiveMode = options.objective ?? "hybrid";
  const shadowSamples = options.shadowSamples ?? 6;

  const prices = shadowSamples > 0
    ? shadowPrices(scenario, state, compiled, { samples: shadowSamples, seed: beamOpts.seed, rollout: ro })
    : zeroPrices();

  const result = beamSearch(scenario, state, compiled, prices, beamOpts);

  // `Recommendation.ev` is defined as a CHANGE in the objective, so it has to
  // be measured against something. The baseline is this state's value with no
  // search at all -- the rollout policy simply playing on from here.
  //
  // That makes every number in the ranking readable: a positive ev means the
  // search found something better than just letting a competent player carry
  // on, and a near-zero ev on the top action means the turn does not matter
  // much, which is worth telling the player rather than dressing up as a
  // confident pick. Reporting the raw leaf value instead would look like a
  // score and mean nothing on its own.
  const baseline = stateValue(
    scenario, state, compiled, (beamOpts.seed ^ 0x5f356495) >>> 0, beamOpts.leafSamples, ro,
  );

  // Goal probability for the actions a human will actually look at. Every
  // estimate uses the SAME seed base, so two actions are compared under the
  // same luck rather than on independent draws -- the same reason the shadow
  // prices are paired.
  const probSamples = options.probabilitySamples ?? 120;
  const probFor = options.probabilityFor ?? 3;
  const probSeed = (beamOpts.seed ^ 0x2545f491) >>> 0;
  const wantProb = objective !== "shortfall" && probSamples > 0;

  const recommendations: Array<Recommendation<TurnAction>> = result.roots.map((root, i) => {
    const probe = probeAction(scenario, state, root.action, beamOpts.seed);
    const breakdown = decompose(state, probe, compiled, prices);

    let goal: GoalEstimate | undefined;
    if (wantProb && i < probFor) {
      goal = goalProbability(scenario, probe, compiled, probSeed, probSamples, ro);
    }

    const rec: Recommendation<TurnAction> = {
      action: root.action,
      ev: root.mean - baseline,
      breakdown,
      rationale: explain(root.action, breakdown, root.spread, root.perWorld.length),
    };
    if (goal) rec.goalProbability = goal;
    return rec;
  });

  // If goal probability was computed and it disagrees with the scalar ranking,
  // the probability wins -- it is the objective the project actually claims.
  if (objective === "goalProbability") {
    recommendations.sort((a, b) => (b.goalProbability?.p ?? -1) - (a.goalProbability?.p ?? -1));
  }

  const top = recommendations[0];
  const second = recommendations[1];
  let topIsClear = true;
  if (top && second) {
    if (top.goalProbability && second.goalProbability) {
      topIsClear = separable(top.goalProbability, second.goalProbability);
    } else {
      const gap = top.ev - second.ev;
      const noise = result.roots[0]?.spread ?? 0;
      topIsClear = gap > noise;
    }
  }

  // The schedule the search chose, then the schedule the fallback policy
  // projects for the rest of the career. Both, because the searched half stops
  // at the horizon and a plan that stops at turn 6 answers none of the
  // questions a player has about songs.
  const searched = shopPlan(result.bestPath);
  const projected = result.bestLeaf
    ? rolloutTrace(scenario, result.bestLeaf, mulberry32(result.bestLeafSeed), ro).buys
    : [];

  const steps: PlanStep[] = [
    ...searched.map(({ turn, action }) => ({
      turn, action, reason: shopReason(scenario, action, turn, state, "searched"),
    })),
    ...projected.map(({ turn, action }) => ({
      turn, action, reason: shopReason(scenario, action, turn, state, "projected"),
    })),
  ];

  const assumptions = [
    ...state.scenario.assumptions,
    `search looks ${beamOpts.horizon} turns ahead; beyond that the run is played ` +
      `by a heuristic policy, so long-horizon value is estimated rather than searched`,
    `a song's Mastery Bonus is decoded from the game's own text and applied, but ` +
      `its Concert Bonus is an undecoded opcode and is NOT -- so every song is ` +
      `valued below what it is worth, and songs bought early are undervalued most, ` +
      `because the Concert Bonus is precisely the part whose worth scales with ` +
      `turns remaining. This is the largest known gap in this ranking.`,
    ...(beamOpts.companions.length === 0
      ? ["no companions were declared, so recreation is scored as a solo outing " +
         "and no friend-chain deadline is scheduled"]
      : []),
  ];

  return {
    recommendations,
    plan: steps,
    prices,
    topIsClear,
    baseline,
    search: {
      width: beamOpts.width,
      horizon: beamOpts.horizon,
      worlds: beamOpts.worlds,
      nodesExpanded: result.nodesExpanded,
      rollouts: result.rollouts,
      ms: Date.now() - t0,
      objective,
    },
    assumptions,
    warning:
      "The underlying simulator is calibrated on ONE logged run. Treat the " +
      "ranking as a hypothesis about this model, not a measurement of the game.",
  };
}

// ---------------------------------------------------------------------------
// Explaining a recommendation
// ---------------------------------------------------------------------------

/** One sampled successor, under a fixed seed so every action faces the same luck. */
function probeAction(
  scenario: GrandConcertScenario,
  state: GcRunState,
  action: TurnAction,
  seed: number,
): GcRunState {
  return scenario.step(state, action, mulberry32((seed ^ 0x9e3779b9) >>> 0));
}

/**
 * Split an action's immediate effect into the five channels the UI shows.
 *
 * Everything except `stats` is priced with the measured shadow prices, so the
 * channels are in the SAME units and can be added, compared and argued with.
 * That is the whole point: a recommendation you cannot audit is one nobody
 * trusts, and the decomposition is also the fastest way to find engine bugs --
 * an action whose currency term dwarfs its stat term is either a real finding
 * about token scarcity or a broken price, and either way you want to see it.
 */
function decompose(
  before: GcRunState,
  after: GcRunState,
  target: CompiledTarget,
  prices: ShadowPrices,
): ValueBreakdown {
  const statTerm = shortfallScore(after, target) - shortfallScore(before, target);

  let currency = 0;
  for (const t of TOKENS) {
    currency += prices.tokens[t] * (after.scenario.tokens[t] - before.scenario.tokens[t]);
  }

  const bondBefore = before.scenario.cards.reduce((s, c) => s + c.bond, 0);
  const bondAfter = after.scenario.cards.reduce((s, c) => s + c.bond, 0);

  return {
    stats: statTerm,
    currency,
    bonds: prices.bond * (bondAfter - bondBefore),
    skills: prices.skillPoint * (after.skillPoints - before.skillPoints),
    energy: prices.energy * (after.energy - before.energy) + prices.mood * (after.mood - before.mood),
  };
}

function label(action: TurnAction): string {
  switch (action.kind) {
    case "train": return `Train ${action.facility}`;
    case "rest": return "Rest";
    case "infirmary": return "Infirmary";
    case "race": return "Race";
    case "recreation":
      return action.companionCharaId === undefined
        ? "Recreation (alone)"
        : `Recreation with ${action.companionCharaId}`;
  }
}

function explain(
  action: TurnAction,
  b: ValueBreakdown,
  spread: number,
  worlds: number,
): string {
  const parts: Array<[string, number]> = [
    ["stats", b.stats], ["tokens", b.currency], ["bonds", b.bonds],
    ["skill points", b.skills], ["energy and mood", b.energy],
  ];
  const driver = parts.reduce((a, c) => (Math.abs(c[1]) > Math.abs(a[1]) ? c : a));
  const sign = driver[1] >= 0 ? "gains" : "costs";
  const noise = worlds > 1 ? `, +/- ${spread.toFixed(4)} across ${worlds} worlds` : "";
  return `${label(action)}: mostly ${sign} through ${driver[0]}${noise}.`;
}

/**
 * `searched` steps were chosen by the beam. `projected` steps are what the
 * fallback policy would buy after the horizon runs out. Saying which is which
 * matters: the first is a recommendation, the second is a forecast, and
 * presenting a forecast as advice is how a planner earns distrust.
 */
function shopReason(
  scenario: GrandConcertScenario,
  action: ShopAction,
  turn: number,
  state: GcRunState,
  origin: "searched" | "projected",
): string {
  const how = origin === "searched"
    ? "chosen by the search"
    : "projected past the search horizon by the fallback policy, not chosen";

  if (action.kind === "song") {
    const song = scenario.dataset.songs.find((s) => s.id === action.id);
    const next = scenario.dataset.concerts.find((c) => c.turn >= turn);
    const gate = next
      ? `; ${next.songs_for_great_success} songs are wanted by the concert on turn ${next.turn}`
      : "";
    return `Buy "${song?.name ?? action.id}" around turn ${turn} (${how})${gate}. ` +
      `Its mastery and concert bonuses are NOT yet decoded, so only the ` +
      `great-success gate is being valued here.`;
  }
  const owed = state.scenario.techniquesThisPhase;
  return `Buy a technique around turn ${turn} (${how}; ${owed} bought since the ` +
    `last concert): +5 SP at the next concert, and it counts toward the next song unlock.`;
}

export { compileTarget, shortfallByStat, DEFAULT_BEAM, DEFAULT_ROLLOUT };
export type { PlannedAction, ShadowPrices, GoalEstimate, CompiledTarget, ObjectiveMode };
