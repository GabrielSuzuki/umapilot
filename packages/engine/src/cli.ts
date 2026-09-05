/**
 * Headless harness: `engine < state.json > projection.json`.
 *
 * Exists to keep the engine honest. If it can be driven from a pipe with no UI,
 * no browser and no globals, then the boundary in scenario.ts is real rather
 * than aspirational. It is also how batch regression runs will work.
 *
 * Usage:
 *   npx tsx packages/engine/src/cli.ts --runs 200 < examples/run.json
 *   npx tsx packages/engine/src/cli.ts --runs 200 --state examples/run.json
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { STATS, type GrandConcertDataset, type Stat, type StatVector } from "../../data/src/types";
import { mulberry32 } from "./rng";
import { GrandConcertScenario, type CardState, type GcRunState } from "./scenarios/grand-concert";

interface Input {
  cards: CardState[];
  startingStats?: Partial<StatVector>;
  statCaps?: Partial<StatVector>;
  growthRate?: Partial<Record<Stat, number>>;
  facilityLevels?: Partial<Record<Stat, number>>;
  /** End-of-run stat targets. null or absent means "no target for this stat". */
  target?: Partial<Record<Stat, number | null>>;
}

function loadDataset(): GrandConcertDataset {
  const gen = join(import.meta.dirname, "../../data/generated");
  const file = readdirSync(gen)
    .filter((f: string) => f.startsWith("grand-concert.") && !f.includes("latest"))[0];
  if (!file) {
    throw new Error(
      "no dataset in packages/data/generated -- run `npm run extract` against your own master.mdb",
    );
  }
  return JSON.parse(readFileSync(join(gen, file), "utf8"));
}

/** Baseline policy: shore up whichever target is furthest from being met. */
function playOne(scenario: GrandConcertScenario, seed: number, target: Partial<Record<Stat, number | null>>): GcRunState {
  const rng = mulberry32(seed);
  let state = scenario.initialState();
  let guard = 0;

  while (!scenario.isTerminal(state) && guard++ < 300) {
    if (state.energy < 30) {
      state = scenario.step(state, { kind: "rest" }, rng);
    } else if (state.mood < 1 && guard % 11 === 0) {
      state = scenario.step(state, { kind: "outing" }, rng);
    } else {
      let pick: Stat = "speed";
      let worst = Infinity;
      for (const stat of STATS) {
        const want = target[stat];
        const denom = want ?? scenario.statCaps[stat];
        const ratio = state.stats[stat] / Math.max(1, denom);
        if (ratio < worst) { worst = ratio; pick = stat; }
      }
      state = scenario.step(state, { kind: "train", facility: pick }, rng);
    }
    const shop = scenario.legalShopActions(state).filter((a) => a.kind === "technique");
    if (shop.length) state = scenario.buy(state, shop[0]!);
  }
  return state;
}

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
  return sorted[i]!;
}

/** Wilson score interval -- honest at the extremes, unlike normal approximation. */
function wilson(hits: number, n: number): [number, number] {
  if (n === 0) return [0, 0];
  const z = 1.96, p = hits / n;
  const d = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const spread = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [Math.max(0, (centre - spread) / d), Math.min(1, (centre + spread) / d)];
}

function main(): void {
  const argv = process.argv.slice(2);
  const arg = (name: string) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };

  const runs = Number(arg("--runs") ?? 200);
  const seed0 = Number(arg("--seed") ?? 1);
  const statePath = arg("--state");
  const raw = statePath ? readFileSync(statePath, "utf8") : readFileSync(0, "utf8");
  const input: Input = JSON.parse(raw);

  const dataset = loadDataset();
  // exactOptionalPropertyTypes: build the setup without undefined-valued keys.
  const setup: ConstructorParameters<typeof GrandConcertScenario>[1] = { cards: input.cards };
  if (input.startingStats) setup.startingStats = input.startingStats;
  if (input.statCaps) setup.statCaps = input.statCaps;
  if (input.growthRate) setup.growthRate = input.growthRate;
  if (input.facilityLevels) setup.facilityLevels = input.facilityLevels;
  const scenario = new GrandConcertScenario(dataset, setup);

  const target = input.target ?? {};
  const finals: StatVector[] = [];
  let hits = 0;
  let assumptions: string[] = [];

  for (let i = 0; i < runs; i++) {
    const end = playOne(scenario, seed0 + i, target);
    finals.push(end.stats);
    if (i === 0) assumptions = end.scenario.assumptions;
    const met = STATS.every((s) => {
      const want = target[s];
      return want == null || end.stats[s] >= want;
    });
    if (met) hits++;
  }

  const perStat: Record<string, unknown> = {};
  for (const stat of STATS) {
    const xs = finals.map((f) => f[stat]).sort((a, b) => a - b);
    perStat[stat] = {
      target: target[stat] ?? null,
      p10: percentile(xs, 10),
      median: percentile(xs, 50),
      p90: percentile(xs, 90),
      mean: Math.round(xs.reduce((a, b) => a + b, 0) / xs.length),
      cap: scenario.statCaps[stat],
    };
  }

  const [lo, hi] = wilson(hits, runs);
  process.stdout.write(JSON.stringify({
    scenario: scenario.id,
    dataset: dataset.source.sha256.slice(0, 12),
    runs,
    goalProbability: {
      p: hits / runs,
      ci95: [Number(lo.toFixed(4)), Number(hi.toFixed(4))],
      samples: runs,
      note: "sampled, not exact -- never render this without the interval",
    },
    projectedStats: perStat,
    assumptions,
    warning: "The simulator has NOT been validated against logged real runs. " +
             "These numbers are self-consistent, not known to be accurate.",
  }, null, 2) + "\n");
}

main();
