/**
 * What separates a training screen from everything else, measured before any
 * classifier is written.
 *
 * Two candidate probes, both cheap:
 *   statRowLuma  -- the stat row is a near-white panel on the training screen
 *                   and is absent or covered otherwise.
 *   headerStdDev -- the game BLURS and dims the whole screen behind a modal
 *                   dialog, and a blur is a loss of local contrast. This is
 *                   what stops a classifier confidently reading the training
 *                   screen underneath a race dialog.
 */
import { loadManifest, loadPanel, loadLabels } from "./corpus";
import { meanLuma, lumaStdDev } from "../../packages/engine/src/vision/image";
import { LAYOUT, scaleBox } from "../../packages/engine/src/vision/layout";

const panelDir = process.argv[2] ?? "";
const manifest = loadManifest(panelDir);
const labels = loadLabels("examples/facility-levels-2026-09-05.jsonl");

const rows: Array<{ frame: number; training: boolean; luma: number; sd: number; chip: number; note: string }> = [];
for (const ref of manifest) {
  const panel = loadPanel(panelDir, ref);
  const label = labels.get(ref.frame);
  rows.push({
    frame: ref.frame,
    training: !!label?.selected,
    luma: meanLuma(panel, scaleBox(LAYOUT.statRow, panel.width, panel.height)),
    sd: lumaStdDev(panel, scaleBox({ x0: 100, y0: 30, x1: 720, y1: 160 }, panel.width, panel.height)),
    chip: lumaStdDev(panel, scaleBox({ x0: 140, y0: 855, x1: 670, y1: 970 }, panel.width, panel.height)),
    note: (label?.note ?? label?.action ?? "").slice(0, 44),
  });
}

const t = rows.filter((r) => r.training), o = rows.filter((r) => !r.training);
const q = (xs: number[], p: number) => xs.slice().sort((a, b) => a - b)[Math.floor(p * (xs.length - 1))]!;
console.log(`training frames ${t.length}, other ${o.length}\n`);
for (const [name, get] of [["statRowLuma", (r: typeof rows[0]) => r.luma], ["headerStdDev", (r: typeof rows[0]) => r.sd], ["chipRowStdDev", (r: typeof rows[0]) => r.chip]] as const) {
  console.log(`${name}:`);
  console.log(`  training  min ${q(t.map(get), 0).toFixed(1)}  p10 ${q(t.map(get), 0.1).toFixed(1)}  median ${q(t.map(get), 0.5).toFixed(1)}  max ${q(t.map(get), 1).toFixed(1)}`);
  console.log(`  other     min ${q(o.map(get), 0).toFixed(1)}  p90 ${q(o.map(get), 0.9).toFixed(1)}  median ${q(o.map(get), 0.5).toFixed(1)}  max ${q(o.map(get), 1).toFixed(1)}`);
}
// The rule under test, stated before it is scored.
const isTraining = (r: typeof rows[0]) => r.luma > 193 && r.luma < 203 && r.sd > 35 && r.sd < 70 && r.chip > 48 && r.chip < 60;
const fp = rows.filter((r) => !r.training && isTraining(r));
const fn = rows.filter((r) => r.training && !isTraining(r));
console.log(`\nrule: statRowLuma in (193,203) AND headerStdDev in (35,70) AND chipRowStdDev in (48,60)`);
console.log(`  false positives ${fp.length}: ${fp.map((r) => "f" + r.frame).join(" ")}`);
console.log(`  false negatives ${fn.length}: ${fn.map((r) => "f" + r.frame).join(" ")}`);

console.log("\nnon-training frames, by statRowLuma:");
for (const r of o.sort((a, b) => b.luma - a.luma)) {
  console.log(`  f${String(r.frame).padStart(2)} luma ${r.luma.toFixed(1).padStart(6)} sd ${r.sd.toFixed(1).padStart(5)} chip ${r.chip.toFixed(1).padStart(5)}  ${r.note}`);
}
