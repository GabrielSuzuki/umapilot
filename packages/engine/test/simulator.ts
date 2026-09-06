/**
 * M1 test suite: property tests plus a golden-file regression.
 *
 * The property tests assert things that must hold for *any* run -- purity,
 * determinism, bounds. They are what stop a refactor silently changing
 * behaviour.
 *
 * The golden file pins one specific seeded career. It will change whenever the
 * model changes, which is the point: an unexpected diff is the signal.
 *
 * None of this proves the simulator matches the game. That needs logged real
 * runs, which is M2. These tests prove it is self-consistent and reproducible --
 * a precondition, not a substitute.
 */

import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { STATS, TOKENS, type GrandConcertDataset, type Stat } from "../../data/src/types";
import { mulberry32 } from "../src/rng";
import {
  GrandConcertScenario, resolveBaseTraining, computeTraining,
  type CardState, type GcRunState,
} from "../src/scenarios/grand-concert";

const GEN = join(import.meta.dirname, "../../data/generated");
const GOLDEN = join(import.meta.dirname, "golden-career.json");

const hasData = (() => {
  try {
    return readdirSync(GEN).some((f) => f.startsWith("grand-concert.") && !f.includes("latest"));
  } catch { return false; }
})();

if (!hasData) {
  console.log("no generated dataset -- skipping simulator tests.");
  console.log("run `npm run extract` against your own master.mdb first.");
  process.exit(0);
}

