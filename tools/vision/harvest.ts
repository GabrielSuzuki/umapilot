/**
 * Cutting labelled glyphs out of frames. Shared by the tool that SHIPS
 * templates and the one that MEASURES them, so the two can never drift into
 * measuring something other than what is shipped.
 */
import type { RgbaImage } from "../../packages/engine/src/vision/image";
import { GLYPH_W, GLYPH_H, type Glyph } from "../../packages/engine/src/vision/segment";
import { FIELDS, statField, chipLevelField, fieldGlyphs, type FieldStyle, type FieldSpec } from "../../packages/engine/src/vision/fields";
import type { Label } from "./corpus";

export const STATS = ["speed", "stamina", "power", "guts", "wit"] as const;

export interface Task { field: string; spec: FieldSpec; value: number }

/** Every labelled field on one frame, with where to find it. */
export function tasksFor(label: Label): Task[] {
  const out: Task[] = [];
  if (typeof label.turnsLeft === "number") out.push({ field: "turnsLeft", spec: FIELDS.turnsLeft, value: label.turnsLeft });
  if (typeof label.concertIn === "number") out.push({ field: "concertIn", spec: FIELDS.concertIn, value: label.concertIn });
  if (typeof label.skillPts === "number") out.push({ field: "skillPts", spec: FIELDS.skillPts, value: label.skillPts });
  if (label.stats) {
    for (let i = 0; i < 5; i++) {
      const v = label.stats[STATS[i]!];
      if (typeof v === "number") out.push({ field: `stat:${STATS[i]}`, spec: statField(i), value: v });
    }
  }
  // Summer camp hides the chip levels entirely, so those frames teach nothing
  // about chip digits and must not be asked to.
  if (label.levels && !label.summerCamp) {
    for (let i = 0; i < 5; i++) {
      const v = label.levels[i];
      if (typeof v === "number") {
        out.push({ field: `chip:${STATS[i]}`, spec: chipLevelField(i, label.selected === STATS[i]), value: v });
      }
    }
  }
  return out;
}

export interface Accumulator {
  add(style: FieldStyle, digit: string, g: Glyph): void;
}

export function newAccumulator() {
  const acc = new Map<string, { sum: Float64Array; n: number }>();
  return {
    add(style: FieldStyle, digit: string, g: Glyph) {
      const key = `${style}:${digit}`;
      let a = acc.get(key);
      if (!a) { a = { sum: new Float64Array(GLYPH_W * GLYPH_H), n: 0 }; acc.set(key, a); }
      for (let i = 0; i < g.cells.length; i++) a.sum[i]! += g.cells[i]!;
      a.n++;
    },
    /** Averaged templates, ready to match against. */
    templates() {
      return [...acc.entries()].map(([key, a]) => {
        const [style, label] = key.split(":") as [FieldStyle, string];
        return { style, label, samples: a.n, cells: Float32Array.from(a.sum, (v) => v / a.n) };
      }).sort((x, y) => x.style.localeCompare(y.style) || x.label.localeCompare(y.label));
    },
  };
}

/**
 * Harvest one frame into an accumulator.
 *
 * A glyph is taken only when the segmenter finds exactly as many components as
 * the label has digits. A disagreement is skipped rather than aligned: teaching
 * a wrong glyph is worse than missing one, and there is no way to tell which
 * component went wrong.
 */
export function harvestFrame(
  panel: RgbaImage, label: Label, acc: ReturnType<typeof newAccumulator>,
): { attempted: number; accepted: number } {
  let attempted = 0, accepted = 0;
  for (const t of tasksFor(label)) {
    attempted++;
    const text = String(t.value);
    const glyphs = fieldGlyphs(panel, t.spec);
    if (glyphs.length !== text.length) continue;
    accepted++;
    for (let i = 0; i < glyphs.length; i++) acc.add(t.spec.style, text[i]!, glyphs[i]!);
  }
  return { attempted, accepted };
}
