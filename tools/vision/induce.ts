/**
 * Build the digit templates from the captured career, using the hand
 * transcription as labels.
 *
 * WHY INDUCE RATHER THAN DRAW. The alternative is to render the game's font
 * and cut glyphs from it, which needs the font, and the font is Cygames'. The
 * transcription already says what number was on screen in 75 frames, so the
 * glyphs can be cut from the player's own capture and labelled by the numbers
 * he already wrote down -- the same principle as the master.mdb extractor.
 *
 * A glyph is only accepted when the segmenter finds EXACTLY as many components
 * as the label has digits. A frame where they disagree is skipped rather than
 * aligned heuristically: aligning "526" onto four components would teach the
 * template set a wrong glyph, and a wrong template is worse than a missing one.
 *
 *   npx tsx tools/vision/induce.ts <panelDir> [out.json]
 */
import { writeFileSync } from "node:fs";
import { loadManifest, loadPanel, loadLabels } from "./corpus";
import { GLYPH_W, GLYPH_H, type Glyph } from "../../packages/engine/src/vision/segment";
import { FIELDS, statField, chipLevelField, fieldGlyphs, type FieldStyle, type FieldSpec } from "../../packages/engine/src/vision/fields";

const panelDir = process.argv[2] ?? "";
const outPath = process.argv[3] ?? "tools/vision/glyphs.json";

if (!panelDir) { console.error("usage: induce.ts <panelDir> [out.json]"); process.exit(1); }

const manifest = loadManifest(panelDir);
const labels = loadLabels("examples/facility-levels-2026-09-05.jsonl");
const STATS = ["speed", "stamina", "power", "guts", "wit"] as const;

interface Acc { sum: Float64Array; n: number }
const acc = new Map<string, Acc>();          // `${style}:${digit}` -> accumulator
const seen = new Map<string, number>();      // how many samples each style saw
let attempted = 0, accepted = 0;

function add(style: FieldStyle, digit: string, g: Glyph): void {
  const key = `${style}:${digit}`;
  let a = acc.get(key);
  if (!a) { a = { sum: new Float64Array(GLYPH_W * GLYPH_H), n: 0 }; acc.set(key, a); }
  for (let i = 0; i < g.cells.length; i++) a.sum[i]! += g.cells[i]!;
  a.n++;
  seen.set(style, (seen.get(style) ?? 0) + 1);
}

function harvest(panel: ReturnType<typeof loadPanel>, spec: FieldSpec, value: number): void {
  attempted++;
  const text = String(value);
  const glyphs = fieldGlyphs(panel, spec);
  if (glyphs.length !== text.length) return;   // disagreement: skip, never align
  accepted++;
  for (let i = 0; i < glyphs.length; i++) add(spec.style, text[i]!, glyphs[i]!);
}

/**
 * The induction set is a GREEDY ALPHABET COVER, not a prefix.
 *
 * A prefix does not work, and the reason is a property of the data rather than
 * of the method: the corpus is one career in chronological order, so facility
 * level 5 does not exist until turn 45 and a "2" in the concert counter is rare
 * early. Inducing from the first N frames leaves whole digits undefined however
 * large N is made, and making N large to chase them defeats the split.
 *
 * So: walk the labelled frames in order and take a frame ONLY if it contributes
 * a (style, digit) pair not already covered. Every other labelled frame is held
 * out. The result is a small set chosen by what it teaches rather than by where
 * it sits, and the held-out set stays large.
 */
const labelledFrames = [...labels.keys()].sort((a, b) => a - b);
const covered = new Set<string>();
const induceSet: number[] = [];
let used = 0;

interface Pending { spec: FieldSpec; value: number }

