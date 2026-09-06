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
import { decodeEffectText } from "../../data/src/effects";
import { greedyShop } from "../src/planner/rollout";
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
      state = scenario.step(state, { kind: "recreation" }, rng);
    } else {
      let pick: Stat = "speed";
      let worst = Infinity;
      for (const stat of STATS) {
        const ratio = state.stats[stat] / scenario.statCaps[stat];
        if (ratio < worst) { worst = ratio; pick = stat; }
      }
      state = scenario.step(state, { kind: "train", facility: pick }, rng);
    }

    // The same shopper the planner's rollout and the projection CLI use, so
    // the golden career regresses the code that actually ships.
    //
    // It bought techniques ONLY until 2026-09-06, so the golden summary read
    // songsOwned: 0 and the whole song path was covered by nothing. Changing it
    // to "songs first, then techniques" did not help: measured on real data a
    // song was affordable on 0 of 72 turns, so first-among-affordable never
    // reached one. See greedyShop.
    state = greedyShop(scenario, state, 4);
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
// Group cards
//
// The regression these guard: a group card has `stat: null` like a friend card,
// but unlike a friend card it carries a real friendship_bonus. The old
// `card.stat === facility` test meant that bonus could never fire on any
// facility -- the card was extracted, placed, and then ignored by the one term
// that made it worth playing, and it failed silently as a slightly low number.
// ---------------------------------------------------------------------------

{
  const baseArgs = {
    facility: "speed" as Stat, facilityLevel: 1, mood: "normal" as const,
    growthRate: {}, facilityTable: training.facilities,
    statCaps: dataset.constants.statCaps,
    currentStats: { speed: 0, stamina: 0, power: 0, guts: 0, wit: 0 },
  };
  // Team Sirius at max: friendship_bonus 15%, and a bond-80 unique effect
  // worth training_effectiveness +10.
  const teamSirius = {
    cardId: 30081, stat: null, kind: "group" as const,
    effects: { friendship_bonus: 15 },
    bondThresholdEffects: [
      { bondAtLeast: 80, effect: "training_effectiveness" as const, amount: 10 },
    ],
  };
  const lightHello = {
    cardId: 30052, stat: null, kind: "friend" as const,
    effects: { friendship_bonus: 15 },  // deliberately nonzero; must be ignored
  };

  const cold = computeTraining({ ...baseArgs, cards: [{ ...teamSirius, bond: 40 }] });
  const warm = computeTraining({ ...baseArgs, cards: [{ ...teamSirius, bond: 80 }] });

  check("a group card's friendship bonus applies at bond 80 with no matching facility",
    warm.terms.friendship > 1 && cold.terms.friendship === 1,
    `bond 80 -> x${warm.terms.friendship.toFixed(2)}, bond 40 -> x${cold.terms.friendship}`);
  check("a group card at bond 80 out-trains the same card below it",
    warm.gains.speed > cold.gains.speed,
    `${warm.gains.speed} > ${cold.gains.speed}`);
  check("the bond-80 unique effect reaches the training effectiveness term",
    warm.terms.trainingEffectiveness > cold.terms.trainingEffectiveness,
    `${warm.terms.trainingEffectiveness} vs ${cold.terms.trainingEffectiveness}`);

  check("a group card never counts as rainbow",
    warm.terms.rainbowCards === 0 && warm.terms.friendshipCards === 1,
    "no facility means no rainbow glow, but the friendship bonus is real");

  const friend = computeTraining({ ...baseArgs, cards: [{ ...lightHello, bond: 100 }] });
  check("a friend card contributes no friendship bonus even at full bond",
    friend.terms.friendship === 1 && friend.terms.friendshipCards === 0,
    "friend cards have friendship_bonus 0 on all 10 in master.mdb");

  check("the group assumption is surfaced, not buried",
    warm.assumptions.some((a) => a.includes("group card")),
    "the bond-80 condition is a modelling choice, not a decoded fact");

  // The failure mode this whole change exists to prevent: omitting `kind` makes
  // a group card indistinguishable from a friend card.
  const untagged = computeTraining({
    ...baseArgs,
    cards: [{ cardId: 30081, stat: null, bond: 100, effects: { friendship_bonus: 15 } }],
  });
  check("an untagged stat-less card is treated as a friend, not a group card",
    untagged.terms.friendship === 1,
    "this is the OLD behaviour, kept explicit so the difference is visible");
}

