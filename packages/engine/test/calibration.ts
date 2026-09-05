/**
 * M2 tests: prove the diagnostics work before real data exists.
 *
 * The method is to generate synthetic observations from a "true" model with ONE
 * term deliberately broken, then assert the residual analysis fingers that
 * specific term. If it can find a planted bug, a clean result on real data is
 * evidence rather than a hopeful reading of noise.
 *
 * This is the difference between a diagnostic tool and a wall of numbers.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { GrandConcertDataset, Stat } from "../../data/src/types";
import { MOOD_VALUES, type FacilityTable, type Mood, type PlacedCard } from "../src/scenarios/grand-concert/training";
import { parseLog, serializeLog, validateObservation, type Observation } from "../src/calibration/log";
import { computeResiduals, diagnose, solveBaseValues } from "../src/calibration/fit";
import { decodeEffectText, accumulatePerTrainingBonuses } from "../../data/src/effects";
import { computeTraining } from "../src/scenarios/grand-concert/training";
import { STATS, type StatVector } from "../../data/src/types";

const NO_CAPS: StatVector = {
  speed: Infinity, stamina: Infinity, power: Infinity, guts: Infinity, wit: Infinity,
};
const ZERO_STATS_LOCAL: StatVector = {
  speed: 0, stamina: 0, power: 0, guts: 0, wit: 0,
};

const GEN = join(import.meta.dirname, "../../data/generated");
const hasData = (() => {
  try { return readdirSync(GEN).some((f) => f.startsWith("grand-concert.") && !f.includes("latest")); }
  catch { return false; }
})();

if (!hasData) {
  console.log("no generated dataset -- skipping calibration tests.");
  process.exit(0);
}

const file = readdirSync(GEN).filter((f) => f.startsWith("grand-concert.") && !f.includes("latest"))[0]!;
const dataset: GrandConcertDataset = JSON.parse(readFileSync(join(GEN, file), "utf8"));
const facilityTable = (dataset as unknown as { training: { facilities: FacilityTable } }).training.facilities;

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "  ok  " : "FAIL  "}${name}${detail ? "  " + detail : ""}`);
  if (!ok) failures++;
};

// ---------------------------------------------------------------------------
// A synthetic "game" we control exactly
// ---------------------------------------------------------------------------

const CARD_EFFECTS: Record<number, PlacedCard["effects"]> = {
  1: { friendship_bonus: 30, mood_effect: 40, training_effectiveness: 15 },
  2: { friendship_bonus: 25, mood_effect: 30, training_effectiveness: 10 },
  3: { friendship_bonus: 20, training_effectiveness: 10 },
  9: { mood_effect: 20, training_effectiveness: 5 },
};
const effectsFor = (id: number): PlacedCard["effects"] => CARD_EFFECTS[id] ?? {};

interface Distortion {
  friendshipScale?: number;
  levelScale?: (level: number) => number;
  countScale?: (n: number) => number;
  moodScale?: (mood: Mood) => number;
  flat?: number;
}

/** The "real game": our own formula, optionally with one term distorted. */
function syntheticGain(o: Observation, d: Distortion): number {
  const levels = facilityTable[o.facility]!;
  const lo = (levels["1"] as Record<string, number>)[o.facility]!;
  const hi = (levels["5"] as Record<string, number>)[o.facility]!;
  const base = lo + ((hi - lo) * (o.facilityLevel - 1)) / 4;

  let friendship = 1, moodEffect = 0, trainingEff = 0;
  for (const c of o.cards) {
    const e = effectsFor(c.cardId);
    if (c.stat === o.facility && c.bond >= 80) {
      friendship *= 1 + ((e.friendship_bonus ?? 0) / 100) * (d.friendshipScale ?? 1);
    }
    moodEffect += e.mood_effect ?? 0;
    trainingEff += e.training_effectiveness ?? 0;
  }

  const moodTerm = (1 + MOOD_VALUES[o.mood] * (1 + moodEffect / 100)) * (d.moodScale?.(o.mood) ?? 1);
  const effTerm = 1 + trainingEff / 100;
  const countTerm = (1 + 0.05 * o.cards.length) * (d.countScale?.(o.cards.length) ?? 1);
  const levelTerm = d.levelScale?.(o.facilityLevel) ?? 1;

  return Math.floor(base * friendship * moodTerm * effTerm * countTerm * levelTerm * (d.flat ?? 1));
}

const MOODS: Mood[] = ["normal", "good", "great"];
const FACILITIES: Stat[] = ["speed", "stamina", "power"];

