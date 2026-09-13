/**
 * Run the assembled reader over the whole corpus and score it against the hand
 * transcription -- the end-to-end number, not the per-field one.
 *
 *   npx tsx tools/vision/read-all.ts <panelDir>
 */
import { loadManifest, loadPanel, loadLabels } from "./corpus";
import { readFrame } from "../../packages/engine/src/vision/read";

const panelDir = process.argv[2] ?? "";
const manifest = loadManifest(panelDir);
const labels = loadLabels("examples/facility-levels-2026-09-05.jsonl");
const STATS = ["speed", "stamina", "power", "guts", "wit"] as const;

let classOk = 0, classN = 0;
let selOk = 0, selRead = 0, selN = 0, selWrong = 0;
let lvlOk = 0, lvlRead = 0, lvlN = 0, lvlWrong = 0;
let campDetected = 0, campN = 0;
const notes: string[] = [];

for (const ref of manifest) {
  const label = labels.get(ref.frame);
  const r = readFrame(loadPanel(panelDir, ref));
  if (label) {
    classN++;
    const wantTraining = !!label.selected;
    if ((r.screen.kind === "training") === wantTraining) classOk++;
    else notes.push(`f${ref.frame} classified ${r.screen.kind}, transcription says ${wantTraining ? "training" : "not"} (margin ${r.screen.margin.toFixed(1)})`);
  }
  if (label?.selected && r.screen.kind === "training") {
    selN++;
    if (r.selected) { selRead++; if (r.selected === label.selected) selOk++; else { selWrong++; notes.push(`f${ref.frame} selected read ${r.selected}, want ${label.selected}`); } }
  }
  if (label?.levels && r.screen.kind === "training") {
    if (label.summerCamp) { campN++; if (r.chipLevelsHidden) campDetected++; }
    else for (let i = 0; i < 5; i++) {
      const want = label.levels[i];
      if (typeof want !== "number") continue;
      lvlN++;
      const got = r.facilityLevels[STATS[i]!];
      if (got === undefined) continue;
      lvlRead++;
      if (got === want) lvlOk++; else { lvlWrong++; notes.push(`f${ref.frame} ${STATS[i]} level read ${got}, want ${want}`); }
    }
  }
}

const pct = (a: number, b: number) => b === 0 ? "n/a" : `${((100 * a) / b).toFixed(0)}%`;
console.log(`screen classification   ${classOk}/${classN} (${pct(classOk, classN)})`);
console.log(`selected facility       read ${selRead}/${selN} (${pct(selRead, selN)}), correct ${selOk}, WRONG ${selWrong}`);
console.log(`facility levels         read ${lvlRead}/${lvlN} (${pct(lvlRead, lvlN)}), correct ${lvlOk}, WRONG ${lvlWrong}`);
console.log(`summer camp detected    ${campDetected}/${campN}`);
if (notes.length) { console.log("\nnotes:"); for (const n of notes.slice(0, 25)) console.log("  " + n); }