// ---------------------------------------------------------------------------
// Outing scheduling
// ---------------------------------------------------------------------------

{
  const scenario = makeScenario();
  const state = scenario.initialState();
  const status = scenario.friendChainStatus(state);

  check("every companion is tracked, group cards included",
    status.length === ((dataset as any).outingChains?.length ?? 0) && status.length === 7,
    status.map((c) => `${c.name}:${c.total}`).join(" "));

  const sirius = status.find((c) => c.charaId === 30081);
  check("Team Sirius owes 7 outings, not 1",
    sirius?.total === 7 && sirius.kind === "group",
    "the card chain is 1 step; the six member outings are the real cost");
  check("group outings are not all-or-nothing, friend chains are",
    status.filter((c) => c.kind === "group").every((c) => !c.allOrNothing) &&
    status.filter((c) => c.kind === "friend").every((c) => c.allOrNothing),
    "a half-finished group card leaves value on the table; a half-finished " +
    "friend chain wastes the turns already spent");

  // Advancing one member outing must not complete the card.
  let advanced = scenario.step(state, { kind: "recreation", companionCharaId: 30081 },
    mulberry32(7));
  const after = scenario.friendChainStatus(advanced).find((c) => c.charaId === 30081)!;
  check("one outing advances progress by exactly one",
    after.done === 1 && after.remaining === 6);

  const total = status.reduce((n, c) => n + c.total, 0);
  check("the full outing bill is reported",
    total === 35,
    `${total} turns of outings across all 7 companions, against a 72-turn career`);

  // Team Sirius is banned from Grand Concert, so the bill a real run can
  // actually face is smaller than the dataset-wide total.
  const playable = status.filter((c) => c.charaId !== 30081)
    .reduce((n, c) => n + c.total, 0);
  check("the bill a Grand Concert run can face excludes the banned card",
    playable === 28, `${playable} turns once Team Sirius is out`);
}

// ---------------------------------------------------------------------------
// Scenario card restrictions
//
// single_mode_restrict_support bans Team Sirius from Grand Concert. Confirmed in
// game 2026-09-06: it is not selectable. A plan built on a deck the game will
// not let you field is worse than no plan, so the scenario refuses it.
// ---------------------------------------------------------------------------

