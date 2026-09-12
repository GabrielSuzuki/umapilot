/**
 * What the search is trying to maximise.
 *
 * Two objectives, deliberately, because they answer different questions and
 * cost three orders of magnitude apart:
 *
 *   SHORTFALL      A deterministic scalar on a single state. Microseconds.
 *                  Used at every interior node of the beam, where the search
 *                  needs a cheap ordering over thousands of candidates and only
 *                  the *ranking* matters.
 *
 *   GOAL PROBABILITY  P(final build >= target), estimated by rolling the run out
 *                  to turn 72 many times. Milliseconds per action. Used at the
 *                  root, where the number is reported to a human and has to be
 *                  the thing the project actually claims to compute.
 *
 * Using the scalar everywhere would be wrong in a specific way. Goal
 * probability is not monotone in the scalar: once a stat target is met, further
 * gains in that stat are worth exactly nothing to the goal, but a naive sum
 * keeps paying for them. Using goal probability everywhere would be correct and
 * far too slow -- a beam of 64 over 8 turns is thousands of node evaluations,
 * and each sampled estimate needs hundreds of rollouts to have a usable
 * interval.
 *
 * So: the scalar ranks, the probability reports. Where they disagree at the
 * root, the probability wins, and `plan()` says so.
 */

import { STATS, type Stat, type StatVector, type SkillEntry } from "../../../data/src/types";
import type { RunTarget } from "../target";
import type { GcRunState } from "../scenarios/grand-concert";

// ---------------------------------------------------------------------------
// The target, reduced to what scoring needs
// ---------------------------------------------------------------------------

/**
 * A target compiled for fast repeated scoring.
 *
 * `RunTarget` is the user-facing shape. Compiling it once lifts the null checks
 * and the skill lookups out of the inner loop, which runs millions of times.
 */
export interface CompiledTarget {
  /** Stats with a real target, and what it is. */
  wanted: Array<{ stat: Stat; want: number }>;
  /** Total SP the wishlist costs. 0 when the wishlist is empty. */
  skillSpNeeded: number;
  /** 0 = stats only, 1 = skills only. */
  skillWeight: number;
  /**
   * Score stats by race-effective value rather than face value. Set from
   * `StatValueMode`; kept as a boolean because `shortfallScore` reads it once
   * per stat per node, millions of times per plan.
   */
  raceEffective: boolean;
  /**
   * How a point below its target is priced. See `TargetNorm`.
   *
   * Read once per stat per node like `raceEffective`, so it is a compiled field
   * rather than a lookup.
   */
  norm: TargetNorm;
  /**
   * Sum of the targeted goals, in the same units `shortfallScore` compares
   * against them. The denominator for `norm: "points"`; unused by "fraction".
   *
   * Precomputed because it is a constant of the target and the inner loop runs
   * millions of times per plan.
   */
  goalTotal: number;
  /** True when the target constrains nothing -- scoring falls back to stat sum. */
  empty: boolean;
}

export function compileTarget(
  target: RunTarget,
  skillsById?: Map<number, SkillEntry>,
  statValue: StatValueMode = "race-effective",
  norm: TargetNorm = DEFAULT_TARGET_NORM,
): CompiledTarget {
  const raceEffective = statValue === "race-effective";

  const wanted: Array<{ stat: Stat; want: number }> = [];
  let goalTotal = 0;
  for (const stat of STATS) {
    const want = target.stats[stat];
    if (want != null && want > 0) {
      wanted.push({ stat, want });
      goalTotal += raceEffective ? effectiveStat(want) : want;
    }
  }

  let skillSpNeeded = 0;
  if (skillsById) {
    for (const { skillId } of target.skills) {
      const sp = skillsById.get(skillId)?.spCost;
      if (typeof sp === "number") skillSpNeeded += sp;
    }
  }

  return {
    wanted,
    skillSpNeeded,
    skillWeight: target.skills.length === 0 ? 0 : target.skillWeight,
    raceEffective,
    norm,
    goalTotal,
    empty: wanted.length === 0 && skillSpNeeded === 0,
  };
}

// ---------------------------------------------------------------------------
// The fast scalar
// ---------------------------------------------------------------------------

/**
 * Weight on stat progress past the target.
 *
 * Not zero, and not one.
 *
 * Zero makes the objective flat once every target is met, so the search has no
 * reason to prefer a run that finishes 300 points clear of the target over one
 * that scrapes it -- and under noise the second is much likelier to miss. A
 * small positive weight buys margin, which is what actually raises goal
 * probability near the boundary.
 *
 * One is the naive sum, and it is what makes a recommender pour 600 points into
 * a stat with a 400 target while another stat sits short. That failure is the
 * whole reason this project is goal-conditioned rather than score-maximising.
 */
const OVERSHOOT_WEIGHT = 0.08;

