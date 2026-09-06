/**
 * The Scenario boundary.
 *
 * Decision (2026-09-05): implement Grand Concert only, but behind this interface
 * so a second scenario can be added without reshaping the engine. The rule is
 * that nothing outside packages/engine/src/scenarios/ may name a specific
 * scenario -- the recommender, the simulator loop and the UI all speak this
 * interface and nothing else.
 *
 * Deliberately NOT generalised yet: the shape below covers what one scenario
 * needs. Widen it when a second scenario forces the issue, not before. An
 * abstraction invented ahead of its second implementation fits neither.
 */

import type { Facility, Stat, StatVector } from "../../data/src/types";
import type { Rng } from "./rng";

// ---------------------------------------------------------------------------
// Turn actions
// ---------------------------------------------------------------------------

/**
 * Everything a turn can be spent on.
 *
 * Rest, recreation and optional races are first-class actions, not an
 * afterthought. They cannot be scored the way training is -- see the note on
 * shadow prices in docs/interaction-design.md. A myopic "expected stats this
 * turn" comparison ranks every training above every rest, because rest yields
 * zero stats. That answer is wrong, and it is wrong structurally rather than by
 * a tuning margin.
 */
export type TurnAction =
  | { kind: "train"; facility: Facility }
  | { kind: "rest" }
  | { kind: "infirmary" }
  /**
   * Recreation. The screen offers a choice of COMPANION, not of venue: the
   * trainee alone, or a friend support card.
   *
   * Going with a friend advances that card's bounded event chain (the "Event
   * Progress" chevrons -- 5 steps for most, 3 for Sasami Anshinzawa). Finishing
   * the chain before the career ends is a real objective, and each step costs a
   * turn that could have been a training. That makes it a deadline-constrained
   * scheduling problem, the same shape as the song unlock gates -- and exactly
   * the kind of thing a myopic recommender gets wrong, because a single outing
   * looks like a wasted turn right up until the chain pays out.
   *
   * `companionCharaId` names the friend; omitted means the solo option.
   * `destination` is the venue the game picks (Riverside / Karaoke / Shrine /
   * Beach), which determines the energy and mood payoff.
   */
  | { kind: "recreation"; companionCharaId?: number; destination?: string }
  | { kind: "race"; raceId?: number };

/**
 * A purchase made in the scenario's shop. Free in turns, paid in whatever
 * currency the scenario uses. Grand Concert's lesson board is the motivating
 * case; other scenarios have their own.
 */
export interface ShopAction {
  kind: string;
  id: number;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** The part of a run every scenario has. */
export interface BaseRunState {
  turn: number;
  stats: StatVector;
  energy: number;
  mood: -2 | -1 | 0 | 1 | 2;
  skillPoints: number;
  /** Skill ids already bought. */
  acquiredSkills: number[];
}

/**
 * A full run state: the common part plus whatever the scenario tracks
 * (Grand Concert: performance tokens, songs owned, techniques bought this phase).
 */
export interface RunState<TScenarioState = unknown> extends BaseRunState {
  scenario: TScenarioState;
}

// ---------------------------------------------------------------------------
// Recommendations
// ---------------------------------------------------------------------------

/**
 * Why the engine likes an action. Surfaced in the UI next to every
 * recommendation -- a recommender you cannot audit is a recommender nobody
 * trusts, and the decomposition is also the fastest way to find engine bugs.
 */
export interface ValueBreakdown {
  /** Projected contribution to the target stats. */
  stats: number;
  /** Value of currency gained, priced by the shop planner's shadow prices. */
  currency: number;
  /** Progress toward support-card bonds / rainbow training. */
  bonds: number;
  /** Skill points and hint value, priced against the skill wishlist. */
  skills: number;
  /** Energy spent, priced at its opportunity cost. */
  energy: number;
}

export interface Recommendation<TAction> {
  action: TAction;
  /** Expected change in the objective. Units are scenario-defined. */
  ev: number;
  /**
   * P(run meets its target | this action, then playing on well).
   * Sampled, so it comes with an interval -- never render it bare.
   */
  goalProbability?: { p: number; ci95: [number, number]; samples: number };
  breakdown: ValueBreakdown;
  /** One line a human can read. */
  rationale: string;
}

/**
 * A forward-looking plan, not just a next click.
 *
 * "Hold tokens now, buy X around turn 31" is falsifiable and teaches the
 * player something; a bare ranked list does neither.
 */
export interface PlanStep {
  turn: number;
  action: ShopAction;
  reason: string;
}

// ---------------------------------------------------------------------------
// The interface
// ---------------------------------------------------------------------------

export interface Scenario<TScenarioState = unknown, TDataset = unknown> {
  readonly id: string;
  readonly displayName: string;
  readonly dataset: TDataset;

  /**
   * Fresh state at turn 1.
   *
   * Takes an optional rng because a scenario may have randomness to resolve
   * before the first decision -- Grand Concert scatters support cards across
   * facilities, and a turn-1 recommendation computed against an empty board is
   * advice about a game state that never occurs. Implementations must be
   * reproducible without one.
   */
  initialState(rng?: Rng): RunState<TScenarioState>;

  /** Turn actions legal right now. */
  legalTurnActions(state: RunState<TScenarioState>): TurnAction[];

  /** Shop purchases affordable and unlocked right now. */
  legalShopActions(state: RunState<TScenarioState>): ShopAction[];

  /**
   * Advance one turn. Must be a pure function of (state, action, rng) so runs
   * are reproducible from a seed -- the whole regression strategy depends on it.
   */
  step(
    state: RunState<TScenarioState>,
    action: TurnAction,
    rng: () => number,
  ): RunState<TScenarioState>;

  /** Apply a shop purchase. Costs no turn. */
  buy(
    state: RunState<TScenarioState>,
    action: ShopAction,
  ): RunState<TScenarioState>;

  isTerminal(state: RunState<TScenarioState>): boolean;
}

export type { Stat, Facility, StatVector };
