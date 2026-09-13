# M3c layer 2 — reading the screen

**Status: offline reader, measured against the captured career. No capture loop
yet.** `getDisplayMedia` is layer 3 and only the player can test it.

`interaction-design.md` settles *why* this exists: a single frame carries the
run state, so per-turn advice costs zero interactions instead of five hovers.
This is the part that turns a frame into state.

## Where it runs

`packages/engine/src/vision/` takes an `RgbaImage` — structurally identical to
the browser's `ImageData`, so a caller passes one straight off a canvas with no
adapter and no copy. Nothing in the directory imports a DOM type or a Node
module. The Node harness feeds it raw RGBA converted from the screenshots,
which is exactly the byte layout a browser would hand it.

No OCR engine. The game's digits are a fixed face at four sizes that never
touch and never rotate; a general engine would be a large dependency solving a
much harder problem than the one present.

## How the templates exist without a font

The glyphs are cut from **the player's own capture** and labelled by the
numbers he had **already transcribed by hand** into
`examples/facility-levels-2026-09-05.jsonl`. Same principle as the master.mdb
extractor: nothing is scraped and no font is redistributed.

A glyph is accepted only when the segmenter finds exactly as many components as
the label has digits. A frame where they disagree is skipped rather than
aligned — teaching a wrong glyph is worse than missing one.

**The induction set is a greedy alphabet cover, not a prefix.** A prefix cannot
work here, for a reason that belongs to the data: the corpus is one career in
chronological order, so facility level 5 does not exist until turn 45. Inducing
from the first N frames leaves digits undefined however large N gets. Walking
the labelled frames in order and taking a frame only when it teaches an unseen
(style, digit) pair gives **16 induction frames and 59 held out**.

## What it reads, and how often it is right

Held out — the 59 labelled frames that taught no template:

| field | n | read | correct | **wrong** |
|---|---:|---:|---:|---:|
| skillPts | 26 | 100% | 100% | **0** |
| turnsLeft | 49 | 86% | 86% | **0** |
| chipLevel guts | 31 | 100% | 100% | **0** |
| chipLevel wit | 31 | 74% | 74% | **0** |
| concertIn | 38 | 74% | 74% | **0** |
| chipLevel power | 31 | 55% | 55% | **0** |
| chipLevel speed | 31 | 45% | 45% | **0** |
| chipLevel stamina | 31 | 35% | 35% | **0** |
| **total** | **268** | **72%** | **72%** | **0** |

End to end, over the whole corpus: **screen classification 75/75**, selected
facility 45% read and 0 wrong, facility levels 70% read and 0 wrong.

**The column that matters is the last one.** The two failure modes are not
comparable and the reader is tuned accordingly:

- a **refused** field costs one prompt, and the player can see it happened;
- a **wrong** field is a stat the planner believes, silently, for 72 turns.

So the accept thresholds are not set to maximise accuracy. `calibrate.ts`
sweeps both bars over the held-out reads and takes the loosest setting with
**zero** wrong answers — `maxDistance 0.10`, `maxMargin 0.45`. One notch looser
buys 3 points of read rate and 3 wrong answers, which is not a trade worth
making.

The remaining 28% is concentrated, not diffuse: it is mostly the bare vertical
bar the game draws for facility level **1**, whose normalised bitmap is thin
enough that the runner-up margin test refuses it. That is a known, named gap
with an obvious attack (a width feature, or an alphabet restricted to 1–5 for
chip fields), not a mystery.

## Three things the pixels forced

**Ink is distance from white, not luminance.** The turn counter is a purple
digit with a vertical gradient on a white card. Threshold it by luminance and
the dark bottom half is ink while the pale top bar is background — a "7"
segments as a lone diagonal and matches nothing. Distance from white does not
care that the purple got lighter.

