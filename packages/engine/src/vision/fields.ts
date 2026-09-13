/**
 * The numeric fields, each with the box it lives in and the ink polarity it
 * needs. One place, so a coordinate is never written twice.
 */
import type { RgbaImage, Box } from "./image";
import { inkMask, fractionOfMaxThreshold } from "./image";
import { segmentGlyphs, type Glyph, type SegmentOptions } from "./segment";
import {
  LAYOUT, REF_W, REF_H, scaleBox, statValueBox, chipLevelBox, type RefBox,
} from "./layout";

export type FieldStyle = "bigDark" | "bigLight" | "smallChip" | "bigChip";

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
  return segmentGlyphs(mask, spec.segment ?? {});
}

export { REF_W, REF_H };
