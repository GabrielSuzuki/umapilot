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
// Row counts are NOT pinned to a value. The game gets patched -- the dump these
// tests were written against had 235 cards, 697 skills and 1139 factors, and a
// later one had 250 / 714 / 1166. A test that fails because Cygames shipped new
// cards teaches nothing and trains you to ignore red. What IS worth asserting is
// that the table is populated and every row is well-formed, plus the specific
// cards whose facts these tests actually depend on.
check("support cards extracted", cards.supportCards.length >= 235,
  `${cards.supportCards.length} cards, ${cards.supportCards.filter((c: any) => c.rarity === "SSR").length} SSR`);
check("every support card is well-formed",
  cards.supportCards.every((c: any) =>
    typeof c.id === "number" && !!c.name && !!c.kind &&
    (c.kind !== "stat" || c.stat !== null)),
  "id, name, kind, and a facility on every stat card");
check("command_id -> stat mapping holds for four known cards",
  byCardId.get(30002).stat === "speed" &&      // Silence Suzuka
  byCardId.get(30005).stat === "power" &&      // Vodka
  byCardId.get(30001).stat === "guts" &&       // Special Week
  byCardId.get(30004).stat === "stamina");     // Gold Ship
check("every card resolves a name", cards.supportCards.every((c: any) => !!c.name));
check("friend and group cards carry no facility",
  cards.supportCards.filter((c: any) => c.kind !== "stat").every((c: any) => c.stat === null));
check("charaName resolves on every card",
  cards.supportCards.every((c: any) => !!c.charaName),
  "text_data category 77 is keyed by CARD id, 6 by CHARA id -- using the wrong " +
  "one returns null silently on every card");

// --- group cards --------------------------------------------------------
//
// A group card is the awkward third case: no facility (so it can never show the
// rainbow glow) but a real friendship_bonus curve (so it is not inert either).
// Every assertion below is a fact read out of master.mdb, not a wiki claim.
const groups = cards.supportCards.filter((c: any) => c.kind === "group");
check("the two known group cards are present", 
  [30067, 30081].every((id) => byCardId.get(id)?.kind === "group"),
  `${groups.length} group cards total: ${groups.map((g: any) => g.name).join(", ")}`);
// A new group card is news, not a failure -- but it is news the model needs,
// since nothing here has been checked against a card that did not exist yet.
if (groups.length > 2) {
  const extra = groups.filter((g: any) => ![30067, 30081].includes(g.id));
  console.log(`  NOTE  ${extra.length} group card(s) added since this was written: ` +
    extra.map((g: any) => `${g.name} (${g.id}, ${g.groupMembers.length} members)`).join(", "));
  console.log("        the friendship-bonus and outing model has not been checked against them");
}
check("group cards carry a friendship bonus despite having no facility",
  groups.every((g: any) => g.stat === null && (g.effects.friendship_bonus?.["50"] ?? 0) > 0),
  groups.map((g: any) => `${g.charaName} ${g.effects.friendship_bonus?.["50"]}%`).join(", "));
check("friend cards carry NO friendship bonus",
  cards.supportCards.filter((c: any) => c.kind === "friend")
    .every((c: any) => (c.effects.friendship_bonus?.["50"] ?? 0) === 0),
  "this is what makes group != friend; if it ever fails, contributesFriendship() " +
  "needs revisiting");
check("every group card bundles members",
  groups.every((g: any) => g.groupMembers.length > 0),
  groups.map((g: any) => `${g.charaName} x${g.groupMembers.length}`).join(", "));
check("Heirs to the Throne is 3 members + a 2-step card chain = 5 outings",
  byCardId.get(30067).groupMembers.length === 3 &&
  byCardId.get(30067).outingMax === 2 &&
  byCardId.get(30067).totalOutings === 5);
check("Team Sirius is 6 members + a 1-step card chain = 7 outings",
  byCardId.get(30081).groupMembers.length === 6 &&
  byCardId.get(30081).outingMax === 1 &&
  byCardId.get(30081).totalOutings === 7,
  "more turn commitment than any friend card, which tops out at 5");
check("group members resolve names",
  groups.every((g: any) => g.groupMembers.every((m: any) => !!m.name)),
  byCardId.get(30067).groupMembers.map((m: any) => m.name).join(", "));
