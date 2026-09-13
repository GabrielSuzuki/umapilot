/**
 * One captured frame in, one reading out.
 *
 * Every field is optional and every absence is deliberate. The reader's whole
 * contract is that a number it returns is a number it actually read: where the
 * glyphs were not clear it returns nothing and the caller asks the player,
 * which costs one prompt. The alternative -- a plausible guess -- is a stat the
 * planner believes for the rest of a 72-turn run, and nobody ever finds out.
 */
import type { RgbaImage } from "./image";
import { readNumber } from "./segment";
import { FIELDS, statField, chipLevelField, fieldGlyphs } from "./fields";
import { GLYPH_TEMPLATES } from "./glyphs";
import { probeScreen, type ScreenProbe } from "./classify";
import { STATS, type Stat } from "../../../data/src/types";

export interface FrameReading {
  screen: ScreenProbe;
  turnsLeft?: number;
  concertIn?: number;
  skillPts?: number;
  stats: Partial<Record<Stat, number>>;
  /** Facility levels, where legible. See `chipLevelsHidden`. */
  facilityLevels: Partial<Record<Stat, number>>;
  /** Which facility's chip is raised, if exactly one could be identified. */
  selected?: Stat;
  /**
   * True when no chip printed a level at all.
   *
   * This is summer camp, and it is the reason this flag exists rather than the
   * levels simply coming back empty. During camp the game hides every chip's
   * level text AND prints "Lvl 5" on the selected facility's banner regardless
   * of its real level. A reader that took the banner at face value would record
   * five level-5 facilities on a turn when stamina is level 1 -- which is
   * exactly the misreading that corrupted the hand transcription and had to be
   * corrected in `replay-validation.md` Part 3. So the banner is not read for
   * levels at all, and the caller is told the levels are unavailable.
   */
  chipLevelsHidden: boolean;
}

const EMPTY: Partial<Record<Stat, number>> = {};

export function readFrame(panel: RgbaImage): FrameReading {
  const screen = probeScreen(panel);
  if (screen.kind !== "training") {
    return { screen, stats: { ...EMPTY }, facilityLevels: { ...EMPTY }, chipLevelsHidden: false };
  }

  const num = (spec: Parameters<typeof fieldGlyphs>[1]) =>
    readNumber(fieldGlyphs(panel, spec), GLYPH_TEMPLATES.get(spec.style) ?? [])?.value;

  const stats: Partial<Record<Stat, number>> = {};
  for (let i = 0; i < STATS.length; i++) {
    const v = num(statField(i));
    if (v !== undefined) stats[STATS[i]!] = v;
  }

  // WHICH CHIP IS SELECTED, without reading a word.
  //
  // The selected chip rides ~40px higher than the others and is set larger, so
  // its level digit is legible at the raised offset and absent at the resting
  // one. Trying both positions and seeing which one yields a digit identifies
  // the selection using only machinery that already exists -- no letter
  // templates, no colour heuristic that a new facility skin would break.
  const facilityLevels: Partial<Record<Stat, number>> = {};
  const raised: Stat[] = [];
  for (let i = 0; i < STATS.length; i++) {
    const stat = STATS[i]!;
    const atRest = num(chipLevelField(i, false));
    const atRaised = num(chipLevelField(i, true));
    if (atRaised !== undefined && atRest === undefined) raised.push(stat);
    const level = atRest ?? atRaised;
    if (level !== undefined && level >= 1 && level <= 5) facilityLevels[stat] = level;
  }

  const turnsLeft = num(FIELDS.turnsLeft);
  const concertIn = num(FIELDS.concertIn);
  const skillPts = num(FIELDS.skillPts);

  return {
    screen,
    ...(turnsLeft !== undefined ? { turnsLeft } : {}),
    ...(concertIn !== undefined ? { concertIn } : {}),
    ...(skillPts !== undefined ? { skillPts } : {}),
    stats,
    facilityLevels,
    // Exactly one raised chip is a reading; two is a contradiction and is
    // reported as no reading rather than as the first one found.
    ...(raised.length === 1 ? { selected: raised[0]! } : {}),
    chipLevelsHidden: Object.keys(facilityLevels).length === 0,
  };
}
