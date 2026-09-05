/**
 * Decode song and technique effects from the game's own English text.
 *
 * The raw opcodes in `master_bonus_gain_type_N` are not decoded, and guessing
 * at them is exactly what CONTRIBUTING.md forbids. But we don't need to: the
 * game ships a localized description of every effect, and "Training Speed Gain
 * +1" is not ambiguous. Parsing the text is the *database saying so*, which is
 * the first of the three acceptable justifications for a mapping.
 *
 * The parser is strict. Anything it does not recognise is returned in
 * `unparsed` rather than dropped, so an unhandled effect shows up as a visible
 * gap instead of silently contributing nothing.
 *
 * Two categories matter and behave completely differently:
 *
 *   perTraining  a permanent additive bonus applied to EVERY subsequent
 *                training -- "Training Speed Gain +1" means every future speed
 *                gain is computed from (base + 1). These stack across songs and
 *                compound with every multiplier, which is why buying them early
 *                is worth so much more than buying them late.
 *
 *   oneOff       a single grant at purchase -- "Speed +22". Worth the same
 *                whenever you buy it.
 */

import { STATS, type Stat } from "./types";

export interface DecodedEffect {
  /** Flat bonus added to the base value of every future training. */
  perTrainingStat: Partial<Record<Stat, number>>;
  /** Flat bonus to skill points earned per training. */
  perTrainingSkillPoints: number;
  /** One-time stat grant on purchase. */
  oneOffStat: Partial<Record<Stat, number>>;
  /** One-time skill points on purchase. */
  oneOffSkillPoints: number;
  /** One-time energy. */
  oneOffEnergy: number;
  /** True for "Skill hint appropriate for aptitude" and similar. */
  grantsHint: boolean;
  /** Any clause the parser did not understand. Never silently discarded. */
  unparsed: string[];
}

function empty(): DecodedEffect {
  return {
    perTrainingStat: {},
    perTrainingSkillPoints: 0,
    oneOffStat: {},
    oneOffSkillPoints: 0,
    oneOffEnergy: 0,
    grantsHint: false,
    unparsed: [],
  };
}

const STAT_BY_LABEL: Record<string, Stat> = {
  speed: "speed", stamina: "stamina", power: "power", guts: "guts", wit: "wit",
};

/** "Training Speed Gain +2" */
const RE_PER_TRAINING_STAT = /^Training\s+(Speed|Stamina|Power|Guts|Wit)\s+Gain\s+\+(\d+)$/i;
/** "Training Skill Pt Gain +3" */
const RE_PER_TRAINING_SP = /^Training\s+Skill\s+Pt\s+Gain\s+\+(\d+)$/i;
/** "Speed +22" */
const RE_ONEOFF_STAT = /^(Speed|Stamina|Power|Guts|Wit)\s+\+(\d+)$/i;
/** "Guts +3 to 7" -- a range; we take the midpoint and flag it. */
const RE_ONEOFF_STAT_RANGE = /^(Speed|Stamina|Power|Guts|Wit)\s+\+(\d+)\s+to\s+(\d+)$/i;
/** "Skill Pts +22" */
const RE_ONEOFF_SP = /^Skill\s+Pts?\s+\+(\d+)$/i;
/** "Skill Pts +3 to 7" -- techniques grant skill points in a range too. */
const RE_ONEOFF_SP_RANGE = /^Skill\s+Pts?\s+\+(\d+)\s+to\s+(\d+)$/i;
/** "Energy +20" */
const RE_ONEOFF_ENERGY = /^Energy\s+\+(\d+)$/i;
const RE_HINT = /skill\s+hint/i;

/**
 * Decode one effect description.
 *
 * Multi-clause effects are newline-separated in the game data
 * ("Guts +4\nSkill Pts +4"), so each line is parsed independently.
 */
export function decodeEffectText(text: string | null): DecodedEffect {
  const out = empty();
  if (!text) return out;

  for (const rawLine of text.split(/\\n|\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    let m: RegExpMatchArray | null;

    if ((m = line.match(RE_PER_TRAINING_STAT))) {
      const stat = STAT_BY_LABEL[m[1]!.toLowerCase()]!;
      out.perTrainingStat[stat] = (out.perTrainingStat[stat] ?? 0) + Number(m[2]);
      continue;
    }
    if ((m = line.match(RE_PER_TRAINING_SP))) {
      out.perTrainingSkillPoints += Number(m[1]);
      continue;
    }
    if ((m = line.match(RE_ONEOFF_STAT_RANGE))) {
      const stat = STAT_BY_LABEL[m[1]!.toLowerCase()]!;
      const mid = (Number(m[2]) + Number(m[3])) / 2;
      out.oneOffStat[stat] = (out.oneOffStat[stat] ?? 0) + mid;
      // A range is genuinely uncertain; record it so a projection can say so.
      out.unparsed.push(`range approximated by midpoint: ${line}`);
      continue;
    }
    if ((m = line.match(RE_ONEOFF_STAT))) {
      const stat = STAT_BY_LABEL[m[1]!.toLowerCase()]!;
      out.oneOffStat[stat] = (out.oneOffStat[stat] ?? 0) + Number(m[2]);
      continue;
    }
    if ((m = line.match(RE_ONEOFF_SP_RANGE))) {
      out.oneOffSkillPoints += (Number(m[1]) + Number(m[2])) / 2;
      out.unparsed.push(`range approximated by midpoint: ${line}`);
      continue;
    }
    if ((m = line.match(RE_ONEOFF_SP))) {
      out.oneOffSkillPoints += Number(m[1]);
      continue;
    }
    if ((m = line.match(RE_ONEOFF_ENERGY))) {
      out.oneOffEnergy += Number(m[1]);
      continue;
    }
    if (RE_HINT.test(line)) {
      out.grantsHint = true;
      continue;
    }

    out.unparsed.push(line);
  }

  return out;
}

/** Sum the per-training stat bonuses granted by a set of owned songs. */
export function accumulatePerTrainingBonuses(
  effectTexts: Array<string | null>,
): { stats: Partial<Record<Stat, number>>; skillPoints: number; unparsed: string[] } {
  const stats: Partial<Record<Stat, number>> = {};
  let skillPoints = 0;
  const unparsed: string[] = [];

  for (const text of effectTexts) {
    const d = decodeEffectText(text);
    for (const stat of STATS) {
      const v = d.perTrainingStat[stat];
      if (v) stats[stat] = (stats[stat] ?? 0) + v;
    }
    skillPoints += d.perTrainingSkillPoints;
    unparsed.push(...d.unparsed);
  }

  return { stats, skillPoints, unparsed };
}
