/**
 * Read a dropped screenshot into the turn state.
 *
 * `interaction-design.md` argues for continuous capture and zero interactions a
 * turn. That is layer three, it needs a browser permission and a capture loop,
 * and only the player can test it. This is the step in between and it is worth
 * having on its own: drop a PrtScn on the page and the fields fill in.
 *
 * WHAT IT REFUSES IS THE FEATURE. The reader returns a number only when every
 * glyph was unambiguous -- 77% of 916 cross-validated fields, with one wrong
 * (a chip level with a sparkle sitting on it). So a scan is not "here is your
 * state"; it is "here is what I could
 * actually see, and here is what you still have to check". A field the reader
 * declined is left exactly as it was and is listed by name.
 */
import { STATS, type Stat } from "../../data/src/types";
import { findPanel } from "../../engine/src/vision/classify";
import { cropImage } from "../../engine/src/vision/layout";
import { readFrame, type FrameReading } from "../../engine/src/vision/read";
import type { RgbaImage } from "../../engine/src/vision/image";
import type { Editable } from "./run";

export interface ScanResult {
  ok: boolean;
  /** Why it could not be used, in words a player can act on. */
  problem?: string;
  reading?: FrameReading;
  /** Fields taken from the frame, by display name. */
  filled: string[];
  /** Fields the reader declined, which the player must still check. */
  refused: string[];
  /** Facility levels read off the chips, when they were legible. */
  facilityLevels?: Partial<Record<Stat, number>>;
  ms: number;
}

/**
 * Decode a dropped file to raw pixels.
 *
 * `createImageBitmap` + `OffscreenCanvas` keeps the decode off the DOM and
 * hands back exactly the `ImageData` the reader wants. Nothing is uploaded --
 * the file never leaves the page, which is the same promise `scan-spec.md`
 * makes about the pre-run scan and the reason both stay client-side.
 */
export async function imageFromFile(file: File): Promise<RgbaImage> {
  const bitmap = await createImageBitmap(file);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("this browser will not give a 2d canvas context");
  ctx.drawImage(bitmap, 0, 0);
  const data = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
  bitmap.close();
  return { width: data.width, height: data.height, data: data.data };
}

export function scanImage(img: RgbaImage): ScanResult {
  const t0 = performance.now();
  const found = findPanel(img);
  if (!found) {
    return {
      ok: false,
      problem:
        "Could not find a training screen in that image. The panel is located by " +
        "the shape of the training screen itself, so a menu, a race dialog or an " +
        "event card will not be found even though the game is on screen. Drop a " +
        "shot of the turn screen, or one cropped to the game window.",
      filled: [], refused: [], ms: performance.now() - t0,
    };
  }

  const reading = readFrame(cropImage(img, found.box));
  const filled: string[] = [], refused: string[] = [];
  const note = (name: string, got: boolean) => (got ? filled : refused).push(name);

  note("turns left", reading.turnsLeft !== undefined);
  note("concert countdown", reading.concertIn !== undefined);
  note("skill points", reading.skillPts !== undefined);
  for (const s of STATS) note(s, reading.stats[s] !== undefined);
  // The caps are reported as ONE field rather than five, because the player
  // does not act on them individually -- they are pushed into the run setup,
  // and what he needs to know is whether this frame had anything to say about
  // them at all.
  note("stat caps", Object.keys(reading.statCaps).length > 0);
  note("selected facility", reading.selected !== undefined);

  return {
    ok: true,
    reading,
    filled,
    refused,
    facilityLevels: reading.facilityLevels,
    ms: performance.now() - t0,
  };
}

/**
 * Fold a reading into the editable state, leaving refused fields untouched.
 *
 * Returns a NEW object rather than mutating, so a scan that reads badly can be
 * discarded without having half-overwritten what the player typed.
 *
 * `turnsLeft` is deliberately NOT written to `turn`. The screen counts turns
 * remaining until the next goal, not turns elapsed in the career, and the two
 * are different numbers that happen to look alike -- writing one into the other
 * would be a silent, plausible, wrong answer of exactly the kind the reader's
 * refusals exist to avoid. The calendar carries the real turn and the reader
 * cannot read text yet.
 */
export function applyScan(current: Editable, r: FrameReading): Editable {
  const stats = { ...current.stats };
  for (const s of STATS) {
    const v = r.stats[s];
    if (v !== undefined) stats[s] = v;
  }
  return {
    ...current,
    stats,
    skillPoints: r.skillPts ?? current.skillPoints,
  };
}
