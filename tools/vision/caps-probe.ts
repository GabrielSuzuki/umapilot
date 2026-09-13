/**
 * Do the stat caps move during a run?
 *
 * `docs/scan-spec.md` established that caps are PER-RUN rather than
 * per-scenario -- legacy raises them, and the Legacy Select screen shows the
 * result. It did not say they also move WITHIN a run, and `validateTarget`,
 * `statOutlook` and the setup pane all assumed a fixed number.
 *
 * They move. Speed 1625 -> 1630 -> 1635, stamina 1332 -> 1336 -> 1342, power
 * 1332 -> 1337 -> 1343, wit 1300 -> 1300 -> 1304, guts 1500 throughout. Both
 * steps first READ at career turns 31 and 55, which are the screens after the
 * two INHERITANCE ("Inspiration") events on turns 30 and 54 -- Classic and
 * Senior Late March. The event activates the player's parents' and
 * grandparents' sparks and says so in the log: "Stamina cap went up by 10 ...
 * Power cap went up by 1." That is why guts never moves and the sizes are
 * neither flat nor a percentage.
 *
 * Two wrong answers died on the way, both recorded because the way they died is
 * the useful part. NOT the first turn of a new year, which is what this file
 * said first: those are turns 25 and 49, and the frames in between read the
 * earlier values -- the claim came from a calendar string nobody converted to a
 * number. NOT after each concert either (24, 36, 48, 60, 72): the cap row is
 * unchanged across every one, checked at turns 21-27, 34-39, 45-51 and 59-63,
 * and this reader resolves a 1-point change.
 *
 * HOW IT WAS FOUND WITHOUT LABELS, AND WITHOUT ARGUING IN A CIRCLE. There is no
 * cap column in the hand transcription, so there was nothing to induce cap
 * templates from. The bootstrap below starts from an anchor that comes from a
 * different screen read by a human -- the Legacy Select caps in
 * `examples/real-run.json` -- labels the first eight frames with it, and reads
 * the career with what that teaches.
 *
 * That is enough to prove movement and not enough to say what to. The anchor
 * only contains the digits 0,1,2,3,5,6, so the moment a cap changed to a value
 * containing a 4 or a 7 the read did not go wrong, it went BLANK -- and the
 * blanks were themselves the signal, arriving on exactly the frames where speed
 * stepped. Filling them in took a second template set (`bigDark`, the stat
 * values) to propose candidates, which reads the small cap digits badly but
 * never wrongly, and then the proposals were confirmed by eye at 6x before
 * being written into `examples/stat-caps-2026-09-05.json`. Two of the three
 * segments have an independent human witness: the player's own note on frame 59
 * records the crept-up caps, and frame 80's note has speed sitting at its 1635
 * cap with the training preview reading +0.
 *
 * WHAT THIS PRINTS NOW is the check rather than the discovery: the cap row read
 * on every frame with the shipped `capSmall` templates, against the segments
 * file. A disagreement means either the templates or the file is wrong, and
 * both are cheap to look at.
 *
 *   npx tsx tools/vision/caps-probe.ts <panelDir>
 */
import { loadManifest, loadPanel, loadLabels, loadCapSegments, applyCapSegments } from "./corpus";
import { readNumber } from "../../packages/engine/src/vision/segment";
import { calendarTurn } from "../../packages/engine/src/vision/turn";
import { capField, fieldGlyphs } from "../../packages/engine/src/vision/fields";
import { GLYPH_TEMPLATES } from "../../packages/engine/src/vision/glyphs";

const dir = process.argv[2] ?? "";
if (!dir) { console.error("usage: caps-probe.ts <panelDir>"); process.exit(1); }

const STATS = ["speed", "stamina", "power", "guts", "wit"] as const;
const T = GLYPH_TEMPLATES.get("capSmall") ?? [];
const segs = loadCapSegments("examples/stat-caps-2026-09-05.json");
const labels = loadLabels("examples/facility-levels-2026-09-05.jsonl");
applyCapSegments(labels, segs);

const manifest = loadManifest(dir);
const frames = manifest.map((m) => m.frame)
  .filter((f) => labels.get(f)?.selected)
  .sort((a, b) => a - b);

let read = 0, attempts = 0, disagree = 0;
let prev: Array<number | null> = [null, null, null, null, null];
console.log(`\ncap row on ${frames.length} training frames, read with the shipped capSmall templates\n`);
for (const f of frames) {
  const ref = manifest.find((m) => m.frame === f)!;
  const panel = loadPanel(dir, ref);
  const want = labels.get(f)!.caps!;
  const got = Array.from({ length: 5 }, (_, i) =>
    readNumber(fieldGlyphs(panel, capField(i)), T)?.value ?? null);
  for (let i = 0; i < 5; i++) {
    attempts++;
    if (got[i] === null) continue;
    read++;
    if (got[i] !== want[i]) {
      disagree++;
      console.log(`  DISAGREE f${f} ${STATS[i]}: read ${got[i]}, file says ${want[i]}`);
    }
  }
  const changed = got.some((v, i) => v !== null && prev[i] !== null && v !== prev[i]);
  if (changed || f === frames[0]) {
    // THE TURN NUMBER, not just the calendar string. Printing only the label is
    // how "Classic Early Apr" got written up as "the first turn of a new year"
    // -- which is turn 25, where this is turn 31.
    const cal = labels.get(f)?.calendar ?? "";
    const t = calendarTurn(cal);
    console.log(`  f${String(f).padStart(2)}  ${got.map((v) => (v === null ? "    ?" : String(v).padStart(5))).join(" ")}   ${t === null ? "  ?" : `t${String(t).padStart(2)}`}  ${cal}`);
  }
  got.forEach((v, i) => { if (v !== null) prev[i] = v; });
}

console.log(`\n  ${read}/${attempts} cap fields read (${((100 * read) / attempts).toFixed(0)}%), ${disagree} disagreements with the segments file`);
console.log(`  last seen: ${prev.map((v) => v ?? "?").join(" / ")}`);
console.log(`  segments:  ${segs.segments.map((s) => `f${s.fromFrame}+ ${s.caps.join("/")}`).join("   ")}`);
if (disagree > 0) process.exitCode = 1;
