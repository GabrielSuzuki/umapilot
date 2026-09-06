/**
 * A SYNTHETIC Grand Concert dataset. Not extracted. Not real. Never shipped.
 *
 * ---------------------------------------------------------------------------
 * Why this exists, and why it is not a violation of the one rule
 * ---------------------------------------------------------------------------
 *
 * CONTRIBUTING.md says: don't write a guess into the dataset. This is not a
 * dataset. Nothing here is claimed to describe the game, nothing here is
 * loadable by the extractor's output path, and no test in this file asserts a
 * game fact.
 *
 * It exists because the planner needs testing and the real dataset cannot be
 * committed -- it is the player's own game data, and packages/data/generated is
 * gitignored for that reason. Before this, every engine test simply skipped
 * itself on a machine without master.mdb, which means CI has never actually run
 * any of them. A search is exactly the kind of code that needs a regression
 * suite that runs everywhere: it has an interior ordering, a pruning rule and a
 * sampling scheme, and every one of those can break without changing a single
 * game number.
 *
 * So the numbers below are chosen to be OBVIOUSLY not the game -- round,
 * uniform, small -- and the tests that use them assert properties of the SEARCH
 * (purity, determinism, legality, whether the beam beats the rollout policy),
 * never properties of Umamusume. If a test here would fail when Cygames ships a
 * patch, it is the wrong test.
 *
 * The real dataset still runs the same planner tests when it is present. This
 * is the floor, not the ceiling.
 */

import type {
  GrandConcertDataset, Stat, Token, TokenVector,
} from "../../../data/src/types";
import { STATS } from "../../../data/src/types";
import type { CardState } from "../../src/scenarios/grand-concert";

const tokens = (d = 0, p = 0, v = 0, vi = 0, m = 0): TokenVector => ({
  dance: d, passion: p, vocal: v, visual: vi, mental: m,
});


/** Flat, uniform, and nothing like the real curve. That is the point. */
function facilityLevels(stat: Stat) {
  const level1: Record<string, number | string> = { [stat]: 8, energy: -20, skill_points: 2, source: "SYNTHETIC" };
  const level5: Record<string, number | string> = { [stat]: 16, energy: -24, skill_points: 4, source: "SYNTHETIC" };
  if (stat === "wit") { level1["energy"] = 5; level5["energy"] = 5; }
  return { "1": level1, "5": level5 };
}

export const SYNTHETIC_CARDS: CardState[] = [
  { cardId: 1, stat: "speed",   bond: 0, kind: "stat",   effects: { friendship_bonus: 30, mood_effect: 30, training_effectiveness: 10, speed_bonus: 1, initial_friendship: 25 } },
  { cardId: 2, stat: "speed",   bond: 0, kind: "stat",   effects: { friendship_bonus: 25, mood_effect: 20, training_effectiveness: 10, speed_bonus: 1, initial_friendship: 20 } },
  { cardId: 3, stat: "stamina", bond: 0, kind: "stat",   effects: { friendship_bonus: 25, training_effectiveness: 10, stamina_bonus: 1, initial_friendship: 20 } },
  { cardId: 4, stat: "power",   bond: 0, kind: "stat",   effects: { friendship_bonus: 25, training_effectiveness: 10, power_bonus: 1, initial_friendship: 20 } },
  { cardId: 5, stat: "wit",     bond: 0, kind: "stat",   effects: { friendship_bonus: 20, training_effectiveness: 10, wit_bonus: 1, initial_friendship: 20 } },
  { cardId: 6, stat: null,      bond: 0, kind: "friend", effects: { mood_effect: 30, training_effectiveness: 5, initial_friendship: 20 } },
];

