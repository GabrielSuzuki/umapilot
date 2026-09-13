/**
 * Read every held-out frame and compare against the hand transcription.
 *
 * The transcription is the only ground truth this project has for what was on
 * screen, and it was written by hand from the same images, so it is not
 * infallible -- Part 3 of `replay-validation.md` had to correct it twice. Where
 * the reader and the transcription disagree, BOTH are suspects, and the
 * disagreement list below is printed in full for exactly that reason.
 *
 * Reported per field:
 *   read      -- the reader returned a number at all
 *   correct   -- and it matched the label
 *   wrong     -- it returned a number and the number was wrong. This is the
 *                number that matters. A field that declines to guess costs a
 *                prompt to the player; a field that guesses wrong poisons every
 *                recommendation after it and nobody finds out.
 *
 *   npx tsx tools/vision/validate.ts <panelDir> [glyphs.json]
 */
import { readFileSync } from "node:fs";
import { loadManifest, loadPanel, loadLabels } from "./corpus";
import { readNumber, type Template } from "../../packages/engine/src/vision/segment";
import { FIELDS, statField, chipLevelField, fieldGlyphs, type FieldStyle, type FieldSpec } from "../../packages/engine/src/vision/fields";

const panelDir = process.argv[2] ?? "";
const glyphPath = process.argv[3] ?? "tools/vision/glyphs.json";
if (!panelDir) { console.error("usage: validate.ts <panelDir> [glyphs.json]"); process.exit(1); }

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

const manifest = loadManifest(panelDir);
const labels = loadLabels("examples/facility-levels-2026-09-05.jsonl");
const STATS = ["speed", "stamina", "power", "guts", "wit"] as const;
const induced = new Set(raw.induceFrames);

interface Tally { n: number; read: number; correct: number; wrong: number; misses: string[] }
const tally = new Map<string, Tally>();
const t = (k: string): Tally => {
  let v = tally.get(k);
  if (!v) { v = { n: 0, read: 0, correct: 0, wrong: 0, misses: [] }; tally.set(k, v); }
  return v;
};

function check(field: string, frame: number, spec: FieldSpec, expected: number): void {
  const v = t(field);
  v.n++;
  const templates = byStyle.get(spec.style) ?? [];
  const got = readNumber(fieldGlyphs(loadPanelCached(frame), spec), templates);
  if (!got) { v.misses.push(`f${frame} want ${expected} -> no read`); return; }
  v.read++;
  if (got.value === expected) v.correct++;
  else { v.wrong++; v.misses.push(`f${frame} want ${expected} -> READ ${got.value}`); }
}

let cacheFrame = -1;
let cachePanel: ReturnType<typeof loadPanel> | null = null;
function loadPanelCached(frame: number) {
  if (cacheFrame !== frame || !cachePanel) {
    const ref = manifest.find((m) => m.frame === frame)!;
    cachePanel = loadPanel(panelDir, ref);
    cacheFrame = frame;
  }
  return cachePanel;
}

for (const ref of manifest) {
  const label = labels.get(ref.frame);
  if (!label || induced.has(ref.frame)) continue;   // held out only

  if (typeof label.turnsLeft === "number") check("turnsLeft", ref.frame, FIELDS.turnsLeft, label.turnsLeft);
  if (typeof label.concertIn === "number") check("concertIn", ref.frame, FIELDS.concertIn, label.concertIn);
  if (typeof label.skillPts === "number") check("skillPts", ref.frame, FIELDS.skillPts, label.skillPts);
  if (label.stats) {
    for (let i = 0; i < STATS.length; i++) {
      const v = label.stats[STATS[i]!];
      if (typeof v === "number") check(`stat:${STATS[i]}`, ref.frame, statField(i), v);
    }
  }
  if (label.levels) {
    // Summer camp hides the chip levels entirely and prints Lvl 5 on the
    // banner, so those frames are excluded from the chip tally rather than
    // counted as failures -- the reader is supposed to decline there, and
    // `read.ts` is what has to know it.
    if (!label.summerCamp) {
      for (let i = 0; i < 5; i++) {
        const v = label.levels[i];
        if (typeof v === "number") {
          check(`chipLevel:${STATS[i]}`, ref.frame, chipLevelField(i, label.selected === STATS[i]), v);
        }
      }
    }
  }
}

const order = [...tally.keys()].sort();
const pct = (a: number, b: number) => b === 0 ? " n/a" : `${((100 * a) / b).toFixed(0)}%`.padStart(4);
console.log(`\nheld-out frames: ${[...labels.keys()].filter((f) => !induced.has(f)).length}\n`);
console.log(`  ${"field".padEnd(20)} ${"n".padStart(4)} ${"read".padStart(5)} ${"correct".padStart(8)} ${"WRONG".padStart(6)}`);
let N = 0, R = 0, C = 0, W = 0;
for (const k of order) {
  const v = tally.get(k)!;
  N += v.n; R += v.read; C += v.correct; W += v.wrong;
  console.log(`  ${k.padEnd(20)} ${String(v.n).padStart(4)} ${pct(v.read, v.n)} ${pct(v.correct, v.n).padStart(8)} ${String(v.wrong).padStart(6)}`);
}
console.log(`  ${"TOTAL".padEnd(20)} ${String(N).padStart(4)} ${pct(R, N)} ${pct(C, N).padStart(8)} ${String(W).padStart(6)}`);

// PER-DIGIT, because "the speed chip is weak" turned out to be the wrong
// reading of the same data. The failures track the DIGIT, not the facility: a
// template averaged from one sighting is a template of one frame's noise, and
// the greedy alphabet cover stops at the first frame that teaches a digit.
console.log("\nchip levels by digit (the induction set holds very different sample counts per digit):");
{
  const byDigit = new Map<string, { n: number; read: number }>();
  for (const ref of manifest) {
    const label = labels.get(ref.frame);
    if (!label?.levels || induced.has(ref.frame) || label.summerCamp) continue;
    for (let i = 0; i < 5; i++) {
      const want = label.levels[i];
      if (typeof want !== "number") continue;
      const k = String(want);
      const v = byDigit.get(k) ?? { n: 0, read: 0 };
      v.n++;
      const spec = chipLevelField(i, label.selected === STATS[i]);
      if (readNumber(fieldGlyphs(loadPanelCached(ref.frame), spec), byStyle.get(spec.style) ?? [])) v.read++;
      byDigit.set(k, v);
    }
  }
  const samples = new Map(raw.templates.filter((t) => t.style === "smallChip" || t.style === "bigChip")
    .map((t) => [`${t.style}:${t.label}`, t.samples]));
  for (const k of [...byDigit.keys()].sort()) {
    const v = byDigit.get(k)!;
    console.log(`  level ${k}: ${String(v.read).padStart(3)}/${String(v.n).padStart(3)} read (${pct(v.read, v.n)})` +
      `   induction samples: smallChip ${samples.get(`smallChip:${k}`) ?? 0}, bigChip ${samples.get(`bigChip:${k}`) ?? 0}`);
  }
}

console.log("\ndisagreements (reader vs transcription -- both are suspects):");
let shown = 0;
for (const k of order) {
  for (const m of tally.get(k)!.misses) {
    if (shown++ < 40) console.log(`  ${k.padEnd(20)} ${m}`);
  }
}
if (shown > 40) console.log(`  ... and ${shown - 40} more`);