check("both group cards have a bond-80 unique effect",
  groups.every((g: any) =>
    g.uniqueEffect.some((u: any) =>
      u.bondThreshold?.some((b: any) => b.bondAtLeast === 80))),
  "Team Sirius: training_effectiveness +10; Heirs: skill_point_bonus +2");

// --- outing chains ------------------------------------------------------
const chains: any[] = (ds as any).outingChains;
check("every support card kind that can be a companion has a chain",
  chains.length === cards.supportCards.filter((c: any) =>
    c.kind === "group").length +
    new Set(cards.supportCards.filter((c: any) => c.kind === "friend")
      .map((c: any) => c.charaId)).size,
  `${chains.length} companions: ${chains.map((c) => `${c.name}:${c.totalOutings}`).join(" ")}`);
check("friend chain lengths are not uniform",
  new Set(chains.filter((c) => c.kind === "friend").map((c) => c.totalOutings)).size > 1,
  "Sasami Anshinzawa has 3 where the others have 5; assuming 5 over-books two turns");
check("group cards owe more outings than their chain length",
  chains.filter((c) => c.kind === "group")
    .every((c) => c.totalOutings > c.totalSteps),
  "the chain is not the schedule -- member outings dominate");
check("friendEvents stays the friend-only subset",
  (ds as any).friendEvents.length === 5 &&
  (ds as any).friendEvents.every((f: any) => f.kind === "friend"));

// --- scenario restrictions ----------------------------------------------
const restr = (ds as any).scenarioRestrictions;
check("Team Sirius is banned from Grand Concert",
  restr.rows.some((r: any) => r.cardId === 30081 && r.scenarioId === 3) &&
  restr.semantics === "banned_from",
  `verified in game ${restr.verifiedInGame} -- the card is absent from the ` +
  "Grand Concert support selection screen");
check("Grand Concert has exactly one usable group card",
  cards.supportCards.filter((c: any) =>
    c.kind === "group" && !c.restrictedScenarios.includes(3)).length === 1,
  "Heirs to the Throne; Team Sirius is banned, so its 15% friendship bonus and " +
  "7-outing bill never apply here");

// --- sparks / inspirations ----------------------------------------------
const sparks = JSON.parse(readFileSync(join(GEN, pick("sparks.")), "utf8"));
check("3 inspiration events", sparks.inspirationEvents.length === 3);
check("affinity has 3 ranks", sparks.affinityRanks.length === 3);
check("succession factors extracted", sparks.factors.length >= 1139,
  `${sparks.factors.length} factors`);

// --- per-run stat caps --------------------------------------------------
// Reproduces the scanned Legacy Select screen: legacy raised Stamina and Power.
const scanned = { stamina: 1366, power: 1316 };
const { caps, source } = effectiveStatCaps(ds.constants.statCaps, scanned);
check("scanned caps override the scenario base",
  source === "scanned" && caps.stamina === 1366 && caps.power === 1316 &&
  caps.speed === 1600 && caps.guts === 1500 && caps.wit === 1300);
// Errors specifically: a target above 1200 also draws a WARNING about race
// halving, which is not a legality question and must not be counted as one.
const errorsFor = (stamina: number, c: typeof caps) =>
  validateTarget({ ...target, stats: { ...target.stats, stamina } }, c, byId)
    .filter((p) => p.severity === "error");
check("a 1350 stamina target is legal under scanned caps but not the base",
  errorsFor(1350, caps).length === 0 &&
  errorsFor(1350, ds.constants.statCaps).length === 1);

const warnsFor = (stamina: number, c: typeof caps) =>
  validateTarget({ ...target, stats: { ...target.stats, stamina } }, c, byId)
    .filter((p) => p.severity === "warning");
check("a target above 1200 warns that the excess races at half value",
  warnsFor(1350, caps).length === 1 &&
  warnsFor(1350, caps)[0]!.message.includes("1275"),
  warnsFor(1350, caps)[0]?.message ?? "no warning");
check("a target at or below 1200 draws no halving warning",
  warnsFor(1200, caps).length === 0);
check("with no scan we fall back to the scenario base",
  effectiveStatCaps(ds.constants.statCaps, null).source === "scenario-base");

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
