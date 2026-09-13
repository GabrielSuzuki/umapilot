/**
 * Where things are on the Grand Concert career screen.
 *
 * Coordinates are FRACTIONS of the game panel, not pixels. The panel in the
 * reference capture is 812x1080, but the player's window can be any size and
 * the only thing that is actually fixed is the layout's proportions -- so the
 * boxes are authored against the reference and divided through by it. A capture
 * at a different scale reads with the same numbers.
 *
 * The aspect ratio is NOT free: the game letterboxes rather than reflowing, so
 * a panel whose aspect differs from the reference means the panel was found
 * wrongly, and `panelFromFrame` says so rather than scaling anyway.
 */
import { clampBox, type Box, type RgbaImage } from "./image";

export const REF_W = 812;
export const REF_H = 1080;
export const REF_ASPECT = REF_W / REF_H;

/** A box in reference pixels; `scaleBox` turns it into real ones. */
export type RefBox = Box;

const R = (x0: number, y0: number, x1: number, y1: number): RefBox => ({ x0, y0, x1, y1 });

/**
 * The five stat cells, left to right, in the stat row.
 *
 * Measured off the dashed cell dividers in the reference frame rather than
 * assumed to be even: they are 97, 95, 95, 95, 95 wide, and the first is the
 * odd one out.
 */
export const STAT_CELL_X: ReadonlyArray<readonly [number, number]> = [
  [122, 219], [219, 314], [314, 409], [409, 504], [504, 599],
];

export const LAYOUT = {
  /**
   * The screen-name tab at the very top left ("Training", "Race List", ...).
   * Read for classification, never for state.
   */
  screenTab: R(0, 4, 200, 30),

  /** "Junior Year Early Jan" / "Junior Year Pre-Debut". */
  calendar: R(236, 36, 392, 56),

  /** The big turn counter. One or two digits, purple on white. */
  turnsLeft: R(126, 57, 176, 101),

  /**
   * "Concert in N turn(s)" -- N only.
   *
   * WHITE glyphs on a purple pill, where every other number on this screen is
   * dark on light. The polarity is a property of the region, not of the reader,
   * which is why `inkMask` takes it as an argument and no caller may default it.
   */
  concertIn: R(132, 128, 168, 150),

  /** The energy track, excluding its rounded end caps. */
  energyBar: R(297, 126, 540, 145),

  /** The mood pill. Classified by fill colour, not by reading the word. */
  moodPill: R(557, 120, 662, 150),

  /**
   * The selected facility's banner: "Wit Lvl 3".
   *
   * This is the ONLY place a facility level is legible during summer camp,
   * when the chips below hide their level text entirely -- and during camp it
   * reads 5 for every facility regardless of the real level. Both facts are
   * the reader's problem, not the caller's: see `read.ts`.
   */
  selectedBanner: R(80, 168, 250, 194),

  /** The whole stat row, header band excluded. */
  statRow: R(122, 700, 700, 765),
  /** Value digits sit above the cap; the grade letter spans both. */
  statValueBand: R(0, 723, 0, 746),
  statCapBand: R(0, 746, 0, 763),
  /** Within a stat cell, x offset past the grade letter. */
  statDigitsInset: 38,

  skillPts: R(604, 723, 694, 758),

  failurePill: R(575, 775, 665, 818),

  /** The five facility chips, by centre. */
  chipCentreY: 907,
  chipCentreX: [187, 295, 402, 510, 620] as const,
  /** A chip's "Lvl N" text, relative to its centre, when it is NOT selected. */
  chipLevelOffset: R(-46, 35, 46, 58),
  /** The selected chip rides ~32px higher and its label is restyled. */
  selectedChipRise: 32,

  /** The performance-point column: five rows of "N / cap". */
  tokenColumnX: R(28, 0, 110, 0),
  tokenRowY: [300, 358, 415, 472, 528] as const,
  tokenRowHeight: 34,
} as const;

export function scaleBox(b: RefBox, panelW: number, panelH: number): Box {
  const sx = panelW / REF_W, sy = panelH / REF_H;
  return { x0: b.x0 * sx, y0: b.y0 * sy, x1: b.x1 * sx, y1: b.y1 * sy };
}

/** The value-digit box of stat `i`, in reference pixels. */
export function statValueBox(i: number): RefBox {
  const cell = STAT_CELL_X[i]!;
  return R(cell[0] + LAYOUT.statDigitsInset, LAYOUT.statValueBand.y0, cell[1] - 2, LAYOUT.statValueBand.y1);
}

/** The "/cap" box of stat `i`, in reference pixels. */
export function statCapBox(i: number): RefBox {
  const cell = STAT_CELL_X[i]!;
  return R(cell[0] + LAYOUT.statDigitsInset, LAYOUT.statCapBand.y0, cell[1] - 2, LAYOUT.statCapBand.y1);
}

/** A facility chip's level-text box, in reference pixels. */
export function chipLevelBox(i: number, selected: boolean): RefBox {
  const cx = LAYOUT.chipCentreX[i]!;
  const cy = LAYOUT.chipCentreY - (selected ? LAYOUT.selectedChipRise : 0);
  const o = LAYOUT.chipLevelOffset;
  return R(cx + o.x0, cy + o.y0, cx + o.x1, cy + o.y1);
}

/** A performance-token count box, in reference pixels. */
export function tokenValueBox(i: number): RefBox {
  const y = LAYOUT.tokenRowY[i]!;
  return R(LAYOUT.tokenColumnX.x0, y, LAYOUT.tokenColumnX.x1, y + LAYOUT.tokenRowHeight);
}

/**
 * Crop an image to a sub-box without copying more than the box.
 *
 * The reader works in panel coordinates, so once the panel is located
 * everything downstream is simpler if it is handed an image that IS the panel.
 */
export function cropImage(img: RgbaImage, box: Box): RgbaImage {
  const b = clampBox(box, img.width, img.height);
  const w = Math.max(0, b.x1 - b.x0), h = Math.max(0, b.y1 - b.y0);
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const src = ((b.y0 + y) * img.width + b.x0) * 4;
    data.set(img.data.subarray(src, src + w * 4), y * w * 4);
  }
  return { width: w, height: h, data };
}

/**
 * Is this image already the game panel?
 *
 * In production it will be: `getDisplayMedia` captures the game WINDOW, so the
 * frame and the panel are the same thing. The corpus is the other case -- a
 * 3840x1080 dual-monitor grab with the game in a column -- and that is not an
 * artefact of how these screenshots were taken. It is what a player gets from
 * PrtScn, which is exactly how they will produce a file to drop on the page.
 */
export function isPanelShaped(img: RgbaImage, tolerance = 0.02): boolean {
  const a = img.width / img.height;
  return Math.abs(a - REF_ASPECT) / REF_ASPECT <= tolerance;
}
