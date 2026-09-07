/**
 * What the user is aiming for.
 *
 * Five stat slots for end-of-run targets, plus a searchable list of skills you
 * want to finish the run with. Everything the recommender does is measured
 * against this object, so it is the one type the UI and the engine must agree
 * on exactly.
 *
 * Types and validation land now (M0); the UI that produces them lands at M3.
 */

import {
  STATS,
  type Stat,
  type StatVector,
  type SkillEntry,
} from "../../data/src/types";
import { effectiveStat, HALVING_THRESHOLD } from "./planner/objective";

// ---------------------------------------------------------------------------
// The target
// ---------------------------------------------------------------------------

export interface SkillTarget {
  skillId: number;
  /**
   * How much the user wants this skill relative to the others.
   * "required" makes it a hard constraint: a run that misses it fails the goal
   * outright. "preferred" contributes to the score but is tradeable.
   */
  priority: "required" | "preferred";
}

export interface RunTarget {
  /**
   * Desired stat values at the end of the run. A slot left null means
   * "no target" -- it is not a target of zero, and the engine must not treat
   * it as satisfied-by-default when computing goal probability.
   */
  stats: Record<Stat, number | null>;

  /** Wanted skills, in the order the user added them. */
  skills: SkillTarget[];

  /**
   * How to trade stats against skills when both cannot be had. 0 = stats only,
   * 1 = skills only. Defaults to a even split; the UI should expose it as a
   * single slider rather than ten numbers.
   */
  skillWeight: number;
}

export const EMPTY_TARGET: RunTarget = {
  stats: { speed: null, stamina: null, power: null, guts: null, wit: null },
  skills: [],
  skillWeight: 0.5,
};

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface TargetProblem {
  field: string;
  message: string;
  severity: "error" | "warning";
}

/**
 * Validate a target against the run's caps and skill list.
 *
 * Warnings are the interesting half: telling someone their 1600/1200/1200 build
 * is arithmetically out of reach *before* they play 72 turns is more valuable
 * than any per-turn advice the tool will ever give.
 *
 * IMPORTANT: `statCaps` must be the caps for *this run*, not the scenario base.
 * Legacy raises them -- a scanned run showed Stamina at 1366 and Power at 1316
 * against a 1300 base. Validating against the base would reject a target that is
 * actually reachable. Use `effectiveStatCaps` to resolve them.
 */
export function validateTarget(
  target: RunTarget,
  statCaps: StatVector,
  skillsById: Map<number, SkillEntry>,
): TargetProblem[] {
  const problems: TargetProblem[] = [];

  for (const stat of STATS) {
    const want = target.stats[stat];
    if (want === null) continue;

    if (!Number.isInteger(want) || want < 1) {
      problems.push({
        field: `stats.${stat}`,
        message: "Target must be a positive whole number.",
        severity: "error",
      });
      continue;
    }
    if (want > statCaps[stat]) {
      problems.push({
        field: `stats.${stat}`,
        message: `Above this run's ${stat} cap of ${statCaps[stat]}.`,
        severity: "error",
      });
    }

    // Grand Concert raises the caps past 1200 and then halves everything above
    // that line for race mechanics -- 1600 Speed races as 1400. The points are
    // real and they are gained at full rate; they are worth half when raced. A
    // target set deep into that zone is a legitimate thing to want (sparks and
    // the displayed number are raw), but it should be a decision rather than a
    // surprise, so it is said out loud rather than silently priced at face
    // value. Community-sourced, not decoded from master.mdb.
    if (want > HALVING_THRESHOLD) {
      const effective = Math.round(effectiveStat(want));
      problems.push({
        field: `stats.${stat}`,
        message:
          `${want} ${stat} races as ${effective}: everything above ` +
          `${HALVING_THRESHOLD} counts half. The ${want - HALVING_THRESHOLD} ` +
          `points above the line are worth ` +
          `${Math.round((want - HALVING_THRESHOLD) / 2)} in a race, and cost ` +
          `full price in trainings.`,
        severity: "warning",
      });
    }
  }

  const seen = new Set<number>();
  for (const { skillId, priority } of target.skills) {
    if (seen.has(skillId)) {
      problems.push({
        field: `skills.${skillId}`,
        message: "Skill listed twice.",
        severity: "warning",
      });
    }
    seen.add(skillId);

    const skill = skillsById.get(skillId);
    if (!skill) {
      problems.push({
        field: `skills.${skillId}`,
        message: "Unknown skill id. The dataset may be from a different patch.",
        severity: "error",
      });
      continue;
    }
    if (!skill.purchasableInCareer) {
      problems.push({
        field: `skills.${skillId}`,
        message: `"${skill.name}" cannot be bought during a career run.`,
        severity: priority === "required" ? "error" : "warning",
      });
    }
  }

  if (target.skillWeight < 0 || target.skillWeight > 1) {
    problems.push({
      field: "skillWeight",
      message: "Must be between 0 and 1.",
      severity: "error",
    });
  }

  return problems;
}

