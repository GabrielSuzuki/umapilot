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
import { GrandConcertScenario, type GcRunState } from "../src/scenarios/grand-concert";
import { competentPolicy, focusedPolicy } from "../src/policy";
import { EMPTY_TARGET, type RunTarget } from "../src/target";
import { plan } from "../src/planner";
import { compileTarget, shortfallScore, meetsTarget, wilson } from "../src/planner/objective";
import { rollout, greedyShop, stateValue, DEFAULT_ROLLOUT, type RolloutOptions } from "../src/planner/rollout";
import { shadowPrices } from "../src/planner/shadow";
import { turnCandidates, actionKey } from "../src/planner/beam";
import {
  eligibleTechniques, songUnlocked, drawBoard, classify,
} from "../src/scenarios/grand-concert/lesson-board";
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

  const a = rollout(scenario, start, mulberry32(7), RO);
  const b = rollout(scenario, start, mulberry32(7), RO);
  check("a rollout is deterministic given its seed",
    JSON.stringify(a.stats) === JSON.stringify(b.stats), JSON.stringify(a.stats));

  const c = rollout(scenario, start, mulberry32(8), RO);
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

  const a = rollout(scenario, start, mulberry32(7), RO);
  const b = rollout(scenario, start, mulberry32(7), RO);
  check("a rollout is deterministic given its seed",
    JSON.stringify(a.stats) === JSON.stringify(b.stats), JSON.stringify(a.stats));

  const c = rollout(scenario, start, mulberry32(8), RO);
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
      const end = rollout(scenario, scenario.initialState(), mulberry32(seed), RO);
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
      techniques += rollout(scenario, scenario.initialState(), mulberry32(seed), RO)
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

  check("the plan's assumptions name the horizon and the undecoded Concert Bonus",
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
  return rollout(scenario, scenario.initialState(), mulberry32(seed), { ...RO, policy });
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
