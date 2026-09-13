/**
 * Vision tests that do NOT need the capture.
 *
 * The 86 screenshots are the player's own and are not in the repo, so a suite
 * that needs them passes on one machine and fails in a fresh clone -- the same
 * trap `tools/diagnose/` being gitignored sets for the diagnostics. What CAN be
 * pinned here is everything that is a property of the code rather than of the
 * pixels: that the shipped templates are well-formed, that segmentation splits
 * where it should, that the reader refuses what it cannot read, and that the
 * layout scales.
 *
 * The accuracy numbers live in `docs/m3c-vision.md` and are reproduced by
 * `tools/vision/validate.ts` against the capture.
 */
import { GLYPH_W, GLYPH_H, segmentGlyphs, readNumber, matchGlyph, MAX_GLYPH_DISTANCE } from "../src/vision/segment";
import { GLYPH_TEMPLATES } from "../src/vision/glyphs";
import { inkMask, whiteDistance, fractionOfMaxThreshold, lumaStdDev, type RgbaImage } from "../src/vision/image";
import { probeScreen, findPanel } from "../src/vision/classify";
import { turnCandidates, resolveTurn, calendarFor, calendarTurn } from "../src/vision/turn";
import { readFrame } from "../src/vision/read";
import { scaleBox, statValueBox, REF_W, REF_H, STAT_CELL_X, isPanelShaped, cropImage } from "../src/vision/layout";
import { chipLevelField, capField, fieldGlyphs } from "../src/vision/fields";