for (const frame of labelledFrames) {
  const ref = manifest.find((m) => m.frame === frame);
  const label = labels.get(frame);
  if (!ref || !label) continue;

  const pending: Pending[] = [];
  if (typeof label.turnsLeft === "number") pending.push({ spec: FIELDS.turnsLeft, value: label.turnsLeft });
  if (typeof label.concertIn === "number") pending.push({ spec: FIELDS.concertIn, value: label.concertIn });
  if (typeof label.skillPts === "number") pending.push({ spec: FIELDS.skillPts, value: label.skillPts });
  if (label.stats) {
    for (let i = 0; i < STATS.length; i++) {
      const v = label.stats[STATS[i]!];
      if (typeof v === "number") pending.push({ spec: statField(i), value: v });
    }
  }
  if (label.levels && !label.summerCamp) {
    for (let i = 0; i < 5; i++) {
      const v = label.levels[i];
      if (typeof v === "number") pending.push({ spec: chipLevelField(i, label.selected === STATS[i]), value: v });
    }
  }

  const teaches = pending.some((p) =>
    String(p.value).split("").some((d) => !covered.has(`${p.spec.style}:${d}`)));
  if (!teaches) continue;

  const panel = loadPanel(panelDir, ref);
  for (const p of pending) {
    harvest(panel, p.spec, p.value);
    for (const d of String(p.value)) covered.add(`${p.spec.style}:${d}`);
  }
  induceSet.push(frame);
  used++;
}

const templates = [...acc.entries()].map(([key, a]) => {
  const [style, label] = key.split(":") as [FieldStyle, string];
  return { style, label, samples: a.n, cells: Array.from(a.sum, (v) => Number((v / a.n).toFixed(4))) };
}).sort((a, b) => a.style.localeCompare(b.style) || a.label.localeCompare(b.label));

writeFileSync(outPath, JSON.stringify({ glyphW: GLYPH_W, glyphH: GLYPH_H, induceFrames: induceSet, templates }, null, 1));

/**
 * The templates also ship as TypeScript, and that is not redundancy.
 *
 * `tools/` is gitignored, so `glyphs.json` exists only on the machine that ran
 * this. A reader whose templates live in an ignored file works for exactly one
 * person and fails in a fresh clone with no error anyone can read. The induced
 * data is an ARTEFACT of the corpus, not a diagnostic, so it belongs in the
 * package it serves.
 */
const tsPath = "packages/engine/src/vision/glyphs.ts";
const body = templates.map((t) =>
  `  { style: "${t.style}", label: "${t.label}", samples: ${t.samples},\n` +
  `    cells: [${t.cells.join(",")}] },`).join("\n");
writeFileSync(tsPath, `/**
 * Digit templates, induced from the 2026-09-05 capture by
 * \`tools/vision/induce.ts\`. GENERATED -- do not hand-edit; re-run the tool.
 *
 * Cut from the player's own screenshots and labelled by the numbers he had
 * already transcribed, for the same reason the dataset is extracted from his
 * own master.mdb: no font is redistributed and no art is scraped.
 *
 * Induction frames (greedy cover of the digit alphabet): ${induceSet.join(", ")}.
 * Everything else in the corpus is held out, and is what the accuracy in
 * \`docs/m3c-vision.md\` is measured on.
 */
import { GLYPH_W, GLYPH_H, type Template } from "./segment";
import type { FieldStyle } from "./fields";

interface RawTemplate { style: FieldStyle; label: string; samples: number; cells: number[] }

const RAW: RawTemplate[] = [
${body}
];

export const GLYPH_TEMPLATES: ReadonlyMap<FieldStyle, Template[]> = (() => {
  const m = new Map<FieldStyle, Template[]>();
  for (const t of RAW) {
    if (t.cells.length !== GLYPH_W * GLYPH_H) {
      throw new Error(\`template \${t.style}:\${t.label} has \${t.cells.length} cells, expected \${GLYPH_W * GLYPH_H}\`);
    }
    const list = m.get(t.style) ?? [];
    list.push({ label: t.label, samples: t.samples, cells: Float32Array.from(t.cells) });
    m.set(t.style, list);
  }
  return m;
})();
`);
console.log(`-> ${tsPath}`);

console.log(`induction frames (greedy alphabet cover): ${induceSet.length} of ${labelledFrames.length} labelled -> ${induceSet.join(", ")}`);
console.log(`held out for validation: ${labelledFrames.length - induceSet.length}`);
console.log(`field reads attempted ${attempted}, accepted ${accepted} (${((100 * accepted) / Math.max(attempted, 1)).toFixed(0)}%)`);
for (const style of new Set(templates.map((t) => t.style))) {
  const ts = templates.filter((t) => t.style === style);
  console.log(`  ${style.padEnd(12)} digits ${ts.map((t) => t.label).join("")}  samples ${ts.map((t) => `${t.label}:${t.samples}`).join(" ")}`);
}
console.log(`-> ${outPath}`);
