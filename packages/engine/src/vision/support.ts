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
 * WHAT IS ON THE RAIL. Portraits stacked at an even pitch, and they are NOT all
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
 * Rail geometry, FITTED per frame rather than assumed.
 *
 * The first version hard-coded the slots: first badge centre at y 176, pitch
 * 94.5, measured off the captured career. That read 130 badges across the
 * capture with nothing impossible, and then failed on the player's live frames
 * -- it found one of three cards on his Wit facility and invented one on Guts.
 *
 * The rail's origin and spacing MOVE. Across four of his frames the pitch is 97
 * to 98 where the capture says 94.5, and the first portrait starts at a
 * different height depending on how many are stacked. Worse, the badges are not
 * a prefix: a trainee can sit at the top with cards below it, so "the first N
 * slots" is wrong in both directions.
 *
 * What does hold is that the badges are EVENLY SPACED. So origin and pitch are
 * fitted per frame over a small grid, scored by how many of the six positions
 * pass the badge tests below. That is one structure being fitted -- the rail is
 * a column at a constant pitch -- not a threshold being tuned, which matters
 * because the threshold-tuning version of this took four attempts and got
 * worse each time.
 */
export const RAIL = {
  badgeCentreX: 719,
  /** Where the first badge can start, and how far apart they can be. */
  originRange: { lo: 160, hi: 230 },
  pitchRange: { lo: 92, hi: 102 },
  slots: 6,
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

const HUE_BINS = 36;
const MIN_SATURATED_FRACTION = 0.55;
const MIN_MEAN_SATURATION = 0.55;
const MIN_WHITE_FRACTION = 0.08;
const MAX_VALUE_SD = 18;
const MIN_MODE_SHARE = 0.45;
const MAX_HALO_SAME_HUE = 0.40;

function hsv(r: number, g: number, b: number): [number, number] {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d !== 0) {
    if (mx === r) h = ((g - b) / d) % 6;
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return [h, mx === 0 ? 0 : d / mx];
}

/**
 * Is there a type badge centred here?
 *
 * FIVE TESTS, each one added because the previous set let something through,
 * and the last two are the ones that matter away from the captured career:
 *
 *   at least 55% of the box is saturated colour  (rules out a face)
 *   that colour is strongly saturated            (rules out a pale background)
 *   at least 8% of the box is near-white         (rules out a flat blue POOL,
 *                                                 which reads as a Speed badge)
 *   the colour's brightness barely varies        (rules out a painted wall:
 *                                                 real badges measure SD
 *                                                 0.0-11.5, walls 28.8)
 *   the halo around it is a DIFFERENT colour     (rules out sky and grass, which
 *                                                 pass all four of the above --
 *                                                 a badge has an edge, a sky
 *                                                 does not)
 *
 * The hue is taken as the MODE, not the mean. The badge sits 36 px from its
 * portrait's centre and the rainbow ring a friendship-ready card wears runs at
 * r 36-44, so the badge sits exactly on the ring and a mean hue is a colour
 * that is not in the box at all -- 15 unrecognised badges across the capture,
 * every one a rainbow-ringed card whose badge a human reads at a glance.
 */
function badgeAt(
  panel: RgbaImage, cx: number, cy: number, hx: number, hy: number,
): { bin: number; share: number } | null {
  let n = 0, satN = 0, whiteN = 0, satSum = 0, vSum = 0, vSum2 = 0;
  const bins = new Float64Array(HUE_BINS);
  for (let y = cy - hy; y < cy + hy; y++) {
    for (let x = cx - hx; x < cx + hx; x++) {
      if (y < 0 || y >= panel.height || x < 0 || x >= panel.width) return null;
      const o = (y * panel.width + x) * 4;
      const r = panel.data[o]!, g = panel.data[o + 1]!, b = panel.data[o + 2]!;
      n++;
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      if (mn > 205) whiteN++;
      if (mx - mn > 60 && mx > 120) {
        satN++;
        const [h, sat] = hsv(r, g, b);
        satSum += sat;
        bins[Math.min(HUE_BINS - 1, Math.floor((h / 360) * HUE_BINS))]! += 1;
        vSum += mx; vSum2 += mx * mx;
      }
    }
  }
  if (n === 0 || satN === 0) return null;
  if (satN / n < MIN_SATURATED_FRACTION) return null;
  if (satSum / satN < MIN_MEAN_SATURATION) return null;
  if (whiteN / n < MIN_WHITE_FRACTION) return null;
  const vMean = vSum / satN;
  if (Math.sqrt(Math.max(0, vSum2 / satN - vMean * vMean)) > MAX_VALUE_SD) return null;
  let top = 0;
  for (let k = 1; k < HUE_BINS; k++) if (bins[k]! > bins[top]!) top = k;
  const share = bins[top]! / satN;
  if (share < MIN_MODE_SHARE) return null;

  let outN = 0, outSame = 0;
  const ox = hx + Math.round(hx * 0.8), oy = hy + Math.round(hy * 0.8);
  for (let y = cy - oy; y < cy + oy; y++) {
    for (let x = cx - ox; x < cx + ox; x++) {
      if (y >= cy - hy && y < cy + hy && x >= cx - hx && x < cx + hx) continue;
      if (y < 0 || y >= panel.height || x < 0 || x >= panel.width) continue;
      const o = (y * panel.width + x) * 4;
      const r = panel.data[o]!, g = panel.data[o + 1]!, b = panel.data[o + 2]!;
      outN++;
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      if (mx - mn > 60 && mx > 120) {
        const [h] = hsv(r, g, b);
        if (Math.min(HUE_BINS - 1, Math.floor((h / 360) * HUE_BINS)) === top) outSame++;
      }
    }
  }
  if (outN > 0 && outSame / outN > MAX_HALO_SAME_HUE) return null;
  return { bin: top, share };
}

/**
 * Read the rail: fit the column, then name what is in it.
 *
 * Measured on the captured career: 129 badges across 58 training frames, none
 * unrecognised, and never more cards of a type than the deck holds -- which is
 * the only check available, since the transcription never recorded who was on a
 * facility. On four frames the player sent from a live run, with the true
 * answer written down beside them, three are exactly right and the fourth
 * invents one card out of a grass bank.
 */
export function readSupportRail(panel: RgbaImage): SupportSlot[] {
  const sx = panel.width / REF_W, sy = panel.height / REF_H;
  const hx = Math.round(RAIL.badgeHalf * sx), hy = Math.round(RAIL.badgeHalf * sy);
  const cx = Math.round(RAIL.badgeCentreX * sx);

  let bestHits: Array<{ y: number; bin: number }> = [];
  let bestScore = 0;
  for (let origin = Math.round(RAIL.originRange.lo * sy); origin <= Math.round(RAIL.originRange.hi * sy); origin++) {
    for (let pitchRef = RAIL.pitchRange.lo; pitchRef <= RAIL.pitchRange.hi; pitchRef++) {
      const pitch = pitchRef * sy;
      const hits: Array<{ y: number; bin: number }> = [];
      let score = 0;
      for (let k = 0; k < RAIL.slots; k++) {
        const cy = Math.round(origin + pitch * k);
        if (cy - hy < 0 || cy + hy >= panel.height) break;
        const b = badgeAt(panel, cx, cy, hx, hy);
        // Scored by count first and confidence second, so a fit that finds one
        // more card always beats a tidier fit that finds fewer.
        if (b) { hits.push({ y: cy, bin: b.bin }); score += 1 + b.share; }
      }
      if (score > bestScore) { bestScore = score; bestHits = hits; }
    }
  }

  return bestHits.map((h, i) => {
    const hue = ((h.bin + 0.5) * 360) / HUE_BINS;
    const band = HUE_BANDS.find((z) => hue >= z.lo && hue <= z.hi);
    return band ? { index: i, kind: band.kind } : { index: i, unknownBadge: true };
  });
}

/** How many support cards the rail says are on this facility. */
export function supportCount(slots: readonly SupportSlot[]): number {
  return slots.length;
}
