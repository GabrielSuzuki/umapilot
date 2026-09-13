/**
 * Does `findPanel` locate the game inside a full-desktop screenshot?
 *
 * The corpus is a 3840x1080 dual-monitor grab and the game sits at x=2068, a
 * number that has been hardcoded in every tool this project has written against
 * these images. This checks whether it can be found instead of assumed -- which
 * it has to be, because the player's drop-a-screenshot file will be a PrtScn of
 * whatever their desktop looked like.
 *
 *   npx tsx tools/vision/find-panel.ts <fullFrameDir>
 */
import { loadManifest, loadPanel, loadLabels } from "./corpus";
import { findPanel, probeScreen } from "../../packages/engine/src/vision/classify";
import { cropImage } from "../../packages/engine/src/vision/layout";
import { readFrame } from "../../packages/engine/src/vision/read";

const dir = process.argv[2] ?? "";
const KNOWN_X = 2068;
const labels = loadLabels("examples/facility-levels-2026-09-05.jsonl");

let ok = 0, n = 0;
for (const ref of loadManifest(dir)) {
  const img = loadPanel(dir, ref);
  const t0 = Date.now();
  const found = findPanel(img);
  const ms = Date.now() - t0;
  const label = labels.get(ref.frame);
  const isTraining = !!label?.selected;
  n++;

  if (!found) {
    console.log(`  f${String(ref.frame).padStart(2)} ${isTraining ? "training" : "other   "}  NOT FOUND${isTraining ? "  <-- miss" : "  (expected: probes describe a training screen)"}  ${ms}ms`);
    if (!isTraining) ok++;
    continue;
  }
  const off = found.box.x0 - KNOWN_X;
  const good = Math.abs(off) <= 2;
  if (isTraining && good) ok++;
  const r = readFrame(cropImage(img, found.box));
  console.log(`  f${String(ref.frame).padStart(2)} ${isTraining ? "training" : "other   "}  x=${found.box.x0} (${off >= 0 ? "+" : ""}${off} vs known ${KNOWN_X})  cost ${found.cost.toFixed(2)}  ${ms}ms  ` +
    `-> ${r.screen.kind}${r.turnsLeft !== undefined ? `, ${r.turnsLeft} turns left` : ""}${r.selected ? `, ${r.selected} selected` : ""}` +
    `${isTraining && !good ? "   <-- WRONG OFFSET" : ""}`);
}
console.log(`\n${ok}/${n} frames handled as expected`);
