/**
 * The numeric fields, each with the box it lives in and the ink polarity it
 * needs. One place, so a coordinate is never written twice.
 */
import type { RgbaImage, Box } from "./image";
import { inkMask, fractionOfMaxThreshold } from "./image";
import type { RgbaImage as _Rgba } from "./image";
import { segmentGlyphs, type Glyph, type SegmentOptions } from "./segment";
import {
  LAYOUT, REF_W, REF_H, scaleBox, statValueBox, chipLevelBox, statCapBox, type RefBox,
} from "./layout";

export type FieldStyle = "bigDark" | "bigLight" | "smallChip" | "bigChip" | "capSmall";

export interface FieldSpec {
  box: RefBox;
  polarity: "dark" | "light";
  threshold: number;
  /**
   * Which template set this field's glyphs belong to.
   *
   * Not cosmetic. The same digit is drawn at three different sizes and two
   * polarities on this screen, and a shared template set would average a
   * 40px-tall stat digit with a 12px-tall chip level into a blur that matches
   * neither. Grouping by how the glyph is DRAWN, not by what it means, is what
   * keeps each set sharp.
   */
  style: FieldStyle;
  /**
   * When set, `threshold` is ignored and the cut is taken at this fraction of
   * the box's own maximum white-distance. Needed wherever the glyph's colour is
   * not fixed -- see `fractionOfMaxThreshold`.
   */
  thresholdFractionOfMax?: number;
  segment?: SegmentOptions;
  /**
   * Drop this many components off the LEFT before matching.
   *
   * Only the cap row uses it, and only for the "/" that always precedes the
   * number. Dropping it by position is exact -- it is the leftmost component
   * and it is always there -- where cropping it out by x is not, because the
   * slash sits at a scale-dependent offset and a box tight enough to exclude it
   * clips the first digit on a smaller panel.
   */
  dropLeading?: number;
}

export const FIELDS = {
  turnsLeft: { box: LAYOUT.turnsLeft, polarity: "dark", threshold: 60, style: "bigDark" },
  concertIn: { box: LAYOUT.concertIn, polarity: "light", threshold: 60, style: "bigLight" },
  skillPts: {
    // Inset past BOTH cell borders. At +3/-3 the right border survived as a
    // three-pixel column, segmented as a fourth glyph, and every read of this
    // field was refused -- 0 of 27. A field that reads nothing looks like a hard
    // problem and was a box three pixels too wide.
    box: { x0: LAYOUT.skillPts.x0 + 6, y0: LAYOUT.skillPts.y0, x1: LAYOUT.skillPts.x1 - 9, y1: LAYOUT.skillPts.y1 },
    polarity: "dark", threshold: 60, style: "bigDark",
  },
} as const satisfies Record<string, FieldSpec>;

/** The five stat values share a spec apart from their box. */
export function statField(i: number): FieldSpec {
  return {
    box: statValueBox(i),
    polarity: "dark",
    threshold: 60,
    style: "bigDark",
    // The grade letter ("C+", "E") sits in the same cell, in the same colour,
    // and is TALLER than the digits -- it runs down into the cap row. Dropping
    // anything that reaches the bottom of the value band removes it without
    // cropping by x, which would fail as soon as a stat reaches four digits.
    segment: { dropIfReachesRow: LAYOUT.statValueBand.y1 - LAYOUT.statValueBand.y0 - 3 },
  };
}

/**
 * A facility chip's level digit.
 *
 * The chip prints "Lvl N" centred, so the digit sits at a fixed offset from the
 * chip's centre -- but only when the chip is NOT the selected one, which rides
 * higher and is restyled. And during summer camp the chips print no level at
 * all. Both are the caller's problem to know about; this only says where to
 * look if there is something to find.
 */
export function chipLevelField(i: number, selected: boolean): FieldSpec {
  const cx = LAYOUT.chipCentreX[i]!;
  // Measured off the chips, not derived: the selected chip rides 40px higher
  // AND is set larger, so its digit sits at a different offset from the centre
  // as well as a different height. One offset for both would miss one of them.
  // The y0 values are tight against the DIGIT, not against the label. A box
  // that starts a few pixels higher catches the descenders of the facility name
  // printed above ("Speed", "Stamina"), which segment as an extra component and
  // make the whole field refuse. At y0 936 that cost every Power chip and most
  // Stamina ones -- 0% and 23% read, with the digit sitting there perfectly
  // legible three rows below.
  const box = selected
    ? { x0: cx + 14, y0: 899, x1: cx + 48, y1: 930 }
    : { x0: cx + 10, y0: 941, x1: cx + 40, y1: 964 };
  return {
    box,
    polarity: "dark",
    threshold: 0,
    // The glyph is the furthest thing from white inside its own box, whatever
    // colour the facility paints it.
    thresholdFractionOfMax: 0.92,
    style: selected ? "bigChip" : "smallChip",
    segment: { minHeight: 8 },
  };
}

