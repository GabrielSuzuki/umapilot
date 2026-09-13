/**
 * Loading the captured career as `RgbaImage`s, plus the hand transcription as
 * labels.
 *
 * The panels are zlib-compressed raw RGBA rather than PNG because `vision/`
 * must not acquire an image-decoding dependency: in production it is handed an
 * `ImageData` straight off a canvas and never decodes anything. Node's zlib is
 * built in, so the harness pays nothing for this.
 */
import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { join } from "node:path";
import type { RgbaImage } from "../../packages/engine/src/vision/image";

export interface PanelRef { frame: number; file: string; width: number; height: number }

export function loadManifest(dir: string): PanelRef[] {
  return JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as PanelRef[];
}

export function loadPanel(dir: string, ref: PanelRef): RgbaImage {
  const raw = inflateSync(readFileSync(join(dir, ref.file)));
  return { width: ref.width, height: ref.height, data: new Uint8ClampedArray(raw.buffer, raw.byteOffset, raw.length) };
}

export interface Label {
  frame: number;
  calendar?: string;
  turnsLeft?: number;
  concertIn?: number;
  selected?: string | null;
  selectedLevel?: number;
  levels?: number[];
  /**
   * Final stats as an ARRAY in STATS order, not an object.
   *
   * Spelled out because reading it as `Record<string, number>` cost the project
   * every stat measurement it thought it had: `label.stats["speed"]` on an array
   * is undefined, silently, so 140 labelled values never reached the templates
   * and never appeared in an accuracy table. The totals still added up, because
   * they were adding up the fields that did work.
   */
  stats?: number[];
  /**
   * Stat CAPS as an array in STATS order, same shape as `stats`.
   *
   * Not in the hand transcription -- it comes from `examples/stat-caps-*.json`
   * via `applyCapSegments`, because the caps hold still for a whole year at a
   * time and writing them out per frame would be 58 copies of three numbers.
   */
  caps?: number[];
  skillPts?: number;
  summerCamp?: boolean;
  action?: string;
  note?: string;
}

export function loadLabels(path: string): Map<number, Label> {
  const out = new Map<number, Label>();
  for (const line of readFileSync(path, "utf8").trim().split("\n")) {
    const r = JSON.parse(line) as Label & { frame?: number };
    if (typeof r.frame !== "number") continue;
    out.set(r.frame, r);
  }
  return out;
}

/**
 * Which frames induce templates and which frames test them.
 *
 * Induce and validate on the same frames and the accuracy number means
 * "these templates can reproduce the glyphs they were built from", which is
 * not a question anybody needs answered. The split is by frame number so it is
 * reproducible and so a reader can check which frames were which.
 *
 * Deliberately SMALL on the induction side: if eight frames are not enough to
 * pin a fixed bitmap font, the approach is wrong and a bigger training set
 * would only hide that.
 */
export const INDUCE_FRAMES = 8;
export function isInductionFrame(frame: number, labelled: number[]): boolean {
  return labelled.slice(0, INDUCE_FRAMES).includes(frame);
}

/**
 * Stat caps, recorded as SEGMENTS rather than per frame.
 *
 * The cap changes twice in the captured career and is constant in between, so
 * the file records the three values and the frame each starts at. Labelling it
 * per frame would be the same three numbers written 58 times, and the first
 * time a frame was mislabelled nobody would spot it among the copies.
 *
 * The first segment is not a reading at all: it is what the Legacy Select
 * screen said before the run started, already recorded in
 * `examples/real-run.json`. That is the anchor that keeps the whole thing from
 * being circular -- the later segments are read off the frames, but they are
 * only trusted because the digits they are read with were taught by a number a
 * human wrote down somewhere else.
 */
export interface CapSegments {
  note?: string;
  segments: { fromFrame: number; caps: number[] }[];
}

export function loadCapSegments(path: string): CapSegments {
  const raw = JSON.parse(readFileSync(path, "utf8")) as CapSegments;
  const segs = [...raw.segments].sort((a, b) => a.fromFrame - b.fromFrame);
  return { ...raw, segments: segs };
}

/** Stamp each label with the caps in force on its frame. */
export function applyCapSegments(labels: Map<number, Label>, segs: CapSegments): void {
  for (const [frame, label] of labels) {
    let caps: number[] | undefined;
    for (const s of segs.segments) if (frame >= s.fromFrame) caps = s.caps;
    if (caps) label.caps = caps;
  }
}