/**
 * Total SP the wishlist costs, ignoring hint discounts.
 *
 * An upper bound, and a useful reality check to show next to the picker: a
 * wishlist costing more SP than a run can plausibly generate is worth flagging
 * while the user is still choosing, not after.
 */
export function wishlistSpCost(
  target: RunTarget,
  skillsById: Map<number, SkillEntry>,
): { total: number; unknown: number[] } {
  let total = 0;
  const unknown: number[] = [];
  for (const { skillId } of target.skills) {
    const skill = skillsById.get(skillId);
    if (!skill || skill.spCost === null) {
      unknown.push(skillId);
      continue;
    }
    total += skill.spCost;
  }
  return { total, unknown };
}

// ---------------------------------------------------------------------------
// Stat caps
// ---------------------------------------------------------------------------

/**
 * Resolve the stat caps that actually apply to a run.
 *
 * The scenario dataset carries base caps (Grand Concert: 1600/1300/1300/1500/1300).
 * Legacy raises them per run, and the Legacy Select screen shows the raised
 * values -- so once a run has been scanned, the scanned caps win.
 *
 * Falls back to the base only when nothing has been scanned yet, and the UI
 * should say so rather than presenting a guess as fact.
 */
export function effectiveStatCaps(
  scenarioBase: StatVector,
  scanned?: Partial<StatVector> | null,
): { caps: StatVector; source: "scanned" | "scenario-base" } {
  if (!scanned) return { caps: { ...scenarioBase }, source: "scenario-base" };

  const caps = { ...scenarioBase };
  let usedAny = false;
  for (const stat of STATS) {
    const v = scanned[stat];
    if (typeof v === "number" && v > 0) {
      caps[stat] = v;
      usedAny = true;
    }
  }
  return { caps, source: usedAny ? "scanned" : "scenario-base" };
}

// ---------------------------------------------------------------------------
// Skill search (backs the picker's search box)
// ---------------------------------------------------------------------------

/**
 * Rank skills for a search box. Deliberately simple: exact prefix beats
 * substring beats description match. ~700 skills, so this runs fine on every
 * keystroke and does not need an index.
 */
export function searchSkills(
  query: string,
  skills: SkillEntry[],
  opts: { limit?: number; purchasableOnly?: boolean } = {},
): SkillEntry[] {
  const { limit = 30, purchasableOnly = true } = opts;
  const q = query.trim().toLowerCase();
  const pool = purchasableOnly
    ? skills.filter((s) => s.purchasableInCareer)
    : skills;

  if (!q) return pool.slice(0, limit);

  const scored: Array<{ skill: SkillEntry; score: number }> = [];
  for (const skill of pool) {
    const name = skill.name.toLowerCase();
    let score = 0;
    if (name === q) score = 4;
    else if (name.startsWith(q)) score = 3;
    else if (name.includes(q)) score = 2;
    else if (skill.description?.toLowerCase().includes(q)) score = 1;
    if (score > 0) scored.push({ skill, score });
  }

  scored.sort(
    (a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name),
  );
  return scored.slice(0, limit).map((s) => s.skill);
}
