/**
 * The numeric fields, each with the box it lives in and the ink polarity it
 * needs. One place, so a coordinate is never written twice.
 */
import type { RgbaImage, Box } from "./image";
import { inkMask, fractionOfMaxThreshold } from "./image";
import type { RgbaImage as _Rgba } from "./image";
import { segmentGlyphs, readNumber, type Glyph, type SegmentOptions } from "./segment";
import { GLYPH_TEMPLATES } from "./glyphs";
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
  /**
   * A box already in PANEL pixels, used instead of scaling `box`.
   *
   * For the one field whose position cannot be derived from the panel's size --
   * see `chipDiscBottom`.
   */
  panelBox?: Box;
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
    /*
     * NO DROP RULE, AND THE REASON IS THE WORST BUG THIS READER HAS HAD.
     *
     * There used to be one: discard any component reaching within 3 rows of the
     * bottom of the value band, on the theory that the grade letter ("C+", "E")
     * sits in the same cell in the same colour and runs taller than the digits.
     *
     * It never once fired on the capture. Segmented without it, all 140
     * labelled stat values across the corpus produce exactly as many components
     * as they have digits -- the grade letter is already outside the box, cut
     * off by `statDigitsInset`, and component bottoms only ever land on rows 18
     * or 19 of a 23-row band. The guard protected nothing.
     *
     * On the player's own live frame it fired, and it deleted a digit. In his
     * game's rendering the glyph "5" descends one row further than the others,
     * to row 20 -- so speed 135 read as 13 and guts 115 read as 11. Plausible
     * numbers, silently wrong, which is the single failure mode this whole
     * module is built to avoid. It also compared a REFERENCE-pixel row against
     * a PANEL-pixel mask, so on a larger window it would have discarded
     * everything below the middle of the band.
     *
     * And the trade was backwards even in principle. An unexpected EXTRA
     * component -- a grade letter that did get into the box -- cannot produce a
     * wrong number: `readNumber` requires every glyph to match a digit template
     * within the distance bar, so a letter makes the whole field refuse. A
     * DROPPED component produces a wrong number that nothing downstream can
     * detect. The rule swapped a safe failure for an unsafe one.
     *
     * WHAT REPLACES IT is a rule about the glyphs rather than about the box:
     * every digit in one number is the same height, so a component under half
     * the tallest one is not a digit. That catches what the box inset misses --
     * a "F+" grade whose plus sign reaches past the inset and leaves a 2x5
     * fragment beside digits that are 6x17. The player's stamina and wit read
     * as nothing on every frame because of that fragment, while speed, power
     * and guts (plain "F", no plus) read fine. Relative, so it survives a
     * window of any size, and it can only ever remove a component no digit
     * template would have matched anyway.
     */
    segment: { minHeightFractionOfTallest: 0.5 },
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

/**
 * A chip's level, read by sweeping the box a few rows up and down.
 *
 * WHY A SWEEP AND NOT A FIXED BOX. Every other field on this screen scales with
 * the panel and lands where it should. The chip row does not reliably, because
 * the player's window is not always the same crop: his capture came in at
 * 812x1077 against a 812x1080 reference, and the missing three rows are at the
 * TOP -- the chip discs end on the same absolute row in both. Three rows is
 * enough to break this particular field, because the box is 23 rows tall with
 * the facility's NAME directly above it, so a box three rows high catches the
 * name and the field refuses. All five refused, and `readFrame` reports five
 * refusals as `chipLevelsHidden`, which means summer camp. A three-pixel
 * difference in how a window was captured told the planner it was July.
 *
 * WHY NOT ANCHOR TO THE CHIP ITSELF. That was tried: find the coloured disc and
 * hang the box off its bottom edge. It reads the player's frame and it read 19%
 * of the corpus, because "the lowest saturated block in the chip's column" is
 * the swimming pool on some frames and the running track on others. Tightening
 * the search window moved the failures around rather than removing them. The
 * detector was being tuned to the corpus one threshold at a time, which is how
 * you get a number that looks good and a reader that breaks on the next capture.
 *
 * The sweep makes no claim about where the chip is. It tries the scaled box and
 * a few offsets around it, and accepts a value only when every offset that read
 * anything agrees. A disagreement is a refusal, so the failure mode stays the
 * safe one: two offsets reading 1 and 4 means the box is catching something
 * else, and saying nothing is the right answer.
 */
export function readChipLevel(panel: RgbaImage, i: number): number | undefined {
  const sy = panel.height / REF_H;
  const spec = chipLevelField(i, false);
  const base = scaleBox(spec.box, panel.width, panel.height);
  const seen = new Set<number>();
  for (const off of [0, -3, 3, -6, 6]) {
    const dy = off * sy;
    const box: Box = { x0: base.x0, y0: base.y0 + dy, x1: base.x1, y1: base.y1 + dy };
    if (box.y0 < 0 || box.y1 > panel.height) continue;
    const threshold = fractionOfMaxThreshold(panel, box, spec.thresholdFractionOfMax ?? 0.92);
    const glyphs = segmentGlyphs(inkMask(panel, box, spec.polarity, threshold), spec.segment ?? {});
    const got = readNumber(glyphs, GLYPH_TEMPLATES.get(spec.style) ?? []);
    if (got && got.value >= 1 && got.value <= 5) seen.add(got.value);
  }
  return seen.size === 1 ? [...seen][0] : undefined;
}

/** Cut a field out of a panel and return its glyphs, left to right. */
export function fieldGlyphs(panel: RgbaImage, spec: FieldSpec): Glyph[] {
  const box: Box = spec.panelBox ?? scaleBox(spec.box, panel.width, panel.height);
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
 * throughout. The two INHERITANCE events raise them -- Classic and Senior Late
 * March, career turns 30 and 54 -- by whatever the player's parents' sparks
 * give, which is why guts never moves. See `INHERITANCE_TURNS` in `target.ts`
 * and `tools/vision/caps-probe.ts`.
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
