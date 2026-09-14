/**
 * What the support rail says, on every captured frame.
 *
 * There are no labels for this -- the hand transcription records facility
 * levels and stats, never who was standing on the facility -- so the yardstick
 * is the same one the stat caps got: read every frame, print it next to what a
 * human can check, and look at the ones that disagree with themselves.
 *
 * Two checks are available without labels and both are worth more than they
 * look. First, the deck is known: the captured career ran three Speed, two Wit
 * and one Friend card, so a frame reporting a fourth Speed card or any Stamina
 * card is wrong on its face. Second, a card is on exactly one facility per
 * turn, so the same frame can never show more badges than the deck has cards.
 *
 *   npx tsx tools/vision/support-probe.ts <panelDir>
 */
import { loadManifest, loadPanel, loadLabels } from "./corpus";
import { readSupportRail } from "../../packages/engine/src/vision/support";
import { calendarTurn } from "../../packages/engine/src/vision/turn";

const dir = process.argv[2] ?? "";
if (!dir) { console.error("usage: support-probe.ts <panelDir>"); process.exit(1); }

/** The captured career's deck, by type. From `examples/real-run.json`. */
const DECK: Record<string, number> = { speed: 3, wit: 2, friend: 1 };

const labels = loadLabels("examples/facility-levels-2026-09-05.jsonl");
const manifest = loadManifest(dir);
const frames = manifest.map((m) => m.frame).filter((f) => labels.get(f)?.selected).sort((a, b) => a - b);

const tally = new Map<string, number>();
let overDeck = 0, unknown = 0, empty = 0;

console.log(`\nsupport rail on ${frames.length} training frames\n`);
for (const f of frames) {
  const panel = loadPanel(dir, manifest.find((m) => m.frame === f)!);
  const slots = readSupportRail(panel);
  const kinds = slots.map((s) => s.kind ?? "?");
  for (const k of kinds) tally.set(k, (tally.get(k) ?? 0) + 1);
  if (slots.some((s) => s.unknownBadge)) unknown++;
  if (slots.length === 0) empty++;

  // A frame cannot show more cards of a type than the deck holds.
  const seen = new Map<string, number>();
  for (const k of kinds) seen.set(k, (seen.get(k) ?? 0) + 1);
  const over = [...seen].filter(([k, c]) => k !== "?" && c > (DECK[k] ?? 0));
  if (over.length) {
    overDeck++;
    console.log(`  OVER DECK f${f} (t${calendarTurn(labels.get(f)?.calendar ?? "") ?? "?"}) ` +
      `on ${labels.get(f)?.selected}: ${kinds.join(",")} — ${over.map(([k, c]) => `${c} ${k}`).join(", ")}`);
  }
}

console.log(`  badges seen: ${[...tally].map(([k, c]) => `${k} ${c}`).join("  ")}`);
console.log(`  frames with an unrecognised badge: ${unknown}`);
console.log(`  frames with no support card on the facility: ${empty}`);
console.log(`  frames claiming more of a type than the deck holds: ${overDeck}`);

// Per facility, what the rail says on average. A Speed facility should be
// showing Speed cards more often than a Wit facility does.
const byFacility = new Map<string, Map<string, number>>();
for (const f of frames) {
  const sel = labels.get(f)?.selected;
  if (!sel) continue;
  const panel = loadPanel(dir, manifest.find((m) => m.frame === f)!);
  const m = byFacility.get(sel) ?? new Map<string, number>();
  for (const s of readSupportRail(panel)) m.set(s.kind ?? "?", (m.get(s.kind ?? "?") ?? 0) + 1);
  byFacility.set(sel, m);
}
console.log(`\n  badges by the facility that was open:`);
for (const [fac, m] of [...byFacility].sort()) {
  console.log(`    ${fac.padEnd(8)} ${[...m].sort().map(([k, c]) => `${k} ${c}`).join("  ")}`);
}
