/**
 * Cutting a number out of a box, and turning each glyph into something
 * comparable.
 *
 * The game's digits are a rounded outlined face at a handful of fixed sizes.
 * They are drawn at consistent pitch, they never touch, and they never rotate,
 * which is why this is column segmentation and template matching rather than
 * anything cleverer. A general OCR engine would be a large dependency solving a
 * much harder problem than the one actually present.
 */
import type { Mask } from "./image";
import { columnProfile } from "./image";

export interface Glyph {
  /** Tight bounding box within the source mask. */
  x0: number; y0: number; x1: number; y1: number;
  /** Normalised bitmap, `GLYPH_W * GLYPH_H`, values 0..1. */
  cells: Float32Array;
}

export const GLYPH_W = 12;
export const GLYPH_H = 16;

export interface SegmentOptions {
  /** Columns with fewer than this many ink pixels count as blank. */
  minColumnInk?: number;
  /** Blank columns needed to end a glyph. 1 is right for a font that never touches. */
  gap?: number;
  /** Discard components narrower or shorter than this. Kills anti-aliasing specks. */
  minWidth?: number;
  minHeight?: number;
  /**
   * Discard components whose ink reaches this row or below.
   *
   * The stat cells put a grade letter ("C+", "E") immediately left of the
   * value, in the same colour, and it is TALLER: it spans the value row and the
   * cap row together while the digits stop short. That difference is the only
   * clean separator between them, so it is the one used -- cropping by x would
   * fail the moment a stat reaches four digits and the value grows leftward
   * into the grade's column.
   */
  dropIfReachesRow?: number;
  /**
   * Discard components shorter than this fraction of the tallest one found.
   *
   * Every digit in one number is the same height, so anything half-height is
   * not a digit. What it usually is: the right-hand sliver of a grade letter
   * that reached past the box inset. A "F+" grade leaves a 2x5 fragment inside
   * the value box where the digits are 6x17 and up, and that fragment makes the
   * whole field refuse -- the player's stamina and wit values went unread on
   * every frame of his career for exactly this reason, while speed, power and
   * guts (plain "F", no plus) read fine.
   *
   * Relative rather than absolute, because the mask is in PANEL pixels: a fixed
   * threshold that works at 812 wide filters nothing at 1624.
   */
  minHeightFractionOfTallest?: number;
}

/** Split a mask into glyphs, left to right. */
export function segmentGlyphs(m: Mask, opts: SegmentOptions = {}): Glyph[] {
  const minColumnInk = opts.minColumnInk ?? 1;
  const gap = opts.gap ?? 1;
  const minWidth = opts.minWidth ?? 2;
  const minHeight = opts.minHeight ?? 5;

  const prof = columnProfile(m);
  const runs: Array<[number, number]> = [];
  let start = -1, blanks = 0;
  for (let x = 0; x < m.width; x++) {
    const inked = prof[x]! >= minColumnInk;
    if (inked) {
      if (start < 0) start = x;
      blanks = 0;
    } else if (start >= 0) {
      blanks++;
      if (blanks >= gap) { runs.push([start, x - blanks + 1]); start = -1; blanks = 0; }
    }
  }
  if (start >= 0) runs.push([start, m.width]);

  const out: Glyph[] = [];
  for (const [x0, x1] of runs) {
    if (x1 - x0 < minWidth) continue;
    let top = m.height, bot = -1;
    for (let y = 0; y < m.height; y++) {
      for (let x = x0; x < x1; x++) {
        if (m.bits[y * m.width + x]) { if (y < top) top = y; if (y > bot) bot = y; break; }
      }
    }
    if (bot < 0 || bot - top + 1 < minHeight) continue;
    if (opts.dropIfReachesRow !== undefined && bot >= opts.dropIfReachesRow) continue;
    out.push({ x0, y0: top, x1, y1: bot + 1, cells: normalise(m, x0, top, x1, bot + 1) });
  }

  // Relative height filter, applied after everything is found because it needs
  // to know what the tallest component was.
  const frac = opts.minHeightFractionOfTallest;
  if (frac !== undefined && out.length > 1) {
    let tallest = 0;
    for (const g of out) tallest = Math.max(tallest, g.y1 - g.y0);
    const floor = tallest * frac;
    return out.filter((g) => g.y1 - g.y0 >= floor);
  }
  return out;
}

/**
 * Resample a glyph's bounding box onto the fixed comparison grid.
 *
 * Height is normalised and width is NOT -- the glyph is scaled by its height
 * and then centred in a fixed-width canvas, so a "1" stays narrow and a "0"
 * stays wide. Normalising both axes would make those two the same picture, and
 * this font's digits differ from each other more in proportion than in detail
 * at this size.
 */
