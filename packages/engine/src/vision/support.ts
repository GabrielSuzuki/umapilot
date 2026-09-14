/**
 * Who is standing on this facility -- the support-card rail down the right edge.
 *
 * WHY THIS IS THE MOST VALUABLE THING ON THE SCREEN. The engine keeps
 * `placement` -- which support cards are on which facility this turn -- and
 * re-rolls it every turn, because nothing ever told it what the game actually
 * showed. So every recommendation was computed against a board that did not
 * exist, and the player's report was "seems to always recommend speed
 * regardless of friendship training". Rainbow is the largest multiplier in the
 * game; for a single turn this is not a refinement of the advice, it is most of
 * the answer.
 *
 * WHAT IS ON THE RAIL. Portraits stacked at a fixed pitch, and they are NOT all
 * support cards: the other trainees at that facility appear in the same column,
 * drawn the same size. The support cards are the ones carrying a TYPE BADGE at
 * the upper left -- a small rounded square in a flat, saturated colour with a
 * white glyph in it. The other trainees have no badge. So counting portraits
 * counts the wrong thing and counting badges counts the right one.
 *
 * The badge also says what the card IS, which is what makes the reading
 * actionable rather than decorative: a green mortarboard is a Wit card, a blue
 * shoe is Speed, a yellow smiley is a Friend card. Combined with the deck the
 * player entered, the types seen on a facility usually name the cards.
 */
import type { RgbaImage } from "./image";
import { REF_W, REF_H } from "./layout";
import type { Stat } from "../../../data/src/types";

/** What a badge says the card is. Friend and group cards have no stat. */
export type SupportKind = Stat | "friend";

export interface SupportSlot {
  /** 0 at the top of the rail. */
  index: number;
  /** The card's type, when the badge hue is one this reader has measured. */
  kind?: SupportKind;
  /**
   * A badge is there and its colour is not one of the measured bands.
   *
   * Reported rather than guessed. The captured career's deck is three Speed,
   * two Wit and one Friend, so those are the only three hues that have ever
   * been measured on a real frame -- a Stamina, Power, Guts or group card would
   * land somewhere this code has never seen. Guessing the nearest band would
   * put a card of the wrong type on the facility, which is worse than saying
   * "there is a card here and I cannot name it".
   */
  unknownBadge?: boolean;
}

/**
 * Rail geometry, in reference pixels, measured off the capture.
 *
 * The pitch comes from two badges on frame 5 at y 165-187 and 259-282, so 94.5
 * between slot centres. Six slots covers the visible column; the rail never
 * showed more than four portraits in the capture, and detection decides how
 * many are really there.
 */
export const RAIL = {
  portraitCentreX: 748,
  firstCentreY: 195,
  pitch: 94.5,
  slots: 6,
  /** The badge, relative to the portrait's centre. Measured 21-22px square. */
  badgeOffset: { x: -31, y: -19 },
  /**
   * Sampled well inside the badge rather than across all of it.
   *
   * The badge's centre is 36px from the portrait's centre, and the rainbow ring
   * a friendship-ready card wears runs at r 36-44 -- so the badge sits exactly
   * on the ring and a box drawn to the badge's real 21px edge catches rainbow at
   * two of its corners. Averaging that with a flat blue gives a hue halfway
   * round the wheel and the card reads as an unrecognised type: 15 of them
   * across the capture, every one a rainbow-ringed Speed or Wit card whose
   * badge a human reads at a glance.
   */
  badgeHalf: 8,
} as const;

/**
 * Hue bands, in degrees, for the badges this reader has actually seen.
 *
 * Measured means measured: blue 202-206 across six frames, green 160, yellow
 * 44. The bands are widened a little around each, and everything else is
 * refused. Stamina, Power, Guts and group cards are missing from this list
 * because the captured deck contains none -- adding guessed bands for them
 * would be inventing data, which is the one thing `CONTRIBUTING.md` forbids.
 */
const HUE_BANDS: Array<{ lo: number; hi: number; kind: SupportKind }> = [
  { lo: 190, hi: 215, kind: "speed" },   // blue, a running shoe
  { lo: 145, hi: 175, kind: "wit" },     // green, a mortarboard
  { lo: 38, hi: 52, kind: "friend" },    // yellow, a smiling face
];

/** Accept thresholds, set from the same frames. See `readSupportRail`. */
const MIN_SATURATED_FRACTION = 0.55;
const MIN_MEAN_SATURATION = 0.55;
const MIN_WHITE_FRACTION = 0.08;
/**
 * How much the badge's colour is allowed to vary in brightness.
 *
 * The badge is a FLAT fill, and that is a stronger statement about it than any
 * threshold on colour: measured across real badges the brightness of their
 * coloured pixels has a standard deviation of 0.0 to 11.5, while the two
 * background patches that survived every other test sat at 28.8. Painted walls
 * have gradients; UI chips do not.
 */