let failed = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`  ${ok ? "ok " : "FAIL"}  ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed++;
}

/** A flat image of one colour, for the probes that must not fire on one. */
function solid(w: number, h: number, r: number, g: number, b: number): RgbaImage {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) { data[i * 4] = r; data[i * 4 + 1] = g; data[i * 4 + 2] = b; data[i * 4 + 3] = 255; }
  return { width: w, height: h, data };
}

console.log("\nvision: templates");
{
  const styles = [...GLYPH_TEMPLATES.keys()];
  check("templates ship for every field style",
    styles.includes("bigDark") && styles.includes("bigLight") &&
    styles.includes("smallChip") && styles.includes("bigChip"),
    styles.join(", "));

  let badCells = 0, total = 0;
  for (const list of GLYPH_TEMPLATES.values()) {
    for (const t of list) { total++; if (t.cells.length !== GLYPH_W * GLYPH_H) badCells++; }
  }
  check("every template is the right size", badCells === 0, `${total} templates, ${GLYPH_W}x${GLYPH_H}`);

  const big = GLYPH_TEMPLATES.get("bigDark") ?? [];
  check("the big-digit set covers 0-9",
    "0123456789".split("").every((d) => big.some((t) => t.label === d)),
    big.map((t) => t.label).sort().join(""));

  // Facility levels are 1..5 by the level rule, so a "0" or "7" template here
  // would mean the induction mislabelled something.
  const chip = GLYPH_TEMPLATES.get("smallChip") ?? [];
  check("the chip set covers exactly the levels that exist, 1-5",
    chip.map((t) => t.label).sort().join("") === "12345",
    chip.map((t) => t.label).sort().join(""));

  // Every template must be closer to itself than to any other, or the set
  // cannot separate the alphabet it was built for and no threshold saves it.
  let confusable = "";
  for (const [style, list] of GLYPH_TEMPLATES) {
    for (const t of list) {
      const m = matchGlyph(t.cells, list);
      if (!m || m.label !== t.label) confusable += ` ${style}:${t.label}->${m?.label}`;
    }
  }
  check("no template is closer to a different digit than to itself", confusable === "", confusable || "all distinct");
}

console.log("\nvision: ink and thresholds");
{
  check("white is zero distance from white", whiteDistance(255, 255, 255) === 0);
  check("a saturated colour is far from white even when it is bright",
    whiteDistance(0, 64, 192) === 255,
    "the turn counter's purple is light at the top and dark at the bottom; " +
    "luminance thresholding splits the glyph, this does not");

  const img = solid(20, 10, 255, 255, 255);
  img.data[(5 * 20 + 5) * 4] = 0; img.data[(5 * 20 + 5) * 4 + 1] = 0; img.data[(5 * 20 + 5) * 4 + 2] = 0;
  const m = inkMask(img, { x0: 0, y0: 0, x1: 20, y1: 10 }, "dark", 60);
  check("dark polarity inks the dark pixel and nothing else",
    m.bits.reduce((a, b) => a + b, 0) === 1 && m.bits[5 * 20 + 5] === 1);

  check("an adaptive threshold follows the box it is given",
    fractionOfMaxThreshold(img, { x0: 0, y0: 0, x1: 20, y1: 10 }, 0.9) === 255 * 0.9,
    "the chips print each facility's label in that facility's own colour, so " +
    "no constant separates glyph from fill for all five");
}

console.log("\nvision: segmentation");
{
  // Two bars separated by a blank column, then a taller bar that reaches the
  // bottom -- the shape of a stat cell's "grade letter beside the digits".
  const w = 14, h = 10;
  const bits = new Uint8Array(w * h);
  const set = (x: number, y: number) => { bits[y * w + x] = 1; };
  for (let y = 1; y < 6; y++) { set(1, y); set(2, y); }
  for (let y = 1; y < 6; y++) { set(5, y); set(6, y); }
  for (let y = 1; y < 10; y++) { set(10, y); set(11, y); }
  const mask = { width: w, height: h, bits };

  check("column gaps split glyphs", segmentGlyphs(mask, {}).length === 3);
  check("a component reaching the drop row is discarded",
    segmentGlyphs(mask, { dropIfReachesRow: 8 }).length === 2,
    "this is how the grade letter is removed without cropping by x, which " +
    "would fail the moment a stat reaches four digits");
  check("a height floor discards specks",
    segmentGlyphs(mask, { minHeight: 8 }).length === 1);
}

console.log("\nvision: the reader refuses rather than guesses");
{
  const blank = { width: 10, height: 10, bits: new Uint8Array(100) };
  check("an empty box reads as nothing, not as zero",
    readNumber(segmentGlyphs(blank, {}), GLYPH_TEMPLATES.get("bigDark") ?? []) === null);

  // A glyph that matches nothing must refuse the WHOLE field, not contribute a
  // best guess: a number with one invented digit is worse than no number.
  const noise = new Float32Array(GLYPH_W * GLYPH_H).fill(0.5);
  const m = matchGlyph(noise, GLYPH_TEMPLATES.get("bigDark") ?? []);
  check("flat noise is not within the accept distance of any digit",
    !!m && m.distance > MAX_GLYPH_DISTANCE, m ? `nearest "${m.label}" at ${m.distance.toFixed(3)}` : "no match");
}

console.log("\nvision: classification and layout");
{
  const flat = solid(REF_W, REF_H, 128, 128, 128);
  const p = probeScreen(flat);
  check("a flat image is not a training screen", p.kind === "notTraining",
    `statRowLuma ${p.statRowLuma.toFixed(0)}, headerStdDev ${p.headerStdDev.toFixed(1)}`);
  check("a flat image has no local contrast anywhere",
    lumaStdDev(flat, { x0: 0, y0: 0, x1: 100, y1: 100 }) < 1e-9);

  const r = readFrame(flat);
  check("a non-training frame yields no state at all",
    r.turnsLeft === undefined && Object.keys(r.stats).length === 0 &&
    Object.keys(r.facilityLevels).length === 0 && r.selected === undefined);

  const b = scaleBox({ x0: 100, y0: 200, x1: 200, y1: 400 }, REF_W * 2, REF_H * 2);
  check("boxes scale with the panel, so a bigger capture reads the same",
    b.x0 === 200 && b.y1 === 800);

  // The stat value box must start past the grade letter and stop inside the
  // cell, or it reads its neighbour's digits.
  let contained = true;
  for (let i = 0; i < 5; i++) {
    const v = statValueBox(i), cell = STAT_CELL_X[i]!;
    if (v.x0 <= cell[0] || v.x1 > cell[1]) contained = false;
  }
  check("every stat value box sits inside its own cell", contained);

  check("the selected chip's level box sits higher than the resting one",
    chipLevelField(0, true).box.y0 < chipLevelField(0, false).box.y0,
    "the selected chip rides ~40px up; trying both offsets is how the reader " +
    "identifies WHICH facility is selected without reading a word");
}

console.log("\nvision: which turn is this");
{
  // The reader cannot read the calendar, so the career turn comes from the
  // concert countdown. This is the arithmetic the whole live advice rests on:
  // get it wrong and the planner is confidently solving a different problem.
  check("a countdown names every turn it could be, not one of them",
    turnCandidates(2).join() === "22,34,46,58,70",
    "the concerts are evenly spaced, so nothing on the screen separates these");

  check("a countdown of 0 is a concert turn",
    turnCandidates(0).join() === "24,36,48,60,72");

  check("a known position resolves the ambiguity",
    resolveTurn(2, 30) === 34 && resolveTurn(2, 20) === 22 && resolveTurn(2, 34) === 34);

  check("with no prior, an ambiguous countdown resolves to nothing",
    resolveTurn(2, null) === null,
    "returned rather than guessed -- the caller asks the player once");

  // The rule that "nearest" gets wrong: from 50 the candidates are 46 and 58,
  // and 46 is closer. Picking it would drag a running career back twelve turns.
  check("a career is never rewound, even to a nearer candidate",
    resolveTurn(2, 50) === 58 && resolveTurn(2, 40) === 46,
    "from 50 the nearest candidate is 46 and the right answer is 58");

  check("an impossible countdown resolves to nothing at all",
    turnCandidates(99).length === 0 && resolveTurn(99, 30) === null,
    "no concert sits 99 turns from any turn in a 72-turn career");

  // The slack is deliberate and is one turn, not more: a known value can lag a
  // frame behind without the resolution refusing to move.
  check("the one-turn slack lets a stale known value still resolve",
    resolveTurn(2, 35) === 34);

  // The label is what a player recognises. Turn 34 is the frame that exposed
  // the bug: the planner was told turn 1 and believed 71 turns remained.
  check("a turn maps to the calendar the game prints",
    calendarFor(34) === "Classic Late May" &&
    calendarFor(1) === "Junior Early Jan" &&
    calendarFor(72) === "Senior Late Dec",
    `${calendarFor(1)} … ${calendarFor(34)} … ${calendarFor(72)}`);

  check("the calendar and the countdown agree on the real frame",
    turnCandidates(2).includes(34) && calendarFor(34) === "Classic Late May");

  // The round trip is the point: a label read off the screen has to come back
  // as the same turn, or a finding gets written up against the wrong one. The
  // stat caps move at turns 31 and 55, and were reported as moving on "the
  // first turn of a new year", which is 25 and 49.
  let roundTrip = true;
  for (let t = 1; t <= 72; t++) if (calendarTurn(calendarFor(t)) !== t) roundTrip = false;
  check("every turn survives the trip through its calendar label", roundTrip);

  check("the game's own spelling parses, not just ours",
    calendarTurn("Classic Year Early Apr") === 31 &&
    calendarTurn("Senior Year Early Apr") === 55 &&
    calendarTurn("Classic Year Early Jan") === 25,
    "the game prints \"Year\"; calendarFor does not");

  check("a label with no date in it returns nothing, not a guess",
    calendarTurn("Junior Year Pre-Debut") === null,
    "the pre-debut frames are anchored separately -- and a caller that treats " +
    "this as \"no calendar field\" is how a diagnostic measured 45 turns as 55");
}

console.log("\nvision: finding the panel in a bigger capture");
{
  check("a panel-shaped image is recognised without searching",
    isPanelShaped(solid(REF_W, REF_H, 1, 2, 3)) &&
    isPanelShaped(solid(REF_W * 2, REF_H * 2, 1, 2, 3)) &&
    !isPanelShaped(solid(3840, 1080, 1, 2, 3)),
    "getDisplayMedia captures the game WINDOW, so in production the frame is " +
    "the panel; a PrtScn of the desktop is the case that needs searching");

  const wide = solid(60, 20, 10, 20, 30);
  for (let y = 0; y < 20; y++) {
    for (let x = 30; x < 40; x++) {
      const i = (y * 60 + x) * 4;
      wide.data[i] = 200; wide.data[i + 1] = 210; wide.data[i + 2] = 220;
    }
  }
  const c = cropImage(wide, { x0: 30, y0: 0, x1: 40, y1: 20 });
  check("cropping takes the box and nothing else",
    c.width === 10 && c.height === 20 && c.data[0] === 200 && c.data[2] === 220);

  const exact = findPanel(solid(REF_W, REF_H, 128, 128, 128));
  check("a panel-shaped frame is returned whole, unsearched",
    !!exact && exact.exact && exact.box.x0 === 0 && exact.box.x1 === REF_W);

  check("a frame with no training screen in it is refused, not approximated",
    findPanel(solid(3840, 1080, 128, 128, 128)) === null,
    "the panel is located by the shape of the training screen, so a menu or a " +
    "race dialog has no good offset -- and the least-bad one is worse than none");
}

console.log("\nvision: the cap row");
{
  // The "/" is dropped by POSITION, not by cropping it out of the box: it is
  // always the leftmost component and the box has to stay wide enough for a
  // four-digit cap on a smaller panel.
  const spec = capField(0);
  check("the cap field drops exactly one leading component",
    spec.dropLeading === 1 && spec.style === "capSmall",
    "the slash would otherwise be matched as a digit");

  check("the cap row has its own templates, not the stat values'",
    (GLYPH_TEMPLATES.get("capSmall") ?? []).length > 0 &&
    GLYPH_TEMPLATES.get("capSmall") !== GLYPH_TEMPLATES.get("bigDark"),
    "cap digits are drawn at about half the height of the value digits; matched " +
    "against bigDark they read 16 of 40 known caps, against their own 273 of 290");

  // 8 and 9 never appear in a cap in the captured career, so they have no
  // template and a cap containing one is REFUSED. Pinned because the failure
  // mode that matters is a wrong cap, not a missing one -- and a missing one
  // leaves the player's typed value standing.
  const capDigits = (GLYPH_TEMPLATES.get("capSmall") ?? []).map((t) => t.label).sort().join("");
  check("the cap templates cover only the digits the capture contained",
    capDigits === "01234567",
    `capSmall knows ${capDigits}; a cap with an 8 or 9 in it reads as nothing rather than as something else`);

  check("a blank cap box reads nothing",
    readNumber(fieldGlyphs(solid(REF_W, REF_H, 250, 250, 250), capField(2)),
      GLYPH_TEMPLATES.get("capSmall") ?? []) === null);
}

console.log(failed === 0 ? "\nvision: all checks passed" : `\nvision: ${failed} FAILED`);
if (failed > 0) process.exit(1);