export function syntheticDataset(): GrandConcertDataset {
  const facilities = {} as Record<Stat, ReturnType<typeof facilityLevels>>;
  const failureRateBase = {} as Record<string, Record<string, number>>;
  for (const stat of STATS) {
    facilities[stat] = facilityLevels(stat);
    // Wit deliberately safer than the rest, which is the one qualitative fact
    // the policies depend on. The magnitudes are invented.
    failureRateBase[stat] = stat === "wit" ? { "1": 300, "5": 300 } : { "1": 500, "5": 500 };
  }

  // Cheap and mostly SINGLE-currency, which is the shape that matters. The real
  // cheapest technique costs 8 Dance and nothing else, and that is precisely
  // what let techniques skim every currency away before a song -- which needs
  // two currencies at once -- could ever be afforded. A fixture with evenly
  // spread technique costs cannot reproduce that, and a fixture that cannot
  // reproduce it makes the regression below vacuous.
  const CURRENCIES = ["dance", "passion", "vocal", "visual", "mental"] as const;
  // Three tiers of a GATED family, plus ungated energy and hints, because the
  // tier gate is the thing under test and a fixture where every technique is
  // tier 1 cannot express it. The effect wording is the game's real grammar --
  // the engine classifies by text, so text that does not parse would exercise
  // none of the gating path.
  const techniqueEffects = [
    "Skill Pts +5", "Skill Pts +8", "Skill Pts +12",
    "Speed +5", "Speed +8", "Speed +12",
    "Guts +5", "Guts +8",
    "Energy +20", "Energy +30", "Energy +40",
    "Skill Hint Lvl +1 (Sprint)", "Skill Hint Lvl +2 (Sprint)",
    "Wit +5", "Wit +8",
    "Stamina +5", "Stamina +8",
    "Power +5", "Power +8", "Power +12",
  ];
  const techniques = Array.from({ length: 20 }, (_, i) => {
    const cost = tokens();
    cost[CURRENCIES[i % 5]!] = 8 + (i % 4) * 3;
    return {
      id: 100 + i,
      name: `Synthetic Technique ${i + 1}`,
      kind: "technique_stat" as const,
      cost,
      effect: { text: techniqueEffects[i] ?? "Skill Pts +5", raw: [] },
    };
  });

  // The effect TEXT is shaped like the game's, because the engine decodes
  // English text rather than opcodes and a fixture whose text does not parse
  // would exercise none of that path -- which is exactly how the song-bonus
  // wiring stayed missing without any test noticing. The numbers are invented;
  // the grammar is the real one.
  const songEffects = [
    "Training Speed Gain +1",
    "Training Stamina Gain +1",
    "Training Power Gain +1\nSkill Pts +10",
    "Training Skill Pt Gain +1",
    "Speed +20",
    "Training Speed Gain +2",
    "Training Guts Gain +1",
    "Training Wit Gain +1\nEnergy +10",
  ];
  // Two currencies at once, like the real ones: the cheapest song in the game
  // is Passion 21 + Visual 21 and nothing else.
  const concertEffects = [
    "Friendship Training Effectiveness +5%",
    "Support Chain Event Frequency Lvl +1",
    "Friendship Training Effectiveness +10%",
    "Specialty Priority +5",
    "Friendship Training Effectiveness +5%",
    "Support Chain Event Frequency Lvl +1",
    "Specialty Priority +5",
    "Friendship Training Effectiveness +5%",
  ];
  const songs = Array.from({ length: 8 }, (_, i) => {
    const cost = tokens();
    // Scaled to this fixture's 24-turn career: the real cheapest song is 21+21
    // against 72 turns of income, so 18+18 against 24 turns keeps a song a
    // genuine multi-turn saving problem without making it unreachable.
    cost[CURRENCIES[i % 5]!] = 18;
    cost[CURRENCIES[(i + 3) % 5]!] = 18;
    return {
      id: 200 + i,
      name: `Synthetic Song ${i + 1}`,
      cost,
      mastery_bonus: { text: songEffects[i] ?? "Training Speed Gain +1", raw: [] },
      // The wording the game actually prints, because the engine reads text
      // rather than opcodes. All three real types appear so the decoder's
      // whole surface is exercised, including the one not yet seen on screen.
      concert_bonus: { text: concertEffects[i] ?? "Specialty Priority +5", raw: [] },
      concert_bonus_type: null,
      concert_bonus_value: null,
      live_id: null,
    };
  });

  const facilityTokens: Record<Stat, { primary: Token; secondary: Token }> = {
    speed: { primary: "dance", secondary: "visual" },
    stamina: { primary: "passion", secondary: "vocal" },
    power: { primary: "vocal", secondary: "mental" },
    guts: { primary: "visual", secondary: "dance" },
    wit: { primary: "mental", secondary: "passion" },
  };

  const dataset = {
    schemaVersion: 1,
    scenario: "grand-concert",
    source: {
      // Loud on purpose. If this ever turns up in a projection's provenance
      // field, something has loaded a fixture as if it were game data.
      file: "SYNTHETIC-FIXTURE-NOT-EXTRACTED",
      sha256: "0".repeat(64),
      extractedAt: "1970-01-01T00:00:00Z",
    },
    constants: {
      tokens: ["dance", "passion", "vocal", "visual", "mental"],
      facilityTokens,
      tokenRollWeights: { primary: 0.6, secondary: 0.3, other: 0.1 },
      statCaps: { speed: 1200, stamina: 1200, power: 1200, guts: 1200, wit: 1200 },
      careerTurns: 24,
    },
    concerts: [
      { index: 0, turn: 8, songs_for_great_success: 3, is_grand_concert: false },
      { index: 1, turn: 16, songs_for_great_success: 3, is_grand_concert: false },
      { index: 2, turn: 23, songs_for_great_success: 3, is_grand_concert: true },
    ],
    techniques,
    songs,
    training: {
      facilities,
      failureRateBase,
      otherCommands: {
        "1": { name: "Riverside", kind: "recreation", variants: [{ energy: 10, mood: 1 }] },
        "2": { name: "Karaoke", kind: "recreation", variants: [{ energy: 0, mood: 2 }] },
      },
    },
    outingChains: [
      { kind: "friend", charaId: 9001, name: "Synthetic Friend", totalSteps: 3, totalOutings: 3 },
    ],
  };

  return dataset as unknown as GrandConcertDataset;
}

/**
 * A 24-turn career rather than 72.
 *
 * Short on purpose: the planner tests want many full runs per second, and the
 * properties under test -- determinism, legality, beam versus policy -- do not
 * depend on the career being long. Anything that DOES depend on career length
 * belongs in the tests that run against the real dataset.
 */
export const SYNTHETIC_CAREER_TURNS = 24;
