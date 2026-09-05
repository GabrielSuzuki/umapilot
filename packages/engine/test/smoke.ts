/**
 * M0 smoke test: load the generated dataset and exercise the target model
 * against it. Not a substitute for the M1 accuracy work -- this only proves the
 * data and the types line up.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { GrandConcertDataset, SkillIndex, SkillEntry } from "../../data/src/types";
import { TOKENS } from "../../data/src/types";
import { validateTarget, wishlistSpCost, searchSkills, effectiveStatCaps, EMPTY_TARGET } from "../src/target";

const GEN = join(import.meta.dirname, "../../data/generated");

const available = (() => {
  try {
    return readdirSync(GEN).some((f) => f.startsWith("grand-concert.") && !f.includes("latest"));
  } catch {
    return false;
  }
})();

// CI has no game client, so there is no dataset to test against. Skip cleanly
// rather than failing -- a red build for "you don't own the game" teaches
// nobody anything. The typecheck still runs, and this suite runs locally where
// the data exists.
if (!available) {
  console.log("no generated dataset found in packages/data/generated -- skipping.");
  console.log("run `npm run extract` against your own master.mdb first.");
  process.exit(0);
}

const pick = (p: string) =>
  readdirSync(GEN).filter((f) => f.startsWith(p) && !f.includes("latest"))[0]!;

const ds: GrandConcertDataset = JSON.parse(readFileSync(join(GEN, pick("grand-concert.")), "utf8"));
const idx: SkillIndex = JSON.parse(readFileSync(join(GEN, pick("skills.")), "utf8"));
const byId = new Map<number, SkillEntry>(idx.skills.map((s) => [s.id, s]));

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "  ok  " : "FAIL  "}${name}${detail ? "  " + detail : ""}`);
  if (!ok) failures++;
};

console.log(`dataset ${ds.scenario} @ ${ds.source.sha256.slice(0, 12)}\n`);

check("21 songs", ds.songs.length === 21, `got ${ds.songs.length}`);
check("5 concerts, last is the Grand Concert",
  ds.concerts.length === 5 && ds.concerts.at(-1)!.is_grand_concert);
check("career is 72 turns", ds.constants.careerTurns === 72);

const totals = Object.fromEntries(TOKENS.map((t) => [t, ds.songs.reduce((n, s) => n + s.cost[t], 0)]));
check("song cost totals match published figures",
  JSON.stringify(totals) === JSON.stringify({ dance: 252, passion: 201, vocal: 150, visual: 275, mental: 196 }),
  JSON.stringify(totals));

check("every song has a name and a nonzero cost",
  ds.songs.every((s) => s.name && TOKENS.some((t) => s.cost[t] > 0)));

// --- target model -------------------------------------------------------
const results = searchSkills("corner", idx.skills);
check("skill search finds corner skills", results.length > 0,
  results.slice(0, 3).map((s) => s.name).join(", "));

const target = {
  ...EMPTY_TARGET,
  stats: { speed: 1200, stamina: 700, power: 900, guts: 400, wit: 600 },
  skills: results.slice(0, 3).map((s) => ({ skillId: s.id, priority: "preferred" as const })),
};

check("a reachable target validates clean", validateTarget(target, ds.constants.statCaps, byId).length === 0);

const overCap = { ...target, stats: { ...target.stats, speed: 9999 } };
const capProblems = validateTarget(overCap, ds.constants.statCaps, byId);
check("a target above the stat cap is rejected",
  capProblems.some((p) => p.field === "stats.speed" && p.severity === "error"),
  capProblems[0]?.message ?? "");

const { total, unknown } = wishlistSpCost(target, byId);
check("wishlist SP cost resolves", total > 0 && unknown.length === 0, `${total} SP`);

// --- support cards ------------------------------------------------------
const cards = JSON.parse(readFileSync(join(GEN, pick("support-cards.")), "utf8"));
const byCardId = new Map<number, any>(cards.supportCards.map((c: any) => [c.id, c]));
check("235 support cards", cards.supportCards.length === 235);
check("command_id -> stat mapping holds for four known cards",
  byCardId.get(30002).stat === "speed" &&      // Silence Suzuka
  byCardId.get(30005).stat === "power" &&      // Vodka
  byCardId.get(30001).stat === "guts" &&       // Special Week
  byCardId.get(30004).stat === "stamina");     // Gold Ship
check("every card resolves a name", cards.supportCards.every((c: any) => !!c.name));
check("friend and group cards carry no facility",
  cards.supportCards.filter((c: any) => c.kind !== "stat").every((c: any) => c.stat === null));

// --- sparks / inspirations ----------------------------------------------
const sparks = JSON.parse(readFileSync(join(GEN, pick("sparks.")), "utf8"));
check("3 inspiration events", sparks.inspirationEvents.length === 3);
check("affinity has 3 ranks", sparks.affinityRanks.length === 3);
check("1139 succession factors", sparks.factors.length === 1139);

// --- per-run stat caps --------------------------------------------------
// Reproduces the scanned Legacy Select screen: legacy raised Stamina and Power.
const scanned = { stamina: 1366, power: 1316 };
const { caps, source } = effectiveStatCaps(ds.constants.statCaps, scanned);
check("scanned caps override the scenario base",
  source === "scanned" && caps.stamina === 1366 && caps.power === 1316 &&
  caps.speed === 1600 && caps.guts === 1500 && caps.wit === 1300);
check("a 1350 stamina target is legal under scanned caps but not the base",
  validateTarget({ ...target, stats: { ...target.stats, stamina: 1350 } }, caps, byId).length === 0 &&
  validateTarget({ ...target, stats: { ...target.stats, stamina: 1350 } }, ds.constants.statCaps, byId).length === 1);
check("with no scan we fall back to the scenario base",
  effectiveStatCaps(ds.constants.statCaps, null).source === "scenario-base");

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