**The chips need an adaptive cut.** Each chip prints its label in its own
facility colour on a fill of the same hue inside a white outline. Measured on
one chip: glyph core at white-distance 255, fill at 191, outline at 31. A
constant that separates those for Speed sits inside the gap for Wit. What is
constant is the *order* — the glyph is always the furthest thing from white in
its box — so the threshold is a fraction of the box's own maximum and the colour
drops out of the problem.

**The grade letter is removed by height, not by x.** Each stat cell prints a
grade ("C+", "E") beside the value in the same colour. It is taller: it spans
the value row and the cap row while the digits stop short. Cropping by x would
work until a stat reaches four digits and the value grows leftward into the
grade's column.

## Classification: three probes standing in for a word

| probe | training | everything else |
|---|---|---|
| `statRowLuma` | 195.3–200.9 | 113.8–248.7 |
| `headerStdDev` | 45.0–52.0 | 18.9–78.4 |
| `chipRowStdDev` | 51.6–58.5 | 9.2–65.8 |

All three together: **80/80 frames correct.**

`headerStdDev` is the one worth naming. The game blurs and dims everything
behind a modal, and a blur is a loss of local contrast: every dialog frame in
the corpus lands at 19–23 against training's 45–52. That is what stops a race
dialog being read as the turn underneath it.

**This is a stopgap and should be replaced rather than tuned.** The game already
writes the screen's name at the top left — "Training", "Race List", "Hype
Level". Reading that tab is ground truth; three scalars are inference. And one
band is thin: the Hype Level panel sits at `chipRowStdDev` 60.8 against a
training maximum of 58.5, so that edge carries the classification on 2.3 units.
`probeScreen` returns the margin so a caller can see it.

## Summer camp, again

During camp the game **hides every chip's level text** and prints "Lvl 5" on
the selected facility's banner regardless of the real level. This is the same
display mode that corrupted the hand transcription and had to be corrected in
`replay-validation.md` Part 3 — a recorded wit 4→5 that never happened.

So the reader never reads levels off the banner. When no chip prints a level it
returns `chipLevelsHidden: true` and no levels at all, and the caller is told
the information is unavailable rather than given five level-5 facilities on a
turn when stamina is level 1.

## Which facility is selected, without reading a word

The selected chip rides ~40px higher than the others and is set larger, so its
level digit is legible at the raised offset and absent at the resting one.
Trying both positions and seeing which yields a digit identifies the selection
using only machinery that already exists — no letter templates, and no colour
heuristic that a re-skin would break. Two raised chips is a contradiction and is
reported as no reading rather than as the first one found.

## Not done

- **Layer 3, the `getDisplayMedia` capture loop.** Only the player can test it.
- **Panel detection in an arbitrary frame.** In production the capture is the
  game window, so the frame *is* the panel and `panelFromFrame` handles that.
  The corpus is a 3840×1080 dual-monitor grab with the game in a fixed column,
  and the harness passes that crop explicitly rather than pretending to detect
  it.
- **Text.** The calendar string, the goal, the facility name on the banner, and
  the screen tab are all unread. Letters need letter templates, and the corpus
  labels numbers.
- **Energy and mood.** The energy bar is a fill fraction, not a number, and the
  mood pill is a colour — both easy, neither labelled in the transcription, so
  neither could be scored and neither was written.
- **The token column.** Positions are in `layout.ts`; the transcription carries
  no token counts, so there is nothing to validate against.

## One thing the frames said that the model does not know

Stat caps **rise during a run**. Frame 30 (Classic Late Jan) reads
1625/1332/1332/1500/1300; frame 43 (Classic Late Jul) reads
1630/1336/1337/1500/1300 — speed +5, stamina +4, power +5.

`scan-spec.md` records that caps are per-run rather than per-scenario, set by
legacy. It does not say they also move *within* a run, and `validateTarget` and
`statOutlook` both use a fixed number. Read off two frames, so it needs
confirming across the corpus before anything is built on it — the cap field is
not in the transcription, which is precisely the kind of gap this reader exists
to close.