/**
 * The race-effective value of a raw stat.
 *
 * Grand Concert raises the caps past 1200, and the game halves everything above
 * that line for race purposes: 1600 Speed is treated as 1400. So the last 400
 * points of a maxed Speed build are worth 200, and a recommender that scores
 * raw stats is overpaying for every one of them.
 *
 * This is NOT a training-gain penalty. You gain the full points; they are worth
 * half when raced. `computeTraining` is therefore right as it stands and must
 * not be changed -- the correction belongs here, in what a build is WORTH.
 *
 * Community-sourced (uma.guide's Grand Concert page), not decoded from
 * master.mdb. It is nonetheless the DEFAULT, by the user's decision on
 * 2026-09-07: this tool exists to build racers, and a scoreboard that pays full
 * price for points a race pays half for is answering a question nobody asked.
 * `statValue: "raw"` restores face-value scoring for the cases where the
 * displayed number is the point -- a spark to pass down, or a target set for
 * the number itself.
 */
export const HALVING_THRESHOLD = 1200;

export function effectiveStat(raw: number): number {
  return raw <= HALVING_THRESHOLD
    ? raw
    : HALVING_THRESHOLD + (raw - HALVING_THRESHOLD) / 2;
}

/**
 * How a stat point is priced when scoring a build.
 *
 *   "race-effective"  the default. Everything above 1200 counts half, because
 *                     that is what a race does with it.
 *   "raw"             face value, which is what the game displays and what a
 *                     spark passes down.
 *
 * This changes what a point is WORTH, never what a target MEANS. A target is
 * always the raw number the player typed and the game will show them; the mode
 * decides how progress toward it is valued. Because `effectiveStat` is strictly
 * increasing, the point at which a target is *met* is identical either way --
 * see `meetsTarget`. What moves is the gradient: past 1200 the search sees the
 * next point as worth half, which is the whole reason to have this.
 */
export type StatValueMode = "race-effective" | "raw";

/**
 * What a stat target MEANS to the objective -- the per-point price the search
 * bids with.
 *
 *   "fraction"  the original. Score each stat as `min(1, have/goal)` and take
 *               the mean, so every TARGET is worth the same share of the score
 *               and one raw point is worth `1/goal`.
 *
 *   "points"    the default. Score `sum(min(have, goal)) / sum(goal)`, so every
 *               POINT below a target is worth the same and a target is worth a
 *               share proportional to its size.
 *
 * `1/goal` was not a coding error; it was a modelling choice nobody had priced,
 * and measurement in `replay-validation.md` Part 3 is what priced it. Under a
 * speed 700 / guts 200 target it makes a guts point worth **3.5x** a speed
 * point, while the simulator's own measured yields say a speed training pays
 * **1.8x** a guts training. The objective outbid its own yield model, and the
 * visible consequence was the search naming facilities the player's deck can
 * never rainbow on 78% of turns -- a number that collapsed to 18% the moment
 * the cheap denominators were removed.
 *
 * So the defect is specific: **the size of a target set the price of a point in
 * it.** A stat you barely care about became the cheapest place to spend a turn
 * precisely BECAUSE you barely cared about it. Under "points" the price is flat
 * across stats, and which facility wins is decided by what it pays -- which is
 * the question the simulator exists to answer.
 *
 * THE TRADE IS REAL AND IS NOT FREE. "fraction" says *each target matters
 * equally*; "points" says *each point matters equally*. Under "points" a small
 * target is a small part of the score, so a 200-guts target on a 2450-point
 * wishlist is worth 8% of it and CAN be left unmet if guts never pays well --
 * where "fraction" would have guaranteed it a fifth of the score. That is the
 * failure mode to watch, and it is why the shipped comparison scores both by
 * `meetsTarget` (the predicate the UI reports) rather than by either objective's
 * own currency. See `tools/diagnose/diagnose-norm.ts`.
 *
 * What survives the change is the part worth keeping: the per-stat cap. Once a
 * stat reaches its target its marginal value drops to `OVERSHOOT_WEIGHT`, so
 * the objective still refuses to pour 600 points into a 400 target. "points"
 * changes which unmet stat is attractive, never whether a met one stays so.
 */
export type TargetNorm = "fraction" | "points";

/**
 * "points", by the user's decision on 2026-09-12, on the evidence above.
 *
 * Kept as a named constant rather than inlined at the default parameter so that
 * the diagnostics can state which normalisation is the shipped one without
 * hardcoding a guess.
 */
export const DEFAULT_TARGET_NORM: TargetNorm = "points";

/**
 * Score a state in [0, ~1+], higher is better.
 *
 * Structure: progress toward the stat targets, capped per stat, plus a small
 * overshoot term, plus the skill-point term. Capping per stat rather than in
 * aggregate is the load-bearing part -- it is what stops the search paying for
 * points past a target while another stat sits short.
 *
 * `TargetNorm` decides the unit that progress is measured in, and therefore
 * what one raw stat point is worth: `1/goal` under "fraction", `1/sum(goal)`
 * under "points". Read that type before changing anything here; the choice is
 * measured, not arbitrary.
 *
 * `state` may be mid-run; nothing here assumes turn 72. That matters because
 * the beam scores partial states constantly.
 */
