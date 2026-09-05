/**
 * The calibration log format.
 *
 * One record per (facility, turn) observation, read off the game's training
 * screen. See docs/m2-logging.md for why that screen is the right thing to
 * capture: it shows the game's own predicted gains for all five facilities at
 * once, with no RNG in them, so one screenshot is five clean observations.
 *
 * JSONL, append-only. A malformed line is reported and skipped rather than
 * killing the run -- a hand-built log will have typos, and losing 99 good rows
 * to one bad one helps nobody.
 */

import { STATS, type Stat } from "../../../data/src/types";
import type { Mood } from "../scenarios/grand-concert/training";

const MOODS = ["awful", "bad", "normal", "good", "great"] as const;

export interface ObservedCard {
  cardId: number;
  /** 0-100. Rainbow needs >= 80 and a matching facility. */
  bond: number;
  /** The facility this card specialises in; null for friend/group cards. */
  stat: Stat | null;
}

export interface Observation {
  turn: number;
  facility: Stat;
  facilityLevel: number;
  mood: Mood;
  energy?: number;
  /** Gains exactly as the game displays them, before you click. */
  predictedGains: Partial<Record<Stat, number>>;
  predictedSkillPoints?: number;
  /** The cards sitting on this facility this turn. */
  cards: ObservedCard[];
  /**
   * Song ids owned at this point in the run.
   *
   * Songs grant permanent per-training stat bonuses ("Training Speed Gain +1")
   * that add to the base before every multiplier, so an observation from late in
   * a career is NOT comparable to an early one unless this is recorded.
   * Observations before the first concert have none, which makes them the
   * cleanest calibration data.
   */
  songsOwned?: number[];
  growthRate?: Partial<Record<Stat, number>>;
  source?: string;
  note?: string;
}

export interface ParseResult {
  observations: Observation[];
  errors: Array<{ line: number; message: string; raw: string }>;
}

function fail(field: string, why: string): string {
  return `${field}: ${why}`;
}

/** Validate one parsed object. Returns a list of problems; empty means good. */
export function validateObservation(o: unknown): string[] {
  const problems: string[] = [];
  if (typeof o !== "object" || o === null) return ["not an object"];
  const r = o as Record<string, unknown>;

  if (typeof r.turn !== "number" || r.turn < 1) problems.push(fail("turn", "must be a positive number"));

  if (typeof r.facility !== "string" || !(STATS as readonly string[]).includes(r.facility)) {
    problems.push(fail("facility", `must be one of ${STATS.join(", ")}`));
  }

  if (typeof r.facilityLevel !== "number" || r.facilityLevel < 1 || r.facilityLevel > 5) {
    problems.push(fail("facilityLevel", "must be 1-5"));
  }

  if (typeof r.mood !== "string" || !(MOODS as readonly string[]).includes(r.mood)) {
    problems.push(fail("mood", `must be one of ${MOODS.join(", ")}`));
  }

  const gains = r.predictedGains;
  if (typeof gains !== "object" || gains === null) {
    problems.push(fail("predictedGains", "missing"));
  } else {
    const entries = Object.entries(gains as Record<string, unknown>);
    if (entries.length === 0) problems.push(fail("predictedGains", "empty"));
    for (const [k, v] of entries) {
      if (!(STATS as readonly string[]).includes(k)) {
        problems.push(fail(`predictedGains.${k}`, "not a stat"));
      }
      if (typeof v !== "number" || v < 0) {
        problems.push(fail(`predictedGains.${k}`, "must be a non-negative number"));
      }
    }
    // The observation is only useful if the facility trains its own stat --
    // that is the value the residual analysis keys off.
    if (typeof r.facility === "string" &&
        (gains as Record<string, unknown>)[r.facility] === undefined) {
      problems.push(fail("predictedGains",
        `must include the facility's own stat (${r.facility})`));
    }
  }

  if (!Array.isArray(r.cards)) {
    problems.push(fail("cards", "must be an array (use [] for an empty facility)"));
  } else {
    r.cards.forEach((c: unknown, i: number) => {
      if (typeof c !== "object" || c === null) {
        problems.push(fail(`cards[${i}]`, "not an object"));
        return;
      }
      const card = c as Record<string, unknown>;
      if (typeof card.bond !== "number" || card.bond < 0 || card.bond > 100) {
        problems.push(fail(`cards[${i}].bond`, "must be 0-100"));
      }
      if (card.stat !== null && !(STATS as readonly string[]).includes(card.stat as string)) {
        problems.push(fail(`cards[${i}].stat`, "must be a stat or null"));
      }
    });
  }

  return problems;
}

/** Parse a JSONL log. Bad lines are collected, not thrown. */
export function parseLog(text: string): ParseResult {
  const observations: Observation[] = [];
  const errors: ParseResult["errors"] = [];

  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith("//") || line.startsWith("#")) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (e) {
      errors.push({ line: i + 1, message: `invalid JSON: ${(e as Error).message}`, raw: line });
      return;
    }

    const problems = validateObservation(parsed);
    if (problems.length) {
      errors.push({ line: i + 1, message: problems.join("; "), raw: line });
      return;
    }
    observations.push(parsed as Observation);
  });

  return { observations, errors };
}

export function serializeLog(observations: Observation[]): string {
  return observations.map((o) => JSON.stringify(o)).join("\n") + "\n";
}
