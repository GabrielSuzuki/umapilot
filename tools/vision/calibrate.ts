/**
 * Where to set the reader's accept thresholds.
 *
 * `readNumber` refuses a field unless every glyph is both CLOSE to a template
 * and clearly closer than to the runner-up. Both bars were guesses, and a guess
 * here is not harmless in either direction: too loose and the reader invents a
 * stat, too tight and it refuses fields it could read and the player types them
 * in by hand.
 *
 * The asymmetry is the whole point, and it decides how this is calibrated:
 *
 *   a REFUSED field costs one prompt, and the player knows it happened.
 *   a WRONG field silently poisons every recommendation for the rest of the run.
 *
 * So the rule is not "maximise accuracy". It is: among the settings with ZERO
 * wrong reads on held-out data, take the one that reads the most. This sweeps
 * both bars and prints that frontier.
 *
 *   npx tsx tools/vision/calibrate.ts <panelDir> [glyphs.json]
 */
import { readFileSync } from "node:fs";
import { loadManifest, loadPanel, loadLabels } from "./corpus";
import { readNumber, type Template } from "../../packages/engine/src/vision/segment";
import { FIELDS, statField, chipLevelField, fieldGlyphs, type FieldStyle, type FieldSpec } from "../../packages/engine/src/vision/fields";

const panelDir = process.argv[2] ?? "";
const glyphPath = process.argv[3] ?? "tools/vision/glyphs.json";

const raw = JSON.parse(readFileSync(glyphPath, "utf8")) as {
  induceFrames: number[];
  templates: Array<{ style: FieldStyle; label: string; samples: number; cells: number[] }>;
};
const byStyle = new Map<FieldStyle, Template[]>();
for (const t of raw.templates) {
  const list = byStyle.get(t.style) ?? [];
  list.push({ label: t.label, samples: t.samples, cells: Float32Array.from(t.cells) });
  byStyle.set(t.style, list);
}
const induced = new Set(raw.induceFrames);
const manifest = loadManifest(panelDir);
const labels = loadLabels("examples/facility-levels-2026-09-05.jsonl");
const STATS = ["speed", "stamina", "power", "guts", "wit"] as const;

// Collect every held-out (glyphs, expected) pair ONCE, then sweep in memory --
// decoding 55 panels per grid point would make this a ten-minute job for an
// answer that is pure arithmetic after the first pass.
interface Case { field: string; frame: number; style: FieldStyle; glyphs: ReturnType<typeof fieldGlyphs>; expected: number }
const cases: Case[] = [];
for (const ref of manifest) {
  const label = labels.get(ref.frame);
  if (!label || induced.has(ref.frame)) continue;
  const panel = loadPanel(panelDir, ref);
  const push = (field: string, spec: FieldSpec, expected: number) =>
    cases.push({ field, frame: ref.frame, style: spec.style, glyphs: fieldGlyphs(panel, spec), expected });
  if (typeof label.turnsLeft === "number") push("turnsLeft", FIELDS.turnsLeft, label.turnsLeft);
  if (typeof label.concertIn === "number") push("concertIn", FIELDS.concertIn, label.concertIn);
  if (typeof label.skillPts === "number") push("skillPts", FIELDS.skillPts, label.skillPts);
  if (label.stats) for (let i = 0; i < 5; i++) {
    const v = label.stats[STATS[i]!];
    if (typeof v === "number") push(`stat:${STATS[i]}`, statField(i), v);
  }
  if (label.levels && !label.summerCamp) for (let i = 0; i < 5; i++) {
    const v = label.levels[i];
    if (typeof v === "number") push(`chip:${STATS[i]}`, chipLevelField(i, label.selected === STATS[i]), v);
  }
}
console.log(`held-out field reads: ${cases.length}`);

const DISTS = [0.02, 0.04, 0.06, 0.08, 0.10, 0.14, 0.18, 0.25, 0.35, 0.50];
const MARGINS = [0.30, 0.45, 0.60, 0.75, 0.85, 0.92, 1.00];

console.log(`\nread% (wrong) by maxDistance x maxMargin -- the cell to ship is the highest read% with 0 wrong\n`);
process.stdout.write("  dist\\marg ");
for (const m of MARGINS) process.stdout.write(String(m).padStart(11));
process.stdout.write("\n");
let bestRead = -1, bestCell = "";
for (const d of DISTS) {
  process.stdout.write(`  ${String(d).padEnd(9)} `);
  for (const m of MARGINS) {
    let read = 0, wrong = 0;
    for (const c of cases) {
      const got = readNumber(c.glyphs, byStyle.get(c.style) ?? [], d, m);
      if (!got) continue;
      read++;
      if (got.value !== c.expected) wrong++;
    }
    const cell = `${((100 * read) / cases.length).toFixed(0)}%(${wrong})`;
    process.stdout.write(cell.padStart(11));
    if (wrong === 0 && read > bestRead) { bestRead = read; bestCell = `maxDistance ${d}, maxMargin ${m}`; }
  }
  process.stdout.write("\n");
}
console.log(`\nbest zero-wrong setting: ${bestCell} -> ${bestRead}/${cases.length} read (${((100 * bestRead) / cases.length).toFixed(0)}%)`);
