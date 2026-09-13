/**
 * Where to set the chevron detector's floor and margin.
 *
 * Argmax alone is 58/58 on this corpus. The floor and margin exist for frames
 * with no chevrons at all, which argmax would answer anyway -- so they buy
 * safety the corpus cannot demonstrate the need for, and they cost reads it can
 * measure. This prints the trade instead of leaving both numbers as guesses.
 */
import { loadManifest, loadPanel, loadLabels } from "./corpus";
import { LAYOUT } from "../../packages/engine/src/vision/layout";
import { STATS } from "./harvest";

const dir = process.argv[2] ?? "";
const manifest = loadManifest(dir);
const labels = loadLabels("examples/facility-levels-2026-09-05.jsonl");

const rows: Array<{ frame: number; want: string; scores: number[] }> = [];
for (const ref of manifest) {
  const label = labels.get(ref.frame);
  if (!label?.selected) continue;
  const panel = loadPanel(dir, ref);
  const { y0, y1, halfWidth } = LAYOUT.chevronBand;
  const scores = LAYOUT.chipCentreX.map((cx) => {
    let hits = 0, n = 0;
    for (let y = y0; y < Math.min(panel.height, y1); y++) {
      let i = (y * panel.width + (cx - halfWidth)) * 4;
      for (let x = cx - halfWidth; x < cx + halfWidth; x++, i += 4) {
        if (panel.data[i]! > 200 && panel.data[i + 1]! > 150 && panel.data[i + 2]! < 120) hits++;
        n++;
      }
    }
    return hits / n;
  });
  rows.push({ frame: ref.frame, want: label.selected, scores });
}

for (const floor of [0, 0.005, 0.01, 0.02]) {
  for (const margin of [1.0, 1.2, 1.5, 2.0]) {
    let read = 0, correct = 0;
    for (const r of rows) {
      const sorted = [...r.scores].sort((a, b) => b - a);
      const best = sorted[0]!, second = sorted[1]!;
      if (best < floor || best < second * margin) continue;
      read++;
      if (STATS[r.scores.indexOf(best)] === r.want) correct++;
    }
    console.log(`  floor ${String(floor).padEnd(6)} margin ${String(margin).padEnd(4)} -> read ${String(read).padStart(2)}/${rows.length}, correct ${correct}, WRONG ${read - correct}`);
  }
}
console.log("\nlowest best-score seen:", Math.min(...rows.map((r) => Math.max(...r.scores))).toFixed(4));
console.log("tightest ratio seen:   ", Math.min(...rows.map((r) => {
  const s = [...r.scores].sort((a, b) => b - a); return s[1]! === 0 ? Infinity : s[0]! / s[1]!;
})).toFixed(2));