export function shortfallScore(state: GcRunState, target: CompiledTarget): number {
  if (target.empty) {
    // No target given. Fall back to total stats so the search still has a
    // gradient, and let the caller know the number means something different.
    let sum = 0;
    for (const stat of STATS) {
      sum += target.raceEffective ? effectiveStat(state.stats[stat]) : state.stats[stat];
    }
    return sum / 5000;
  }

  // Both branches accumulate the same two quantities -- progress toward the
  // targets, and progress past them -- and divide by the same kind of total.
  // The ONLY difference is the unit: fractions of a target, or stat points.
  // That single choice is what sets the objective's per-point price, and it is
  // the whole of `TargetNorm`.
  let met = 0;
  let over = 0;
  let denom: number;

  if (target.norm === "points") {
    for (const { stat, want } of target.wanted) {
      const have = target.raceEffective ? effectiveStat(state.stats[stat]) : state.stats[stat];
      const goal = target.raceEffective ? effectiveStat(want) : want;
      met += Math.min(have, goal);
      if (have > goal) over += have - goal;
    }
    denom = target.goalTotal;
  } else {
    for (const { stat, want } of target.wanted) {
      const have = target.raceEffective ? effectiveStat(state.stats[stat]) : state.stats[stat];
      const goal = target.raceEffective ? effectiveStat(want) : want;
      met += Math.min(1, have / goal);
      if (have > goal) over += (have - goal) / goal;
    }
    denom = target.wanted.length;
  }

  // Guard the divisor rather than the stat count: under "points" the
  // denominator is a sum of goals, and a caller that compiles a skills-only
  // target reaches here with no stats and no goal total. Dividing by either
  // zero would return NaN and poison every comparison in the beam silently,
  // which is exactly the class of bug this project keeps finding.
  const statScore = denom === 0 ? 0 : (met + OVERSHOOT_WEIGHT * over) / denom;

  if (target.skillSpNeeded === 0) return statScore;

  const skillScore = Math.min(1, state.skillPoints / target.skillSpNeeded);
  return (1 - target.skillWeight) * statScore + target.skillWeight * skillScore;
}

/**
 * Did this state meet every part of the target? The predicate behind P(goal).
 *
 * Deliberately compares RAW stats against the RAW target, in both stat-value
 * modes, and that is not an oversight. `effectiveStat` is strictly increasing,
 * so `eff(have) >= eff(want)` exactly when `have >= want` -- converting both
 * sides would change nothing except the cost. More importantly, "did I hit
 * 1600 Speed" is a question about the number the game shows, and the answer
 * must not depend on how the search happened to be scoring at the time.
 */
export function meetsTarget(state: GcRunState, target: CompiledTarget): boolean {
  for (const { stat, want } of target.wanted) {
    if (state.stats[stat] < want) return false;
  }
  if (target.skillSpNeeded > 0 && state.skillPoints < target.skillSpNeeded) return false;
  return true;
}

/** Per-stat shortfall, for explaining a recommendation. */
export function shortfallByStat(
  state: GcRunState,
  target: CompiledTarget,
): Partial<Record<Stat, number>> {
  const out: Partial<Record<Stat, number>> = {};
  for (const { stat, want } of target.wanted) {
    out[stat] = Math.max(0, want - state.stats[stat]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Goal probability
// ---------------------------------------------------------------------------

export interface GoalEstimate {
  p: number;
  ci95: [number, number];
  samples: number;
}

/**
 * Wilson score interval.
 *
 * Deliberately not the normal approximation, which produces intervals that
 * extend past 0 or 1 exactly where this estimate spends most of its time -- a
 * target that is nearly always met or nearly never met. An interval containing
 * 1.04 is not a rounding nuisance, it is a visible sign the number is wrong.
 */
export function wilson(hits: number, n: number): [number, number] {
  if (n === 0) return [0, 1];
  const z = 1.96;
  const p = hits / n;
  const d = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const spread = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [
    Math.max(0, (centre - spread) / d),
    Math.min(1, (centre + spread) / d),
  ];
}

export function goalEstimate(hits: number, n: number): GoalEstimate {
  return { p: n === 0 ? 0 : hits / n, ci95: wilson(hits, n), samples: n };
}

/**
 * Is the difference between two sampled estimates real, or is it noise?
 *
 * The honest answer to "which action is better" is often "we cannot tell at
 * this sample count", and the UI is specified to say so rather than to rank two
 * indistinguishable options with a confident arrow. Overlapping Wilson
 * intervals is a conservative test -- it under-claims significance rather than
 * over-claiming it, which is the right direction to err here.
 */
export function separable(a: GoalEstimate, b: GoalEstimate): boolean {
  return a.ci95[0] > b.ci95[1] || b.ci95[0] > a.ci95[1];
}

export type ObjectiveMode = "shortfall" | "goalProbability" | "hybrid";

export type { StatVector };