{
  const bannedDeck = [
    { cardId: 30081, stat: null, kind: "group" as const, bond: 0, effects: {} },
  ];
  let threw = "";
  try {
    new GrandConcertScenario(dataset, { cards: bannedDeck });
  } catch (e) {
    threw = (e as Error).message;
  }
  check("a deck with Team Sirius is refused in Grand Concert",
    threw.includes("30081"), threw || "no error thrown");
  check("the refusal names the card and the way out",
    threw.includes("Team Sirius") && threw.includes("allowRestrictedCards"),
    threw);

  let escaped = true;
  try {
    new GrandConcertScenario(dataset, { cards: bannedDeck, allowRestrictedCards: true });
  } catch {
    escaped = false;
  }
  check("the escape hatch still allows an explicit experiment", escaped);

  const legal = new GrandConcertScenario(dataset, {
    cards: [{ cardId: 30067, stat: null, kind: "group" as const, bond: 0, effects: {} }],
  });
  check("Heirs to the Throne is legal in Grand Concert",
    legal.restrictedCards().length === 0,
    "the only group card this scenario can actually use");
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
// The three silent holes M3 found, pinned against the REAL dataset
// ---------------------------------------------------------------------------

/*
 * planner.ts already pins all three, but on a synthetic fixture -- which proves
 * the wiring exists, not that it does anything to this game's actual data. The
 * song check below is the one that matters: the engine decodes English text
 * with strict regexes, so if Grand Concert's real song descriptions do not
 * match them, the fix is real and its effect is zero.
 *
 * None of these depend on the rng stream, which the golden digest does. That is
 * deliberate: after a change like this one, the digest moves for reasons that
 * are mostly reshuffled luck, and a summary you cannot read is not a check.
 */
{
  const scenario = makeScenario();
  const start = scenario.initialState();

  const placed = STATS.reduce((n, f) => n + start.scenario.placement[f].length, 0);
  check("cards are on the board before the first turn is played",
    placed === CARDS.length, `${placed} of ${CARDS.length} placed`);

  const snapshot = JSON.stringify(start);
  const rec = scenario.step(start, { kind: "recreation" }, mulberry32(7));
  check("recreation changes the run",
    rec.mood !== start.mood || rec.energy !== start.energy,
    `mood ${start.mood} -> ${rec.mood}, energy ${start.energy} -> ${rec.energy}`);
  check("step still does not mutate its input", JSON.stringify(start) === snapshot);

  let threw = false;
  try {
    scenario.step(start, { kind: "outing" } as never, mulberry32(1));
  } catch { threw = true; }
  check("an unrecognised action is rejected, not silently a wasted turn", threw);
}

{
  // How much of the real song list the decoder actually understands. Not
  // pinned to a count -- a patch that adds songs is not a regression -- but a
  // decode rate of zero would mean the song wiring changes nothing in practice.
  let perTraining = 0;
  let oneOff = 0;
  const unknown = new Set<string>();
  for (const song of dataset.songs) {
    const d = decodeEffectText(song.mastery_bonus.text);
    if (Object.keys(d.perTrainingStat).length > 0 || d.perTrainingSkillPoints > 0) perTraining++;
    if (Object.keys(d.oneOffStat).length > 0 || d.oneOffSkillPoints > 0 || d.oneOffEnergy > 0) oneOff++;
    // A range clause is recorded in `unparsed` even though it WAS understood --
    // it is flagged because the midpoint is an approximation, not because the
    // parser failed. Only genuinely unrecognised clauses count here.
    for (const u of d.unparsed) {
      if (!u.startsWith("range approximated by midpoint:")) unknown.add(u);
    }
  }
  check("real song text decodes into per-training bonuses", perTraining > 0,
    `${perTraining} of ${dataset.songs.length} songs grant a per-training bonus, ` +
    `${oneOff} grant something one-off`);
  check("no song effect clause is silently ignored", unknown.size === 0,
    unknown.size === 0
      ? "every clause recognised"
      : `${unknown.size} unrecognised, each contributing nothing: ` +
        [...unknown].slice(0, 3).join(" | "));

  const scenario = makeScenario();
  const start = scenario.initialState();
  const song = dataset.songs.find(
    (s) => Object.keys(decodeEffectText(s.mastery_bonus.text).perTrainingStat).length > 0,
  );
  if (!song) {
    check("a song granting a per-training stat bonus exists to test with", false);
  } else {
    const stat = Object.keys(
      decodeEffectText(song.mastery_bonus.text).perTrainingStat,
    )[0] as Stat;
    const funded: GcRunState = {
      ...start,
      scenario: {
        ...start.scenario,
        tokens: { dance: 999, passion: 999, vocal: 999, visual: 999, mental: 999 },
      },
    };
    const owned = scenario.buy(funded, { kind: "song", id: song.id });
    const without = scenario.step(funded, { kind: "train", facility: stat }, mulberry32(99));
    const with_ = scenario.step(owned, { kind: "train", facility: stat }, mulberry32(99));
    check(`owning "${song.name ?? song.id}" raises what ${stat} training yields`,
      with_.stats[stat] - owned.stats[stat] > without.stats[stat] - funded.stats[stat],
      `+${without.stats[stat] - funded.stats[stat]} without, ` +
      `+${with_.stats[stat] - owned.stats[stat]} with`);
  }
}

// ---------------------------------------------------------------------------
// The shop treadmill, pinned on the real dataset
// ---------------------------------------------------------------------------

/*
 * planner.ts pins this on a fixture. It has to be pinned here too, because the
 * bug was a property of the REAL cost structure and no fixture found it: songs
 * need two currencies at once (the cheapest is Passion 21 + Visual 21) while
 * techniques are cheap and often single-currency (the cheapest is Dance 8 and
 * nothing else), so techniques skim each currency away before a song can ever
 * be reached. Measured before the fix: a song was affordable on 0 of 72 turns,
 * on every seed tried.
 */
{
  const scenario = makeScenario();

  const legacyShop = (state: GcRunState, n: number): GcRunState => {
    let x = state;
    for (let i = 0; i < n; i++) {
      const a = scenario.legalShopActions(x);
      const pick = a.find((y) => y.kind === "song") ?? a.find((y) => y.kind === "technique");
      if (!pick) break;
      x = scenario.buy(x, pick);
    }
    return x;
  };

  const play = (seed: number, shop: (s: GcRunState, n: number) => GcRunState) => {
    let state = scenario.initialState();
    const rng = mulberry32(seed);
    let affordable = 0;
    while (!scenario.isTerminal(state)) {
      let pick: Stat = "speed";
      let worst = Infinity;
      for (const stat of STATS) {
        const r = state.stats[stat] / scenario.statCaps[stat];
        if (r < worst) { worst = r; pick = stat; }
      }
      state = state.energy < 30
        ? scenario.step(state, { kind: "rest" }, rng)
        : scenario.step(state, { kind: "train", facility: pick }, rng);
      if (scenario.legalShopActions(state).some((a) => a.kind === "song")) affordable++;
      state = shop(state, 4);
    }
    return { state, affordable };
  };

  const legacy = play(20260905, legacyShop);
  const shipped = play(20260905, (st, n) => greedyShop(scenario, st, n));

  check("the pre-fix shop rule bought no song in a real career",
    legacy.state.scenario.songsOwned.length === 0,
    `${legacy.state.scenario.songsOwned.length} songs, ` +
    `${legacy.state.scenario.techniquesTotal} techniques, ` +
    `a song affordable on ${legacy.affordable} of 72 turns`);

  check("the shipped shop rule buys songs in a real career",
    shipped.state.scenario.songsOwned.length > 0,
    `${shipped.state.scenario.songsOwned.length} songs, ` +
    `${shipped.state.scenario.techniquesTotal} techniques, ` +
    `SP ${shipped.state.skillPoints} (was ${legacy.state.skillPoints})`);

  check("it still buys techniques -- reserving without a per-currency surplus buys none",
    shipped.state.scenario.techniquesTotal > 0,
    `${shipped.state.scenario.techniquesTotal} techniques`);

  const gain = STATS.reduce((a, x) => a + shipped.state.stats[x], 0)
    - STATS.reduce((a, x) => a + legacy.state.stats[x], 0);
  console.log(`  ..  songs are worth ${gain > 0 ? "+" : ""}${gain} total stat points over this career, ` +
    `for ${shipped.state.skillPoints - legacy.state.skillPoints} skill points`);
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

  // Both spellings, because an env var is a cross-platform trap here. Setting
  // UPDATE_GOLDEN=1 inline works on bash; the PowerShell equivalent
  // ($env:UPDATE_GOLDEN=1) sets it for the whole SHELL SESSION, so if it is not
  // unset afterwards every later `npm test` silently rewrites the golden file
  // instead of checking it -- the regression stops existing and nothing says
  // so. A flag cannot leak past the command that carries it.
  const updateRequested =
    process.env.UPDATE_GOLDEN !== undefined || process.argv.includes("--update-golden");

  if (!existsSync(GOLDEN) || updateRequested) {
    writeFileSync(GOLDEN, JSON.stringify({ digest, summary }, null, 2) + "\n");
    console.log(`  ..  golden file ${existsSync(GOLDEN) ? "updated" : "created"} (${digest})`);
  } else {
    const golden = JSON.parse(readFileSync(GOLDEN, "utf8"));
    check("golden career matches", golden.digest === digest,
      golden.digest === digest ? digest
        : `expected ${golden.digest}, got ${digest} -- if the model changed on ` +
          `purpose, read the diff and then re-pin with \`npm run golden\``);
  }
  console.log(`\n  final: ${JSON.stringify(summary.stats)}  SP ${summary.skillPoints}`);
  console.log(`  assumptions carried: ${state.scenario.assumptions.length}`);
}

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
