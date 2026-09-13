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

**Measured by 5-fold cross-validation**, not by a held-out split. The split was
tried first and could not be made to work: the digits are badly imbalanced —
chip level 1 appears 96 times in the corpus and level 3 eight times — so a test
set large enough to mean anything leaves the rare digits one or two training
samples, and a template averaged from one sighting is a template of one frame's
anti-aliasing. Measured: chip level 3 had a single sample and read **13%**.
Chasing ten samples each instead consumed 69 of 75 frames and left six to test
on. Neither is a measurement.

k-fold dissolves the choice — every frame is tested by templates that never saw
it, and every template is built from all samples but one fold's. Folds are
interleaved by frame order rather than contiguous, because the corpus is one
career in sequence and contiguous blocks would test early-career templates on
late-career glyphs.

| field | n | read | correct | **wrong** |
|---|---:|---:|---:|---:|
| skillPts | 28 | 100% | 100% | **0** |
| concertIn | 54 | 89% | 89% | **0** |
| turnsLeft | 69 | 88% | 88% | **0** |
| chipLevel | 250 | 70% | 69% | **1** |
| **total** | **401** | **78%** | **77%** | **1** |

**That 1 is a correction.** An earlier single-split run reported zero wrong, and
zero was the wrong number — the split was small enough to miss it. The misread
is frame 51: a speed level 3 read as a 2, with the surrounding frames and the
transcription both saying 3.

Cross-validation also found a bug an average had hidden. `turnsLeft` sat at 74%
and looked like ordinary noise; broken down per GLYPH, the values 10, 11 and 12
read **zero** — 11 of 69 cases. The box had been fitted to a single digit, so a
two-digit counter had its leading 1 clipped and its trailing 0 truncated.
Widening it took the field to 88%.

### End to end, through `readFrame`

| | result |
|---|---|
| screen classification | **75 / 75** |
| selected facility | **58 / 58**, 0 wrong |
| facility levels | 145 / 192 attempted (76%), **0 wrong** |

The two tables disagree about `chipLevel` on purpose. The first measures the
glyph reader asked to read every chip. The second measures the assembled reader,
which **declines to read the selected chip's level at all** — see below. The
field reader still misreads a sparkled digit; the assembled reader does not ask
it to.

**The column that matters is the last one.** The two failure modes are not
comparable and the reader is tuned accordingly:

- a **refused** field costs one prompt, and the player can see it happened;
- a **wrong** field is a stat the planner believes, silently, for 72 turns.

So the accept thresholds are not set to maximise accuracy. `calibrate.ts`
sweeps both bars and takes the loosest setting with zero wrong answers —
`maxDistance 0.10`, `maxMargin 0.45`.

## Two things the sparkle decided

The game paints an animated sparkle over the **selected** chip. It is near-white,
so it does not obscure a digit so much as punch holes in it — and a holed glyph
does not fail loudly, it matches a different digit. This is not a weakness of
template matching: the same overlay made a human transcribing these screenshots
by hand record a 3 as a 5, which had to be corrected in `replay-validation.md`
Part 3.

**Selection is read from the chevrons, not the digit.** The first approach read
the selected chip's level at its raised offset and inferred the selection from
which chip answered — 45%, because the sparkle sits exactly there. The yellow
chevron stack beneath the selected chip has no such problem: large, saturated,
fixed position, present under exactly one chip, nothing else on screen like it.
**58 of 58**, including summer-camp turns where the chips hide their levels
entirely and the digit approach could not have worked at all.

Its gates were guesses and one was wrong. Requiring the winner to beat the
runner-up by 2× cost 7 of 58 reads and prevented nothing — two chips can sit at
a ratio of 1.03 and plain argmax still picks correctly. The floor earns its
place: the weakest true chevron score is 0.31, so 0.05 is fifteen times clear
and still refuses a frame with no chevrons.

**The selected chip's level is not read.** That one position is where the
sparkle lives and where the only misread came from. Refusing it takes end-to-end
misreads to zero, and it is cheap now that the chevrons identify the chip
exactly — the other four are still read. The lesson generalises past this
module: the digit was the obvious signal because it was the one already being
read, not because it was the best one.

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

## Finding the panel in a desktop screenshot

`x = 2068` was hardcoded in every tool written against these images. It had to
stop being hardcoded, because the file a player drops on the page is a PrtScn
of whatever their desktop looked like.

The game letterboxes rather than reflowing, so the panel's aspect is fixed and
the only unknown is where it starts. Two stages, because neither works alone:

**The probes cannot localise.** `statRowLuma` and friends are aggregate
statistics over large boxes, so sliding the window 30px barely moves them.
Scored alone they land 15 to 250 pixels off, and every field read then fails
against a layout that is almost right.

**The stat row can.** It is a bright panel with hard outer borders and four
dashed cell dividers at known spacing — seven edges at fixed offsets. Correlating
that comb against the image's column-wise edge energy gives a peak one pixel
wide: **16778 at the true offset against 6413 eight pixels away.**

**But the comb discriminates badly.** On one frame its runner-up sits 287px from
the truth at 96% of the score, and a fine pass anchored to a single coarse guess
follows that guess off a cliff — which is exactly what happened on frame 30. So
the coarse pass keeps five separated minima, the comb refines each, and the
probes choose between the refined offsets.

On 12 full 3840×1080 frames: **9 of 9 training frames located** (7 exact, 2 at
−1px, all reading fields correctly), and 2 of 3 non-training frames correctly
refused, in ~350ms each.

The third is the thin band again. The Hype Level panel is accepted at an offset
188px off, because at that crop its probes land inside the training bands. It
then reads no fields at all, so it surfaces as "found the game, could not read
anything" rather than as wrong state — but it is the same 2.3-unit margin, and
reading the screen-name tab would close it.

There is a limit worth stating rather than discovering: the probes describe a
*training* screen, so this finds the panel only in a frame that contains one.
A screenshot of a race dialog has no good offset and the search returns null.
That is right for the drop-a-screenshot flow, where a training screen is the
only thing worth reading — but it is not a general window finder.

## Drop a screenshot (`packages/web/src/scan.ts`)

Drop a PrtScn on the page: it finds the panel, classifies, reads what it can,
and fills the fields in. No permission prompt, no capture loop, nothing
uploaded — `createImageBitmap` into an `OffscreenCanvas` hands the reader the
same `ImageData` a capture loop would, and the file never leaves the page.

**What it refuses is the feature.** A scan is not "here is your state"; it is
"here is what I could actually see". Refused fields are left exactly as they
were and listed by name, because a field left alone looks identical to a field
confirmed unless something says otherwise.

Two things it deliberately does not do:

- **`turnsLeft` is not written to `turn`.** The screen counts turns until the
  next goal, not turns elapsed in the career. They look alike and are different
  numbers, and writing one into the other is precisely the silent plausible
  wrong answer the refusals exist to prevent.
- **Facility levels are read but not applied.** They belong to the run setup,
  not to this turn. They are shown so the player can see they were read.

## Not done

- **Layer 3, the `getDisplayMedia` capture loop.** Only the player can test it.
  The drop path exists partly to de-risk it: a reader bug found here is not
  tangled up with a capture bug.
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