const MAX_VALUE_SD = 18;

function hsv(r: number, g: number, b: number): [number, number, number] {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d !== 0) {
    if (mx === r) h = ((g - b) / d) % 6;
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return [h, mx === 0 ? 0 : d / mx, mx / 255];
}

/**
 * Read the rail.
 *
 * THE THREE TESTS AND WHY EACH ONE IS THERE. A badge is a flat saturated square
 * with a white glyph, so: at least half the box is saturated colour (rules out
 * a portrait's face, which is mostly skin), the mean saturation of that colour
 * is high (rules out the pale background of a gym or a sky), and at least 8% of
 * the box is near-white (rules out a flat saturated BACKGROUND -- a swimming
 * pool fills the box with hue 203 at saturation 0.68 and would otherwise read
 * as a Speed card, which is exactly what it did before this test existed).
 *
 * A fourth test came from the frames that survived the first three: the badge
 * is a FLAT fill, so the brightness of its coloured pixels barely varies
 * (measured SD 0.0-11.5), while a painted wall that happened to pass everything
 * else sat at 28.8.
 *
 * On the seven frames these were set from, the reader finds the same badges a
 * human counts off the rail: 2, 2, 2, 1, 2, 1 and 0. Across all 58 captured
 * training frames it never reports more cards of a type than the deck holds,
 * which is the one check available without labels.
 */
export function readSupportRail(panel: RgbaImage): SupportSlot[] {
  const sx = panel.width / REF_W, sy = panel.height / REF_H;
  const out: SupportSlot[] = [];

  for (let i = 0; i < RAIL.slots; i++) {
    const cy = RAIL.firstCentreY + RAIL.pitch * i;
    const bx = (RAIL.portraitCentreX + RAIL.badgeOffset.x) * sx;
    const by = (cy + RAIL.badgeOffset.y) * sy;
    const hx = RAIL.badgeHalf * sx, hy = RAIL.badgeHalf * sy;
    const x0 = Math.max(0, Math.round(bx - hx)), x1 = Math.min(panel.width, Math.round(bx + hx));
    const y0 = Math.max(0, Math.round(by - hy)), y1 = Math.min(panel.height, Math.round(by + hy));
    if (x1 <= x0 || y1 <= y0) continue;

    // A HISTOGRAM, NOT A MEAN. The mean hue of a contaminated box is a colour
    // that is not in the box at all. The badge is a flat fill, so its hue is
    // the mode by a wide margin, and a few ring or sparkle pixels cannot move
    // it -- they can only fail to outvote it.
    const HUE_BINS = 36;
    const bins = new Float64Array(HUE_BINS);
    let n = 0, satN = 0, whiteN = 0, satSum = 0, vSum = 0, vSum2 = 0;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const o = (y * panel.width + x) * 4;
        const r = panel.data[o]!, g = panel.data[o + 1]!, b = panel.data[o + 2]!;
        n++;
        const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
        if (mn > 205) whiteN++;
        if (mx - mn > 60 && mx > 120) {
          satN++;
          const [h, s] = hsv(r, g, b);
          satSum += s;
          bins[Math.min(HUE_BINS - 1, Math.floor((h / 360) * HUE_BINS))]! += 1;
          vSum += mx; vSum2 += mx * mx;
        }
      }
    }
    if (n === 0 || satN === 0) continue;
    if (satN / n < MIN_SATURATED_FRACTION) continue;
    if (satSum / satN < MIN_MEAN_SATURATION) continue;
    if (whiteN / n < MIN_WHITE_FRACTION) continue;
    const vMean = vSum / satN;
    if (Math.sqrt(Math.max(0, vSum2 / satN - vMean * vMean)) > MAX_VALUE_SD) continue;

    let top = 0;
    for (let k = 1; k < HUE_BINS; k++) if (bins[k]! > bins[top]!) top = k;
    // The mode has to be a real majority of the coloured pixels, or the box is
    // not showing a flat badge and nothing should be claimed about it.
    if (bins[top]! / satN < 0.45) { out.push({ index: i, unknownBadge: true }); continue; }
    const hue = (top + 0.5) * (360 / HUE_BINS);
    const band = HUE_BANDS.find((z) => hue >= z.lo && hue <= z.hi);
    out.push(band ? { index: i, kind: band.kind } : { index: i, unknownBadge: true });
  }
  return out;
}

/** How many support cards the rail says are on this facility. */
export function supportCount(slots: readonly SupportSlot[]): number {
  return slots.length;
}
