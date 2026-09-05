/**
 * `calibrate` -- read a training-screen log, report where the model is wrong.
 *
 *   npx tsx packages/engine/src/calibration/cli.ts --log examples/calibration-sample.jsonl
 *   npx tsx packages/engine/src/calibration/cli.ts --log mylog.jsonl --solve --json
 *
 * See docs/m2-logging.md for what to capture and why.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { GrandConcertDataset } from "../../../data/src/types";
import type { FacilityTable, PlacedCard } from "../scenarios/grand-concert/training";
import { parseLog } from "./log";
import { computeResiduals, diagnose, solveBaseValues } from "./fit";

interface SupportCardFile {
  supportCards: Array<{
    id: number;
    effects: Record<string, Record<string, number>>;
  }>;
}

function generatedDir(): string {
  return join(import.meta.dirname, "../../../data/generated");
}

function pick(prefix: string): string | undefined {
  try {
    return readdirSync(generatedDir())
      .filter((f: string) => f.startsWith(prefix) && !f.includes("latest"))[0];
  } catch {
    return undefined;
  }
}

/**
 * Resolve each card's effect values at a given level.
 *
 * Defaults to level 50 / max limit break, which is what a built deck looks like.
 * If a card is missing from the dataset its effects come back empty, which makes
 * its contribution zero rather than crashing -- a log referencing an unknown card
 * should degrade, not explode.
 */
function makeEffectLookup(level = 50): (cardId: number) => PlacedCard["effects"] {
  const file = pick("support-cards.");
  if (!file) return () => ({});
  const data: SupportCardFile = JSON.parse(readFileSync(join(generatedDir(), file), "utf8"));
  const byId = new Map(data.supportCards.map((c) => [c.id, c.effects]));

  return (cardId: number) => {
    const effects = byId.get(cardId);
    if (!effects) return {};
    const out: Record<string, number> = {};
    for (const [name, curve] of Object.entries(effects)) {
      const v = curve[String(level)];
      if (typeof v === "number") out[name] = v;
    }
    return out as PlacedCard["effects"];
  };
}

function main(): void {
  const argv = process.argv.slice(2);
  const arg = (name: string) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const has = (name: string) => argv.includes(name);

  const logPath = arg("--log");
  if (!logPath) {
    console.error("usage: calibrate --log <file.jsonl> [--solve] [--json] [--card-level N]");
    process.exit(1);
  }

  const datasetFile = pick("grand-concert.");
  if (!datasetFile) {
    console.error(
      "no dataset in packages/data/generated -- run `npm run extract` against your own master.mdb",
    );
    process.exit(1);
  }
  const dataset: GrandConcertDataset = JSON.parse(
    readFileSync(join(generatedDir(), datasetFile), "utf8"),
  );
  const facilityTable = (dataset as unknown as { training: { facilities: FacilityTable } })
    .training.facilities;

  const { observations, errors } = parseLog(readFileSync(logPath, "utf8"));
  const effectsFor = makeEffectLookup(Number(arg("--card-level") ?? 50));

  const residuals = computeResiduals(observations, facilityTable, effectsFor);
  const diagnosis = diagnose(residuals);
  const solved = has("--solve")
    ? solveBaseValues(observations, facilityTable, effectsFor)
    : [];

  if (has("--json")) {
    process.stdout.write(JSON.stringify({
      log: logPath,
      dataset: dataset.source.sha256.slice(0, 12),
      parsed: observations.length,
      skipped: errors.length,
      errors,
      diagnosis,
      solvedBaseValues: solved,
    }, null, 2) + "\n");
    return;
  }

  console.log(`log      ${logPath}`);
  console.log(`dataset  ${dataset.source.sha256.slice(0, 12)}`);
  console.log(`parsed   ${observations.length} observations, ${errors.length} skipped\n`);

  if (errors.length) {
    console.log("skipped lines:");
    for (const e of errors.slice(0, 10)) console.log(`  line ${e.line}: ${e.message}`);
    if (errors.length > 10) console.log(`  ... and ${errors.length - 10} more`);
    console.log();
  }

  if (!residuals.length) {
    console.log("No usable observations. Each row needs predictedGains for its own facility.");
    process.exit(1);
  }

  console.log(`overall observed/predicted ratio: ${diagnosis.overallMeanRatio}  ` +
              `(1.000 would be a perfect model)\n`);

  console.log("residual structure, worst first -- a large spread means that term is wrong:\n");
  for (const g of diagnosis.groupings) {
    console.log(`  ${g.term}`);
    console.log(`    grouped by ${g.groupedBy}   spread ${g.spread}`);
    for (const b of g.buckets) {
      const flag = b.n < 3 ? "  (thin)" : "";
      console.log(`      ${b.key.padEnd(18)} n=${String(b.n).padStart(3)}  ` +
                  `mean ${b.meanRatio.toFixed(3)}  [${b.minRatio.toFixed(2)}-${b.maxRatio.toFixed(2)}]${flag}`);
    }
    console.log();
  }

  console.log("verdict:");
  for (const line of diagnosis.verdict) console.log(`  - ${line}`);

  if (solved.length) {
    console.log("\nsolved base values (master.mdb has levels 1 and 5 only):\n");
    console.log("  facility  lvl  n   implied   current   spread");
    for (const s of solved) {
      const note = s.spread > 0.25 ? "  <- wide, do not trust yet" : "";
      console.log(
        `  ${s.facility.padEnd(9)} ${String(s.level).padStart(3)} ${String(s.samples).padStart(3)}  ` +
        `${s.implied.toFixed(2).padStart(7)}   ${String(s.currentInterpolated).padStart(7)}   ` +
        `${s.spread.toFixed(2)}${note}`,
      );
    }
    console.log("\n  A tight spread means the rest of the model is consistent and the");
    console.log("  implied value can be trusted. A wide one means fix the diagnostics first.");
  }
}

main();