const file = readdirSync(GEN).filter((f) => f.startsWith("grand-concert.") && !f.includes("latest"))[0]!;
const dataset: GrandConcertDataset = JSON.parse(readFileSync(join(GEN, file), "utf8"));

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "  ok  " : "FAIL  "}${name}${detail ? "  " + detail : ""}`);
  if (!ok) failures++;
};

// ---------------------------------------------------------------------------
// A fixed, realistic setup so runs are comparable
// ---------------------------------------------------------------------------

const CARDS: CardState[] = [
  { cardId: 30002, stat: "speed",   bond: 0, effects: { friendship_bonus: 35, mood_effect: 40, training_effectiveness: 15, speed_bonus: 1, skill_point_bonus: 1 } },
  { cardId: 30004, stat: "stamina", bond: 0, effects: { friendship_bonus: 30, mood_effect: 35, training_effectiveness: 15, stamina_bonus: 1 } },
  { cardId: 30001, stat: "guts",    bond: 0, effects: { friendship_bonus: 25, training_effectiveness: 10, guts_bonus: 1 } },
  { cardId: 30005, stat: "power",   bond: 0, effects: { friendship_bonus: 30, training_effectiveness: 15, power_bonus: 1 } },
  { cardId: 30003, stat: "wit",     bond: 0, effects: { friendship_bonus: 20, training_effectiveness: 10, wit_bonus: 1 } },
  { cardId: 30052, stat: null,      bond: 0, effects: { mood_effect: 30, training_effectiveness: 5 } },
];

const makeScenario = () =>
  new GrandConcertScenario(dataset, {
    cards: CARDS,
    startingStats: { speed: 109, stamina: 196, power: 119, guts: 92, wit: 92 },
    statCaps: { stamina: 1366, power: 1316 },
    growthRate: { stamina: 20 },
    facilityLevels: { speed: 3, stamina: 2, power: 2, guts: 1, wit: 3 },
  });

/** A simple deterministic policy: train the lowest-progress stat, rest when tired. */
function playCareer(seed: number): { state: GcRunState; turns: number } {
  const scenario = makeScenario();
  const rng = mulberry32(seed);
  let state = scenario.initialState();
  let turns = 0;

  while (!scenario.isTerminal(state) && turns < 200) {
    if (state.energy < 30) {
      state = scenario.step(state, { kind: "rest" }, rng);
    } else if (state.mood < 1 && turns % 11 === 0) {
      state = scenario.step(state, { kind: "outing" }, rng);
    } else {
      let pick: Stat = "speed";
      let worst = Infinity;
      for (const stat of STATS) {
        const ratio = state.stats[stat] / scenario.statCaps[stat];
        if (ratio < worst) { worst = ratio; pick = stat; }
      }
      state = scenario.step(state, { kind: "train", facility: pick }, rng);
    }

    // Spend tokens greedily on the cheapest affordable technique.
    const shop = scenario.legalShopActions(state).filter((a) => a.kind === "technique");
    if (shop.length) state = scenario.buy(state, shop[0]!);
    turns++;
  }
  return { state, turns };
}

// ---------------------------------------------------------------------------
// Base value resolution
// ---------------------------------------------------------------------------

const training = (dataset as unknown as { training: { facilities: any; levelsMissing: number[] } }).training;

check("dataset carries a training section", !!training?.facilities);

for (const stat of STATS) {
  const r1 = resolveBaseTraining(training.facilities, stat, 1);
  const r5 = resolveBaseTraining(training.facilities, stat, 5);
  check(`${stat} levels 1 and 5 come from master.mdb, never interpolated`,
    r1.source === "master.mdb" && r5.source === "master.mdb");
  check(`${stat} training grants ${stat} at both known levels`,
    ((r1.values as any)[stat] ?? 0) > 0 && ((r5.values as any)[stat] ?? 0) > 0);
}

const mid = resolveBaseTraining(training.facilities, "speed", 3);
check("levels 2-4 are marked interpolated, not passed off as extracted",
  mid.source === "interpolated", JSON.stringify(mid.values));
check("an interpolated level sits between the two known ones",
  (mid.values.speed ?? 0) >= (training.facilities.speed["1"].speed) &&
  (mid.values.speed ?? 0) <= (training.facilities.speed["5"].speed));

// ---------------------------------------------------------------------------
// Training calculation
// ---------------------------------------------------------------------------

{
  const flat = computeTraining({
    facility: "speed", facilityLevel: 1, mood: "normal", growthRate: {},
    cards: [], facilityTable: training.facilities,
    statCaps: dataset.constants.statCaps,
    currentStats: { speed: 0, stamina: 0, power: 0, guts: 0, wit: 0 },
  });
  check("with no cards and neutral mood, gain equals the base value",
    flat.gains.speed === training.facilities.speed["1"].speed,
    `${flat.gains.speed} vs base ${training.facilities.speed["1"].speed}`);

  const moody = computeTraining({
    facility: "speed", facilityLevel: 1, mood: "great", growthRate: {},
    cards: [], facilityTable: training.facilities,
    statCaps: dataset.constants.statCaps,
    currentStats: { speed: 0, stamina: 0, power: 0, guts: 0, wit: 0 },
  });
  check("great mood beats normal mood", moody.gains.speed > flat.gains.speed,
    `${moody.gains.speed} > ${flat.gains.speed}`);

  const capped = computeTraining({
    facility: "speed", facilityLevel: 5, mood: "great", growthRate: {},
    cards: CARDS.map((c) => ({ ...c, bond: 100 })),
    facilityTable: training.facilities,
    statCaps: dataset.constants.statCaps,
    currentStats: { ...dataset.constants.statCaps, speed: dataset.constants.statCaps.speed - 2 },
  });
  check("a gain is clipped at the stat cap", capped.gains.speed === 2,
    `capped ${capped.gains.speed}, uncapped ${capped.uncappedGains.speed}`);
  check("the uncapped value is still reported for waste detection",
    capped.uncappedGains.speed > capped.gains.speed);
  check("every result carries its assumptions", capped.assumptions.length >= 2);
}

// ---------------------------------------------------------------------------
// Purity and determinism
// ---------------------------------------------------------------------------

{
  const scenario = makeScenario();
  const before = scenario.initialState();
  const snapshot = JSON.stringify(before);
  scenario.step(before, { kind: "train", facility: "speed" }, mulberry32(1));
  check("step does not mutate its input state", JSON.stringify(before) === snapshot);
}

{
  const a = playCareer(12345);
  const b = playCareer(12345);
  check("the same seed produces an identical career",
    JSON.stringify(a.state) === JSON.stringify(b.state));

  const c = playCareer(999);
  check("a different seed produces a different career",
    JSON.stringify(a.state) !== JSON.stringify(c.state));
}

// ---------------------------------------------------------------------------
// Invariants over a full career
// ---------------------------------------------------------------------------

{
  const scenario = makeScenario();
  const rng = mulberry32(4242);
  let state = scenario.initialState();
  let energyOk = true, tokensOk = true, statsOk = true, monotonicTurn = true;
  let lastTurn = state.turn;

  while (!scenario.isTerminal(state)) {
    state = scenario.step(state, { kind: "train", facility: "speed" }, rng);
    if (state.energy < 0 || state.energy > 100) energyOk = false;
    if (state.turn !== lastTurn + 1) monotonicTurn = false;
    lastTurn = state.turn;
    for (const t of TOKENS) {
      if (state.scenario.tokens[t] > state.scenario.tokenCaps[t]) tokensOk = false;
      if (state.scenario.tokens[t] < 0) tokensOk = false;
    }
    for (const s of STATS) {
      if (state.stats[s] > scenario.statCaps[s] || state.stats[s] < 0) statsOk = false;
    }
  }

  check("energy stays within [0, 100] for a whole career", energyOk);
  check("tokens never exceed their cap or go negative", tokensOk);
  check("stats never exceed the run's caps", statsOk);
  check("turn advances by exactly one each step", monotonicTurn);
  check("career terminates at the last concert turn",
    state.turn === dataset.constants.careerTurns + 1, `turn ${state.turn}`);
  check("all five concerts were held", state.scenario.concertsHeld === 5,
    `${state.scenario.concertsHeld}`);
  check("token caps grew with each concert",
    state.scenario.tokenCaps.dance === 200 + 50 * 5, `${state.scenario.tokenCaps.dance}`);
}

// ---------------------------------------------------------------------------
// Shop rules
// ---------------------------------------------------------------------------

{
  const scenario = makeScenario();
  let state = scenario.initialState();
  check("nothing is affordable with zero tokens", scenario.legalShopActions(state).length === 0);

  state.scenario.tokens = { dance: 300, passion: 300, vocal: 300, visual: 300, mental: 300 };
  const shop = scenario.legalShopActions(state);
  check("with tokens, both techniques and songs are offered",
    shop.some((a) => a.kind === "technique") && shop.some((a) => a.kind === "song"));

  const song = shop.find((a) => a.kind === "song")!;
  const after = scenario.buy(state, song);
  check("buying a song adds it and deducts its cost",
    after.scenario.songsOwned.length === 1 &&
    TOKENS.some((t) => after.scenario.tokens[t] < state.scenario.tokens[t]));
  check("buying a song costs no turn", after.turn === state.turn);

  let threw = false;
  try { scenario.buy(after, song); } catch { threw = true; }
  check("buying the same song twice is rejected", threw);
}

// ---------------------------------------------------------------------------
// Friend outing chains
// ---------------------------------------------------------------------------

{
  const chains = (dataset as unknown as {
    friendEvents: Array<{ charaId: number; totalSteps: number }>;
  }).friendEvents;

  check("friend outing chains are extracted", chains?.length === 5, `${chains?.length}`);
  check("chain lengths are not uniform -- Sasami has 3 where others have 5",
    chains.some((c) => c.totalSteps === 3) && chains.some((c) => c.totalSteps === 5),
    chains.map((c) => c.totalSteps).join(","));

  const scenario = makeScenario();
  let state = scenario.initialState();
  const lightHello = 9008;

  const before = scenario.friendChainStatus(state).find((f) => f.charaId === lightHello)!;
  check("a chain starts at zero and is feasible at turn 1",
    before.done === 0 && before.remaining === 5 && before.feasible);

  const rng = mulberry32(3);
  state = scenario.step(state, { kind: "recreation", companionCharaId: lightHello }, rng);
  const after = scenario.friendChainStatus(state).find((f) => f.charaId === lightHello)!;
  check("an outing with a friend advances that friend's chain",
    after.done === 1 && after.remaining === 4);

  const solo = scenario.step(state, { kind: "recreation" }, rng);
  check("a solo recreation advances no chain",
    (solo.scenario.friendEventProgress[lightHello] ?? 0) === 1);

  // Over-advancing must not run past the end of the chain.
  let s2 = state;
  for (let i = 0; i < 10; i++) {
    s2 = scenario.step(s2, { kind: "recreation", companionCharaId: lightHello }, rng);
  }
  check("a chain cannot advance past its length",
    (s2.scenario.friendEventProgress[lightHello] ?? 0) === 5);

  // Feasibility is the point: it has to go false when the turns run out.
  const late = { ...state, turn: dataset.constants.careerTurns };
  const lateStatus = scenario.friendChainStatus(late).find((f) => f.charaId === lightHello)!;
  check("an unfinished chain is flagged infeasible when turns run out",
    !lateStatus.feasible, `${lateStatus.remaining} left, ${lateStatus.turnsLeft} turns`);
}

// ---------------------------------------------------------------------------
// Golden file
// ---------------------------------------------------------------------------

{
  const { state } = playCareer(20260905);
  const summary = {
    turn: state.turn,
    stats: state.stats,
    energy: state.energy,
    skillPoints: state.skillPoints,
    tokens: state.scenario.tokens,
    tokenCaps: state.scenario.tokenCaps,
    songsOwned: state.scenario.songsOwned.length,
    techniquesTotal: state.scenario.techniquesTotal,
    concertsHeld: state.scenario.concertsHeld,
    bonds: state.scenario.cards.map((c) => c.bond),
  };
  const digest = createHash("sha256").update(JSON.stringify(summary)).digest("hex").slice(0, 16);

  if (!existsSync(GOLDEN) || process.env.UPDATE_GOLDEN) {
    writeFileSync(GOLDEN, JSON.stringify({ digest, summary }, null, 2) + "\n");
    console.log(`  ..  golden file ${existsSync(GOLDEN) ? "updated" : "created"} (${digest})`);
  } else {
    const golden = JSON.parse(readFileSync(GOLDEN, "utf8"));
    check("golden career matches", golden.digest === digest,
      golden.digest === digest ? digest
        : `expected ${golden.digest}, got ${digest} -- if the model changed on purpose, re-run with UPDATE_GOLDEN=1`);
  }
  console.log(`\n  final: ${JSON.stringify(summary.stats)}  SP ${summary.skillPoints}`);
  console.log(`  assumptions carried: ${state.scenario.assumptions.length}`);
}

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