/** Cut a field out of a panel and return its glyphs, left to right. */
export function fieldGlyphs(panel: RgbaImage, spec: FieldSpec): Glyph[] {
  const box: Box = scaleBox(spec.box, panel.width, panel.height);
  const threshold = spec.thresholdFractionOfMax !== undefined
    ? fractionOfMaxThreshold(panel, box, spec.thresholdFractionOfMax)
    : spec.threshold;
  const mask = inkMask(panel, box, spec.polarity, threshold);
  const glyphs = segmentGlyphs(mask, spec.segment ?? {});
  return spec.dropLeading ? glyphs.slice(spec.dropLeading) : glyphs;
}

/**
 * A stat's cap, the "/1625" printed under its value.
 *
 * ITS OWN TEMPLATE SET, not `bigDark`, and the measurement says why: the
 * cap digits are drawn at roughly half the height of the value digits, and
 * matching them against value templates reads 16 of 40 known caps -- refusing
 * the rest rather than getting them wrong, but refusing most of them. Templates
 * cut from the cap row itself read 290 of 290. The normalisation to 12x16 makes
 * the sizes comparable, not identical: a 40px digit downsampled and a 20px
 * digit upsampled do not land on the same anti-aliasing.
 *
 * WORTH READING AT ALL because the cap MOVES during a run. It was taken for a
 * per-run constant, set by legacy at the Legacy Select screen, and the captured
 * career disproves it: speed went 1625 -> 1630 -> 1635, stamina 1332 -> 1336 ->
 * 1342, power 1332 -> 1337 -> 1343, wit 1300 -> 1300 -> 1304, guts 1500
 * throughout. Both steps land on the first turn of a new year. See
 * `tools/vision/caps-probe.ts`.
 */
export function capField(i: number): FieldSpec {
  return {
    box: statCapBox(i),
    polarity: "dark",
    threshold: 60,
    style: "capSmall",
    // The "/" is a component like any other and would be matched as a digit.
    dropLeading: 1,
    segment: { minHeight: 6 },
  };
}

export { REF_W, REF_H };

/**
 * Which facility is selected, from the chevrons rather than the digits.
 *
 * The first approach read the selected chip's level digit at its raised offset
 * and inferred the selection from which chip answered there. It worked and it
 * was fragile: 45% on held-out frames, because the game paints an animated
 * SPARKLE over the selected chip and the sparkle is near-white, so it punches
 * holes in the glyph and the segmenter returns fragments. That is the same
 * overlay that corrupted the hand transcription in `replay-validation.md`
 * Part 3, where a sparkle on a level digit turned a 3 into a 5.
 *
 * The chevron stack under the selected chip has no such problem. It is large,
 * saturated yellow, in a fixed place, present under exactly one chip, and
 * nothing else on the screen looks like it. 58 of 58 labelled frames, including
 * summer camp turns where the chips hide their levels entirely -- which is the
 * case the digit approach could never have handled at all.
 *
 * The lesson generalises past this function: the digit was the obvious signal
 * because it was the one already being read, not because it was the best one.
 */
export function selectedFacility(panel: RgbaImage): { index: number; score: number } | null {
  const sx = panel.width / REF_W, sy = panel.height / REF_H;
  const { y0, y1, halfWidth } = LAYOUT.chevronBand;
  const scores = LAYOUT.chipCentreX.map((cx) => {
    let hits = 0, n = 0;
    const xa = Math.round((cx - halfWidth) * sx), xb = Math.round((cx + halfWidth) * sx);
    const ya = Math.round(y0 * sy), yb = Math.round(y1 * sy);
    for (let y = Math.max(0, ya); y < Math.min(panel.height, yb); y++) {
      let i = (y * panel.width + Math.max(0, xa)) * 4;
      for (let x = Math.max(0, xa); x < Math.min(panel.width, xb); x++, i += 4) {
        if (panel.data[i]! > 200 && panel.data[i + 1]! > 150 && panel.data[i + 2]! < 120) hits++;
        n++;
      }
    }
    return n === 0 ? 0 : hits / n;
  });

  let best = -1, bestI = -1, second = -1;
  scores.forEach((s, i) => {
    if (s > best) { second = best; best = s; bestI = i; }
    else if (s > second) second = s;
  });
  // A FLOOR, AND NO MARGIN. Both were guesses at first and the margin was
  // wrong: swept over the corpus, requiring the winner to beat the runner-up by
  // 2x cost 7 of 58 reads and prevented nothing, because the two can sit at a
  // ratio of 1.03 and plain argmax still picks correctly. The floor is the gate
  // that earns its place -- the weakest true chevron score seen is 0.31, so
  // 0.05 is fifteen times clear of it and still refuses a frame with no
  // chevrons at all.
  if (bestI < 0 || best < 0.05) return null;
  void second;
  return { index: bestI, score: best };
}
