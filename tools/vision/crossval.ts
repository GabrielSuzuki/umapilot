/**
 * Honest accuracy, without starving the templates.
 *
 * A single held-out split forced a choice nothing could win. The digits are
 * badly imbalanced -- chip level 1 appears 96 times in the corpus and level 3
 * eight times -- so a split small enough to leave a real test set gives the
 * rare digits one or two samples, and a template averaged from one sighting is
 * a template of one frame's anti-aliasing. Chasing ten samples each instead ate
 * 69 of 75 frames and left six to test on. Neither is a measurement.
 *
 * k-fold dissolves the choice. Every frame is tested by templates that never
 * saw it, and every template is built from all the samples except one fold's.
 * There is no held-out set to protect and no starvation to trade against it.
 *
 * Folds are assigned by position in frame order, NOT at random: the corpus is
 * one career in sequence, so contiguous blocks would put whole phases of the
 * run in one fold and test early-career templates on late-career glyphs.
 * Interleaving spreads each fold across the whole career.
 *
 *   npx tsx tools/vision/crossval.ts <panelDir> [k]
 */
import { loadManifest, loadPanel, loadLabels, loadCapSegments, applyCapSegments } from "./corpus";
import { readNumber, type Template } from "../../packages/engine/src/vision/segment";
import { fieldGlyphs, type FieldStyle } from "../../packages/engine/src/vision/fields";
import { newAccumulator, harvestFrame, tasksFor } from "./harvest";

const panelDir = process.argv[2] ?? "";
const K = Number(process.argv[3] ?? 5);
const manifest = loadManifest(panelDir);
const labels = loadLabels("examples/facility-levels-2026-09-05.jsonl");
applyCapSegments(labels, loadCapSegments("examples/stat-caps-2026-09-05.json"));

const frames = manifest.map((m) => m.frame).filter((f) => labels.has(f)).sort((a, b) => a - b);
const panels = new Map(manifest.filter((m) => labels.has(m.frame)).map((m) => [m.frame, loadPanel(panelDir, m)]));
const foldOf = new Map(frames.map((f, i) => [f, i % K]));

interface Tally { n: number; read: number; correct: number; wrong: number }
const byField = new Map<string, Tally>();
const byDigit = new Map<string, Tally>();
const t = (m: Map<string, Tally>, k: string): Tally => {
  let v = m.get(k);
  if (!v) { v = { n: 0, read: 0, correct: 0, wrong: 0 }; m.set(k, v); }
  return v;
};
const misreads: string[] = [];

for (let fold = 0; fold < K; fold++) {
  const acc = newAccumulator();
  for (const f of frames) {
    if (foldOf.get(f) === fold) continue;            // train on everything else
    harvestFrame(panels.get(f)!, labels.get(f)!, acc);
  }
  const byStyle = new Map<FieldStyle, Template[]>();
  for (const tpl of acc.templates()) {
    const list = byStyle.get(tpl.style) ?? [];
    list.push({ label: tpl.label, samples: tpl.samples, cells: tpl.cells });
    byStyle.set(tpl.style, list);
  }

  for (const f of frames) {
    if (foldOf.get(f) !== fold) continue;            // test on this fold only
    for (const task of tasksFor(labels.get(f)!, panels.get(f)!)) {
      const fieldKey = task.field.startsWith("chip:") ? "chipLevel" : task.field.startsWith("cap:") ? "statCap" : task.field;
      const a = t(byField, fieldKey), b = t(byDigit, `${task.spec.style}:${task.value}`);
      a.n++; b.n++;
      const got = readNumber(fieldGlyphs(panels.get(f)!, task.spec), byStyle.get(task.spec.style) ?? []);
      if (!got) continue;
      a.read++; b.read++;
      if (got.value === task.value) { a.correct++; b.correct++; }
      else { a.wrong++; b.wrong++; misreads.push(`f${f} ${task.field} want ${task.value} read ${got.value}`); }
    }
  }
}

const pct = (a: number, b: number) => b === 0 ? " n/a" : `${((100 * a) / b).toFixed(0)}%`.padStart(4);
console.log(`\n${K}-fold over ${frames.length} labelled frames — every frame tested by templates that never saw it\n`);
console.log(`  ${"field".padEnd(14)} ${"n".padStart(4)} ${"read".padStart(5)} ${"correct".padStart(8)} ${"WRONG".padStart(6)}`);
let N = 0, R = 0, C = 0, W = 0;
for (const k of [...byField.keys()].sort()) {
  const v = byField.get(k)!;
  N += v.n; R += v.read; C += v.correct; W += v.wrong;
  console.log(`  ${k.padEnd(14)} ${String(v.n).padStart(4)} ${pct(v.read, v.n)} ${pct(v.correct, v.n).padStart(8)} ${String(v.wrong).padStart(6)}`);
}
console.log(`  ${"TOTAL".padEnd(14)} ${String(N).padStart(4)} ${pct(R, N)} ${pct(C, N).padStart(8)} ${String(W).padStart(6)}`);

console.log(`\n  by glyph (style:value) — where the refusals actually live`);
for (const k of [...byDigit.keys()].sort()) {
  const v = byDigit.get(k)!;
  if (v.n < 3) continue;
  console.log(`    ${k.padEnd(16)} ${String(v.n).padStart(4)} ${pct(v.read, v.n)} read${v.wrong ? `   ${v.wrong} WRONG` : ""}`);
}
if (misreads.length) { console.log(`\n  misreads:`); for (const m of misreads.slice(0, 20)) console.log(`    ${m}`); }
