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
import { loadManifest, loadPanel, loadLabels, loadCapSegments, applyCapSegments } from "./corpus";
import { GLYPH_W, GLYPH_H } from "../../packages/engine/src/vision/segment";
import type { FieldStyle } from "../../packages/engine/src/vision/fields";
import { newAccumulator, harvestFrame } from "./harvest";

const panelDir = process.argv[2] ?? "";
const outPath = process.argv[3] ?? "tools/vision/glyphs.json";

if (!panelDir) { console.error("usage: induce.ts <panelDir> [out.json]"); process.exit(1); }

const manifest = loadManifest(panelDir);
const labels = loadLabels("examples/facility-levels-2026-09-05.jsonl");
applyCapSegments(labels, loadCapSegments("examples/stat-caps-2026-09-05.json"));
const STATS = ["speed", "stamina", "power", "guts", "wit"] as const;

const sharedAcc = newAccumulator();
let attempted = 0, accepted = 0;

/**
 * SHIPPING templates uses every labelled frame. Measuring them does not.
 *
 * The two jobs were conflated at first and it cost real accuracy. Holding
 * frames back to test on starves the rare digits -- chip level 3 appears eight
 * times in the whole corpus -- and a template averaged from one sighting is a
 * template of one frame's anti-aliasing: it read 13% of held-out cases.
 * Chasing ten samples each instead consumed 69 of 75 frames and left six to
 * test on. Neither is a measurement, and the tension is not resolvable inside
 * one split.
 *
 * So it is not resolved here. `crossval.ts` reports accuracy by k-fold, where
 * every frame is tested by templates that never saw it AND every template gets
 * all the samples but one fold's. This file's only job is to build the best
 * templates available, which means using everything.
 */
const labelledFrames = [...labels.keys()].sort((a, b) => a - b);
const induceSet: number[] = [];
let used = 0;

for (const frame of labelledFrames) {
  const ref = manifest.find((m) => m.frame === frame);
  const label = labels.get(frame);
  if (!ref || !label) continue;
  const panel = loadPanel(panelDir, ref);
  const r = harvestFrame(panel, label, sharedAcc);
  attempted += r.attempted;
  accepted += r.accepted;
  if (r.accepted > 0) { induceSet.push(frame); used++; }
}

const templates = sharedAcc.templates().map((t) => ({
  style: t.style as FieldStyle,
  label: t.label,
  samples: t.samples,
  cells: Array.from(t.cells, (v) => Number(v.toFixed(4))),
}));

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
 * Built from all ${used} labelled frames that yielded a glyph. Accuracy is NOT
 * measured against a held-out slice of these -- holding frames back starves the
 * rare digits. See \`tools/vision/crossval.ts\` and \`docs/m3c-vision.md\`.
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

console.log(`templates built from all ${used} labelled frames that yielded a glyph (accuracy comes from crossval.ts, not from a held-out split here)`);
console.log(`field reads attempted ${attempted}, accepted ${accepted} (${((100 * accepted) / Math.max(attempted, 1)).toFixed(0)}%)`);
for (const style of new Set(templates.map((t) => t.style))) {
  const ts = templates.filter((t) => t.style === style);
  console.log(`  ${style.padEnd(12)} digits ${ts.map((t) => t.label).join("")}  samples ${ts.map((t) => `${t.label}:${t.samples}`).join(" ")}`);
}
console.log(`-> ${outPath}`);
