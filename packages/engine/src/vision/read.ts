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
import { FIELDS, statField, capField, chipLevelField, fieldGlyphs, selectedFacility } from "./fields";
import { GLYPH_TEMPLATES } from "./glyphs";
import { probeScreen, type ScreenProbe } from "./classify";
import { STATS, type Stat } from "../../../data/src/types";

export interface FrameReading {
  screen: ScreenProbe;
  turnsLeft?: number;
  concertIn?: number;
  skillPts?: number;
  stats: Partial<Record<Stat, number>>;
  /**
   * Stat caps, the "/1625" under each value, where legible.
   *
   * Read every turn rather than once, because the cap MOVES: in the captured
   * career speed went 1625 -> 1630 -> 1635 and stamina 1332 -> 1336 -> 1342,
   * raised by the inheritance events on turns 30 and 54. A cap read once at the
   * Legacy Select screen and held for 72 turns is wrong for two thirds of the
   * run. See `capField` and `tools/vision/caps-probe.ts`.
   */
  statCaps: Partial<Record<Stat, number>>;
  /** Facility levels, where legible. See `chipLevelsHidden`. */
  facilityLevels: Partial<Record<Stat, number>>;
  /** Which facility's chip is raised, if exactly one could be identified. */
  selected?: Stat;
  /**
   * True when none of the unselected chips printed a level.
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
    return { screen, stats: { ...EMPTY }, statCaps: { ...EMPTY }, facilityLevels: { ...EMPTY }, chipLevelsHidden: false };
  }

  const num = (spec: Parameters<typeof fieldGlyphs>[1]) =>
    readNumber(fieldGlyphs(panel, spec), GLYPH_TEMPLATES.get(spec.style) ?? [])?.value;

  const stats: Partial<Record<Stat, number>> = {};
  const statCaps: Partial<Record<Stat, number>> = {};
  for (let i = 0; i < STATS.length; i++) {
    const v = num(statField(i));
    if (v !== undefined) stats[STATS[i]!] = v;
    // A cap below 1000 is not a cap -- the Grand Concert base is 1300 at the
    // lowest and legacy only raises it. Anything smaller is a segmentation
    // accident, and letting one through would tell the planner a stat is
    // already over its ceiling and worth nothing for the rest of the run.
    const cap = num(capField(i));
    if (cap !== undefined && cap >= 1000 && cap <= 2000) statCaps[STATS[i]!] = cap;
  }

  // WHICH CHIP IS SELECTED comes from the chevrons under it, not from its
  // level digit -- see `selectedFacility`. The digit approach managed 45%
  // because the game paints an animated sparkle over the selected chip.
  const sel = selectedFacility(panel);
  const selected = sel ? STATS[sel.index] : undefined;

  // THE SELECTED CHIP'S LEVEL IS NOT READ, AND THAT IS THE POINT.
  //
  // The game paints an animated sparkle over the selected chip. It is near-white,
  // so it punches holes in the digit, and a holed glyph does not fail loudly --
  // it matches a different digit. Measured: one misread in 401 cross-validated
  // field reads, frame 51, a sparkled speed 3 read as a 2, with the surrounding
  // frames and the transcription agreeing it is a 3. The same overlay is what
  // turned a 3 into a 5 for a human reading these screenshots by hand
  // (`replay-validation.md` Part 3), so it is not a weakness of this method.
  //
  // Refusing that one position takes the misreads to zero. The trade is
  // deliberate and is the module's whole stance: a refused field costs one
  // prompt and is visible; a wrong field is a facility level the planner
  // believes for the rest of the run, and it changes what every training is
  // predicted to pay.
  //
  // Cheap, too, now that `selectedFacility` identifies the chip from the
  // chevrons: the position to skip is known exactly, so the other four are
  // still read at their resting offsets.
  const facilityLevels: Partial<Record<Stat, number>> = {};
  for (let i = 0; i < STATS.length; i++) {
    const stat = STATS[i]!;
    if (stat === selected) continue;
    const level = num(chipLevelField(i, false));
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
    statCaps,
    facilityLevels,
    ...(selected !== undefined ? { selected } : {}),
    chipLevelsHidden: Object.keys(facilityLevels).length === 0,
  };
}
