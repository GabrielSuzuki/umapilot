/**
 * Is this frame a training screen, and can it be trusted?
 *
 * Under continuous capture at ~2fps most frames are NOT the turn screen: they
 * are menus, race dialogs, event cards, concert cutscenes, and the transitions
 * between them. Reading state off one of those produces a confident number from
 * the wrong pixels, which is the failure this whole module is arranged to avoid.
 *
 * WHAT THIS DELIBERATELY IS NOT. The right classifier reads the screen-name tab
 * at the top left -- the game writes "Training", "Race List", "Hype Level" there
 * in so many words, and that is ground truth rather than inference. It is not
 * done here because it needs letter templates and the corpus only labels
 * numbers. So this is three scalar probes standing in for a label the game is
 * already printing, and it should be replaced, not tuned.
 */
import type { RgbaImage } from "./image";
import { meanLuma, lumaStdDev } from "./image";
import { LAYOUT, scaleBox } from "./layout";

export type ScreenKind = "training" | "notTraining";

export interface ScreenProbe {
  kind: ScreenKind;
  statRowLuma: number;
  headerStdDev: number;
  chipRowStdDev: number;
  /** Smallest distance to a band edge, in probe units. Small means fragile. */
  margin: number;
}

/**
 * Bands measured over all 80 captured frames, 58 training and 22 not.
 *
 * `statRowLuma` -- the stat row is a near-white panel. Training occupies
 *   195.3..200.9 and nothing else in the corpus sits inside it except screens
 *   drawn ON TOP of the training screen, which is why one probe is not enough.
 *
 * `headerStdDev` -- the game blurs and dims everything behind a modal, and a
 *   blur is a loss of local contrast. Every dialog frame in the corpus lands at
 *   19..23 against training's 45..52. This is the probe that stops a race
 *   dialog being read as the turn underneath it.
 *
 * `chipRowStdDev` -- the five facility chips. Panels that cover the lower
 *   screen without blurring the header (Hype Level, the career menu) are caught
 *   only here.
 */
const BAND = {
  statRowLuma: [193, 203],
  headerStdDev: [35, 70],
  chipRowStdDev: [48, 60],
} as const;

const HEADER_BOX = { x0: 100, y0: 30, x1: 720, y1: 160 };
const CHIP_BOX = { x0: 140, y0: 855, x1: 670, y1: 970 };

export function probeScreen(panel: RgbaImage): ScreenProbe {
  const statRowLuma = meanLuma(panel, scaleBox(LAYOUT.statRow, panel.width, panel.height));
  const headerStdDev = lumaStdDev(panel, scaleBox(HEADER_BOX, panel.width, panel.height));
  const chipRowStdDev = lumaStdDev(panel, scaleBox(CHIP_BOX, panel.width, panel.height));

  const inBand = (v: number, b: readonly [number, number]) => v > b[0] && v < b[1];
  const kind: ScreenKind =
    inBand(statRowLuma, BAND.statRowLuma) &&
    inBand(headerStdDev, BAND.headerStdDev) &&
    inBand(chipRowStdDev, BAND.chipRowStdDev) ? "training" : "notTraining";

  // How close the nearest probe came to falling out of its band. Reported
  // because one of these bands is genuinely thin: the "Hype Level" panel sits
  // at chipRowStdDev 60.8 against a training maximum of 58.5, so that edge is
  // carrying the classification on 2.3 units. A caller that wants to be careful
  // can require a margin; the honest fix is to read the screen-name tab.
  const margin = Math.min(
    statRowLuma - BAND.statRowLuma[0], BAND.statRowLuma[1] - statRowLuma,
    headerStdDev - BAND.headerStdDev[0], BAND.headerStdDev[1] - headerStdDev,
    chipRowStdDev - BAND.chipRowStdDev[0], BAND.chipRowStdDev[1] - chipRowStdDev,
  );
  return { kind, statRowLuma, headerStdDev, chipRowStdDev, margin };
}
