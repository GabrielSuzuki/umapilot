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
import { LAYOUT, scaleBox, isPanelShaped, cropImage, REF_ASPECT, REF_W } from "./layout";
import type { Box } from "./image";

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

// ---------------------------------------------------------------------------
// Finding the panel inside a bigger capture
// ---------------------------------------------------------------------------

export interface PanelSearch {
  box: Box;
  /** 0 is a perfect match to the training-screen bands; higher is worse. */
  cost: number;
  /** True when the image was already the panel and nothing was searched. */
  exact: boolean;
}

/** How far the probes sit from the middle of their training bands. */
function panelCost(p: ScreenProbe): number {
  const mid = (b: readonly [number, number]) => (b[0] + b[1]) / 2;
  const half = (b: readonly [number, number]) => (b[1] - b[0]) / 2;
  return Math.abs(p.statRowLuma - mid(BAND.statRowLuma)) / half(BAND.statRowLuma)
    + Math.abs(p.headerStdDev - mid(BAND.headerStdDev)) / half(BAND.headerStdDev)
    + Math.abs(p.chipRowStdDev - mid(BAND.chipRowStdDev)) / half(BAND.chipRowStdDev);
}

/**
 * Locate the game panel in a screenshot that contains more than the game.
 *
 * The game letterboxes rather than reflowing, so the panel's aspect ratio is
 * fixed and the only unknown is where it starts. A window of the right
 * proportions is slid across the image and scored by the SAME probes that
 * decide whether a frame is a training screen -- the panel is, by definition,
 * the place where those probes are happiest.
 *
 * WHAT THIS CANNOT DO, stated rather than discovered later: the probes describe
 * a TRAINING screen, so this finds the panel only in a frame that contains one.
 * A screenshot of a race dialog has no offset that scores well and the search
 * correctly returns null. That is the right failure for the drop-a-screenshot
 * flow, where a training screen is the only thing worth reading anyway -- but it
 * means this is not a general window finder and must not be used as one.
 *
 * Coarse pass then refine, because scoring every offset of a 3840-wide frame at
 * full resolution is thousands of probes for an answer three passes give.
 */
/**
 * Vertical-edge energy per column, summed over the stat-row band.
 *
 * The probes above cannot localise, and that is not a tuning problem: they are
 * aggregate statistics over large boxes, so sliding the window 30px barely
 * changes them. Scored alone they land 15 to 250 pixels off and every field
 * read then fails against a layout that is almost right.
 *
 * The stat row is the sharpest structure on the screen for this purpose: a
 * bright panel with hard outer borders and four dashed cell dividers at known
 * spacing. Seven edges at fixed offsets is a comb, and correlating the comb
 * against the image's edge energy gives a peak one pixel wide -- on the
 * reference frame, 16778 at the true offset against 6413 eight pixels away.
 */
function edgeEnergyByColumn(img: RgbaImage, y0: number, y1: number): Float64Array {
  const out = new Float64Array(Math.max(0, img.width - 1));
  const yA = Math.max(0, Math.min(img.height, y0)), yB = Math.max(0, Math.min(img.height, y1));
  for (let y = yA; y < yB; y++) {
    let i = y * img.width * 4;
    let prev = 0.299 * img.data[i]! + 0.587 * img.data[i + 1]! + 0.114 * img.data[i + 2]!;
    for (let x = 1; x < img.width; x++) {
      i += 4;
      const l = 0.299 * img.data[i]! + 0.587 * img.data[i + 1]! + 0.114 * img.data[i + 2]!;
      out[x - 1]! += Math.abs(l - prev);
      prev = l;
    }
  }
  return out;
}

/** The stat row's outer borders and cell dividers, in reference pixels. */
const STAT_ROW_COMB = [122, 219, 314, 409, 504, 599, 700] as const;

export function findPanel(img: RgbaImage): PanelSearch | null {
  if (isPanelShaped(img)) {
    return { box: { x0: 0, y0: 0, x1: img.width, y1: img.height }, cost: 0, exact: true };
  }
  const w = Math.round(img.height * REF_ASPECT);
  if (w > img.width) return null;
  const scale = w / REF_W;

  const boxAt = (x0: number): Box => ({ x0, y0: 0, x1: x0 + w, y1: img.height });

  // COARSE: the probes get within a few tens of pixels, and cheaply, because
  // they are insensitive to exactly the translation the fine pass resolves.
  //
  // Several candidates, not one. The comb has rival peaks in a busy desktop --
  // on one reference frame the runner-up sits 287px from the truth at 96% of
  // its score -- so a fine pass anchored to a single coarse guess follows that
  // guess off a cliff when it is wrong, which is exactly what happened on frame
  // 30. Keeping a handful of separated coarse minima and refining each lets the
  // comb choose between them instead of confirming one.
  const coarse: Array<{ x: number; cost: number }> = [];
  for (let x = 0; x + w <= img.width; x += 32) {
    coarse.push({ x, cost: panelCost(probeScreen(cropImage(img, boxAt(x)))) });
  }
  coarse.sort((a, b) => a.cost - b.cost);
  const seeds: number[] = [];
  for (const c of coarse) {
    if (seeds.length >= 5) break;
    if (seeds.every((s2) => Math.abs(s2 - c.x) >= 64)) seeds.push(c.x);
  }

  // FINE: align the comb around each seed, then judge the refined offsets by
  // the probes again. The comb localises to the pixel and discriminates badly;
  // the probes discriminate and cannot localise. Each stage covers the other.
  const grad = edgeEnergyByColumn(img, LAYOUT.statRow.y0 * scale, LAYOUT.statRow.y1 * scale);
  const combAt = (x: number): number => {
    let sum = 0;
    for (const d of STAT_ROW_COMB) {
      const c = Math.round(x + d * scale);
      if (c >= 0 && c < grad.length) sum += grad[c]!;
    }
    return sum;
  };

  let bestX = seeds[0] ?? 0, bestCost = Infinity;
  for (const seed of seeds) {
    let peakX = seed, peak = -Infinity;
    const lo = Math.max(0, seed - 96), hi = Math.min(img.width - w, seed + 96);
    for (let x = lo; x <= hi; x++) {
      const v = combAt(x);
      if (v > peak) { peak = v; peakX = x; }
    }
    const c = panelCost(probeScreen(cropImage(img, boxAt(peakX))));
    if (c < bestCost) { bestCost = c; bestX = peakX; }
  }

  // The accept test is `probeScreen`'s own verdict, not a second cost cap.
  //
  // An arbitrary cap was tried first, at cost <= 1.0, and it rejected two of
  // nine training frames that the comb had aligned to the pixel -- a correct
  // answer thrown away by a threshold nobody had measured. `kind` is measured:
  // it is the three bands, and it is right on 80 of 80 frames. `cost` is still
  // returned, because a caller may want to know how comfortable the fit was.
  const probe = probeScreen(cropImage(img, boxAt(bestX)));
  const cost = panelCost(probe);
  if (probe.kind !== "training") return null;
  return { box: boxAt(bestX), cost, exact: false };
}

export { cropImage };
