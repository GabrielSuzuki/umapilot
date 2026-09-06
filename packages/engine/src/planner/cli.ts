/**
 * Headless planner: `plan < state.json > advice.json`.
 *
 * Same contract as the projection CLI, and for the same reason -- if the
 * recommender can be driven from a pipe with no browser, no globals and no
 * display, then the boundary in scenario.ts is real. This is also the harness
 * the web UI will call, so anything it cannot express is a gap in the engine
 * rather than something the UI should paper over.
 *
 *   npx tsx packages/engine/src/planner/cli.ts < examples/run.json
 *   npx tsx packages/engine/src/planner/cli.ts --state examples/run.json --worlds 8
 *   npx tsx packages/engine/src/planner/cli.ts --state examples/run.json --objective goalProbability
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { STATS, type GrandConcertDataset, type Stat, type StatVector } from "../../../data/src/types";
import { GrandConcertScenario, type CardState, type GcRunState } from "../scenarios/grand-concert";
import { EMPTY_TARGET, type RunTarget } from "../target";
import { POLICIES } from "../policy";
import { plan, type PlanOptions } from "./index";
import type { ObjectiveMode } from "./objective";

interface Input {
  cards: CardState[];
  startingStats?: Partial<StatVector>;
  statCaps?: Partial<StatVector>;
  growthRate?: Partial<Record<Stat, number>>;
  facilityLevels?: Partial<Record<Stat, number>>;
  target?: Partial<Record<Stat, number | null>>;
  /**
   * Companions actually in the deck, by chara id (friend) or card id (group).
   * Absent means none, and the planner will say so in its assumptions rather
   * than schedule outings with a friend you did not bring.
   */
  companions?: number[];
  /** Resume from a run in progress rather than turn 1. */
  state?: GcRunState;
}

function loadDataset(): GrandConcertDataset {
  const gen = join(import.meta.dirname, "../../../data/generated");
  const file = readdirSync(gen)
    .filter((f: string) => f.startsWith("grand-concert.") && !f.includes("latest"))[0];
  if (!file) {
    throw new Error(
      "no dataset in packages/data/generated -- run `npm run extract` against your own master.mdb",
    );
  }
  return JSON.parse(readFileSync(join(gen, file), "utf8"));
}

function main(): void {
  const argv = process.argv.slice(2);
  const arg = (name: string) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const num = (name: string, fallback: number) => {
    const v = arg(name);
    return v === undefined ? fallback : Number(v);
  };

  const statePath = arg("--state");
  const raw = statePath ? readFileSync(statePath, "utf8") : readFileSync(0, "utf8");
  const input: Input = JSON.parse(raw);

  const dataset = loadDataset();
  const setup: ConstructorParameters<typeof GrandConcertScenario>[1] = { cards: input.cards };
  if (input.startingStats) setup.startingStats = input.startingStats;
  if (input.statCaps) setup.statCaps = input.statCaps;
  if (input.growthRate) setup.growthRate = input.growthRate;
  if (input.facilityLevels) setup.facilityLevels = input.facilityLevels;
  const scenario = new GrandConcertScenario(dataset, setup);

  const state = input.state ?? scenario.initialState();

  const target: RunTarget = { ...EMPTY_TARGET, stats: { ...EMPTY_TARGET.stats } };
  for (const stat of STATS) target.stats[stat] = input.target?.[stat] ?? null;

  const policyName = arg("--policy") ?? "competent";
  const policy = POLICIES[policyName];
  if (!policy) {
    console.error(`unknown policy "${policyName}". Available: ${Object.keys(POLICIES).join(", ")}`);
    process.exit(1);
  }

  const opts: PlanOptions = {
    width: num("--width", 24),
    horizon: num("--horizon", 6),
    worlds: num("--worlds", 4),
    maxBuysPerTurn: num("--buys", 2),
    shadowSamples: num("--shadow-samples", 6),
    probabilitySamples: num("--prob-samples", 120),
    probabilityFor: num("--prob-for", 3),
    seed: num("--seed", 1),
    objective: (arg("--objective") ?? "hybrid") as ObjectiveMode,
    companions: input.companions ?? [],
    rollout: { policy },
  };

  const result = plan(scenario, state, target, opts);

  process.stdout.write(JSON.stringify({
    scenario: scenario.id,
    dataset: dataset.source.sha256.slice(0, 12),
    turn: state.turn,
    rolloutPolicy: policyName,
    topIsClear: result.topIsClear,
    baseline: Number(result.baseline.toFixed(6)),
    recommendations: result.recommendations.map((r) => ({
      action: r.action,
      ev: Number(r.ev.toFixed(6)),
      goalProbability: r.goalProbability
        ? {
            p: Number(r.goalProbability.p.toFixed(4)),
            ci95: r.goalProbability.ci95.map((x) => Number(x.toFixed(4))),
            samples: r.goalProbability.samples,
          }
        : undefined,
      breakdown: Object.fromEntries(
        Object.entries(r.breakdown).map(([k, v]) => [k, Number((v as number).toFixed(6))]),
      ),
      rationale: r.rationale,
    })),
    plan: result.plan,
    shadowPrices: result.prices,
    search: result.search,
    assumptions: result.assumptions,
    warning: result.warning,
    ...(result.topIsClear ? {} : {
      note: "The top two actions are not separable at this sample count. " +
            "Present them as a tie, or raise --prob-samples and --worlds.",
    }),
  }, null, 2) + "\n");
}

main();