/** Deterministic sweep across levels, moods, card counts and bond states. */
function makeObservations(d: Distortion): Observation[] {
  const out: Observation[] = [];
  let turn = 1;
  for (const facility of FACILITIES) {
    for (let level = 1; level <= 5; level++) {
      for (const mood of MOODS) {
        for (let n = 1; n <= 3; n++) {
          for (const rainbow of [false, true]) {
            const cards = Array.from({ length: n }, (_, i) => ({
              cardId: i + 1,
              bond: rainbow && i === 0 ? 95 : 20,
              stat: i === 0 ? facility : ("guts" as Stat),
            }));
            const o: Observation = {
              turn: turn++,
              facility,
              facilityLevel: level,
              mood,
              predictedGains: { [facility]: 0 },
              cards,
              source: "synthetic",
            };
            o.predictedGains[facility] = syntheticGain(o, d);
            out.push(o);
          }
        }
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Log format
// ---------------------------------------------------------------------------

{
  const obs = makeObservations({});
  const round = parseLog(serializeLog(obs));
  check("log survives a serialise/parse round trip",
    round.observations.length === obs.length && round.errors.length === 0);

  const bad = parseLog([
    JSON.stringify(obs[0]),
    "{ not json",
    JSON.stringify({ ...obs[0], facility: "charisma" }),
    JSON.stringify({ ...obs[0], predictedGains: {} }),
    JSON.stringify(obs[1]),
  ].join("\n"));
  check("bad lines are skipped, not fatal",
    bad.observations.length === 2 && bad.errors.length === 3,
    `${bad.observations.length} kept, ${bad.errors.length} skipped`);
  check("a bad line reports its line number and reason",
    bad.errors[0]!.line === 2 && bad.errors[1]!.message.includes("facility"));

  check("an observation missing its own facility's gain is rejected",
    validateObservation({ ...obs[0], facility: "speed", predictedGains: { power: 5 } }).length > 0);
  check("comments and blank lines are ignored",
    parseLog(`# a note\n\n${JSON.stringify(obs[0])}\n`).observations.length === 1);
}

// ---------------------------------------------------------------------------
// The model agrees with itself
// ---------------------------------------------------------------------------

{
  // Level 1 and 5 are exact in both the synthetic game and the model, so those
  // rows must come back at ratio 1.0.
  const obs = makeObservations({}).filter((o) => o.facilityLevel === 1 || o.facilityLevel === 5);
  const res = computeResiduals(obs, facilityTable, effectsFor);
  const d = diagnose(res);
  check("undistorted model matches the synthetic game at known levels",
    Math.abs(d.overallMeanRatio - 1) < 0.02, `ratio ${d.overallMeanRatio}`);
  check("no term is flagged when nothing is wrong",
    d.groupings[0]!.spread < 0.05, `largest spread ${d.groupings[0]!.spread}`);
}

// ---------------------------------------------------------------------------
// Planted bug 1: the friendship term is too weak
// ---------------------------------------------------------------------------

{
  const obs = makeObservations({ friendshipScale: 2.2 })
    .filter((o) => o.facilityLevel === 1 || o.facilityLevel === 5);
  const d = diagnose(computeResiduals(obs, facilityTable, effectsFor));
  const top = d.groupings[0]!;
  check("a broken friendship term is identified as the leading suspect",
    top.term.includes("friendship"), `got "${top.term}" (spread ${top.spread})`);
  check("the friendship residual rises with rainbow count",
    top.buckets.length >= 2 &&
    top.buckets[top.buckets.length - 1]!.meanRatio > top.buckets[0]!.meanRatio,
    top.buckets.map((b) => `${b.key}:${b.meanRatio}`).join(" "));
  check("the verdict names it in plain language",
    d.verdict.some((v) => v.toLowerCase().includes("friendship")));
}

// ---------------------------------------------------------------------------
// Planted bug 2: the card-count term is wrong
// ---------------------------------------------------------------------------

{
  const obs = makeObservations({ countScale: (n) => 1 + 0.12 * n })
    .filter((o) => o.facilityLevel === 1 || o.facilityLevel === 5);
  const d = diagnose(computeResiduals(obs, facilityTable, effectsFor));
  check("a broken card-count term is identified",
    d.groupings[0]!.term.includes("card count"),
    `got "${d.groupings[0]!.term}" (spread ${d.groupings[0]!.spread})`);
}

// ---------------------------------------------------------------------------
// Planted bug 3: a flat scale error implicates no single term
// ---------------------------------------------------------------------------

{
  const obs = makeObservations({ flat: 1.4 })
    .filter((o) => o.facilityLevel === 1 || o.facilityLevel === 5);
  const d = diagnose(computeResiduals(obs, facilityTable, effectsFor));
  check("a flat error shows up in the overall ratio",
    d.overallMeanRatio > 1.3, `ratio ${d.overallMeanRatio}`);
  check("a flat error implicates no single multiplier",
    d.groupings[0]!.spread < 0.15, `largest spread ${d.groupings[0]!.spread}`);
  check("the verdict says the error is a flat scale factor",
    d.verdict.some((v) => v.includes("flat scale") || v.includes("UNDER-predicts")));
}

// ---------------------------------------------------------------------------
// Planted bug 4: the interpolated levels are wrong
// ---------------------------------------------------------------------------

{
  // Levels 2-4 in the "real game" sit above the straight line we assume.
  const curve = (level: number) => (level === 1 || level === 5 ? 1 : 1.35);
  const obs = makeObservations({ levelScale: curve });
  const d = diagnose(computeResiduals(obs, facilityTable, effectsFor));
  check("a wrong interpolation is identified as the leading suspect",
    d.groupings[0]!.term.includes("facility level"),
    `got "${d.groupings[0]!.term}" (spread ${d.groupings[0]!.spread})`);

  const solved = solveBaseValues(obs, facilityTable, effectsFor);
  check("the solver returns a value for every interpolated level",
    solved.length === FACILITIES.length * 3, `${solved.length}`);
  check("solved values are internally consistent (tight spread)",
    solved.every((s) => s.spread < 0.25),
    `max spread ${Math.max(...solved.map((s) => s.spread)).toFixed(3)}`);
  check("solved values exceed the current interpolation, as planted",
    solved.every((s) => s.implied > s.currentInterpolated),
    solved.slice(0, 3).map((s) => `${s.facility}L${s.level}: ${s.implied} vs ${s.currentInterpolated}`).join("  "));
}

// ---------------------------------------------------------------------------
// Small samples are called out rather than over-read
// ---------------------------------------------------------------------------

{
  const obs = makeObservations({}).slice(0, 6);
  const d = diagnose(computeResiduals(obs, facilityTable, effectsFor));
  check("a thin log is flagged as provisional",
    d.verdict.some((v) => v.includes("provisional")), d.verdict[0] ?? "");
}

// ---------------------------------------------------------------------------
// Song effect decoding (from the game's own text, not the opcodes)
// ---------------------------------------------------------------------------

{
  const perTraining = decodeEffectText("Training Speed Gain +2");
  check("a per-training song bonus decodes",
    perTraining.perTrainingStat.speed === 2 && perTraining.unparsed.length === 0);

  const oneOff = decodeEffectText("Speed +22");
  check("a one-off stat grant decodes, and is NOT per-training",
    oneOff.oneOffStat.speed === 22 && oneOff.perTrainingStat.speed === undefined);

  const sp = decodeEffectText("Training Skill Pt Gain +3");
  check("a per-training skill point bonus decodes", sp.perTrainingSkillPoints === 3);

  const multi = decodeEffectText("Guts +4\nSkill Pts +4");
  check("a multi-clause effect decodes both clauses",
    multi.oneOffStat.guts === 4 && multi.oneOffSkillPoints === 4);

  const hint = decodeEffectText("Skill hint appropriate for aptitude");
  check("a hint effect is recognised", hint.grantsHint);

  const unknown = decodeEffectText("Something entirely new");
  check("an unrecognised clause is reported, never silently dropped",
    unknown.unparsed.length === 1);

  // Every song and technique in the real dataset must decode.
  const songTexts = dataset.songs.map((s) => s.mastery_bonus.text);
  const acc = accumulatePerTrainingBonuses(songTexts);
  check("every song effect in the dataset parses",
    acc.unparsed.length === 0, acc.unparsed.slice(0, 2).join(" | "));
  check("owning every song gives per-training bonuses on all five stats",
    STATS.every((s) => (acc.stats[s] ?? 0) > 0),
    JSON.stringify(acc.stats) + ` +${acc.skillPoints} SP`);

  const techTexts = dataset.techniques.map((t) => t.effect.text);
  const techUnparsed = techTexts
    .map((t) => decodeEffectText(t).unparsed)
    .flat()
    .filter((u) => !u.startsWith("range approximated"));
  check("every technique effect in the dataset parses",
    techUnparsed.length === 0,
    `${techUnparsed.length} unparsed: ${[...new Set(techUnparsed)].slice(0, 3).join(" | ")}`);
}

// ---------------------------------------------------------------------------
// Song bonuses feed the training calculation
// ---------------------------------------------------------------------------

{
  const withoutSongs = computeTraining({
    facility: "speed", facilityLevel: 1, mood: "normal", growthRate: {},
    cards: [], facilityTable, statCaps: NO_CAPS, currentStats: ZERO_STATS_LOCAL,
  });
  const withSongs = computeTraining({
    facility: "speed", facilityLevel: 1, mood: "normal", growthRate: {},
    cards: [], facilityTable, statCaps: NO_CAPS, currentStats: ZERO_STATS_LOCAL,
    songBonuses: { speed: 3 },
  });
  check("song bonuses raise the gain",
    withSongs.gains.speed === withoutSongs.gains.speed + 3,
    `${withoutSongs.gains.speed} -> ${withSongs.gains.speed}`);
  check("a projection with no song bonuses says so in its assumptions",
    withoutSongs.assumptions.some((a) => a.includes("no song bonuses supplied")));
}

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