function normalise(m: Mask, x0: number, y0: number, x1: number, y1: number): Float32Array {
  const gw = x1 - x0, gh = y1 - y0;
  const cells = new Float32Array(GLYPH_W * GLYPH_H);
  if (gw <= 0 || gh <= 0) return cells;

  const scale = GLYPH_H / gh;
  const targetW = Math.max(1, Math.min(GLYPH_W, Math.round(gw * scale)));
  const xPad = Math.floor((GLYPH_W - targetW) / 2);

  for (let ty = 0; ty < GLYPH_H; ty++) {
    // Area-average the source rows and columns that land in this cell, so a
    // downscale keeps stroke weight instead of dropping thin strokes.
    const sy0 = y0 + (ty * gh) / GLYPH_H, sy1 = y0 + ((ty + 1) * gh) / GLYPH_H;
    for (let tx = 0; tx < targetW; tx++) {
      const sx0 = x0 + (tx * gw) / targetW, sx1 = x0 + ((tx + 1) * gw) / targetW;
      let sum = 0, n = 0;
      for (let sy = Math.floor(sy0); sy < Math.max(Math.ceil(sy1), Math.floor(sy0) + 1); sy++) {
        for (let sx = Math.floor(sx0); sx < Math.max(Math.ceil(sx1), Math.floor(sx0) + 1); sx++) {
          if (sx < 0 || sy < 0 || sx >= m.width || sy >= m.height) continue;
          sum += m.bits[sy * m.width + sx]!; n++;
        }
      }
      cells[ty * GLYPH_W + (tx + xPad)] = n === 0 ? 0 : sum / n;
    }
  }
  return cells;
}

/** Mean squared difference between two normalised glyphs. Lower is better. */
export function glyphDistance(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) { const d = a[i]! - b[i]!; s += d * d; }
  return s / a.length;
}

export interface Template { label: string; cells: Float32Array; samples: number }

export interface MatchResult {
  label: string;
  distance: number;
  /**
   * Gap to the runner-up, as a ratio. A confident match is not one with a small
   * distance, it is one that beats its nearest rival -- `1.0` means the two best
   * candidates were indistinguishable and the label is a coin toss.
   */
  margin: number;
}

export function matchGlyph(g: Float32Array, templates: readonly Template[]): MatchResult | null {
  if (templates.length === 0) return null;
  let best = Infinity, second = Infinity, label = "";
  for (const t of templates) {
    const d = glyphDistance(g, t.cells);
    if (d < best) { second = best; best = d; label = t.label; }
    else if (d < second) second = d;
  }
  return { label, distance: best, margin: second === Infinity ? Infinity : best / Math.max(second, 1e-9) };
}

/**
 * Read a whole number from a box of glyphs.
 *
 * Returns null rather than a partial number when any glyph fails to match
 * confidently. A misread stat silently poisons every recommendation after it,
 * and the caller can always ask the player -- so the bar for returning a value
 * at all is that every digit was clear.
 */
/**
 * The accept thresholds, calibrated rather than chosen.
 *
 * `tools/vision/calibrate.ts` sweeps both bars over 268 held-out field reads and
 * prints the frontier. These are the loosest setting with ZERO wrong reads:
 * 72% of fields read, none of them misread. One notch looser (margin 0.75 at
 * distance 0.14) buys 3 points of read rate and 3 wrong answers.
 *
 * That trade is not close, because the two failures are not comparable. A
 * refused field costs the player one prompt and they can see it happened. A
 * wrong field is a stat the planner believes, silently, for the rest of a
 * 72-turn run.
 */
export const MAX_GLYPH_DISTANCE = 0.10;
export const MAX_GLYPH_MARGIN = 0.45;

export function readNumber(
  glyphs: readonly Glyph[], templates: readonly Template[],
  maxDistance = MAX_GLYPH_DISTANCE, maxMargin = MAX_GLYPH_MARGIN,
): { value: number; confidence: number } | null {
  if (glyphs.length === 0) return null;
  let s = "";
  let worst = 0, worstMargin = 0;
  for (const g of glyphs) {
    const m = matchGlyph(g.cells, templates);
    if (!m || m.distance > maxDistance || m.margin > maxMargin) return null;
    if (!/^[0-9]$/.test(m.label)) return null;
    s += m.label;
    worst = Math.max(worst, m.distance);
    worstMargin = Math.max(worstMargin, m.margin === Infinity ? 0 : m.margin);
  }
  const value = Number(s);
  if (!Number.isFinite(value)) return null;
  return { value, confidence: 1 - Math.max(worst / maxDistance, worstMargin) };
}
