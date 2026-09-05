# Per-turn advice: the interaction design

**Decision (2026-09-05): per-turn advice is a primary feature, and it is delivered
by continuous passive screen capture in the browser — not by asking the player to
hover every facility, and not by making them paste a screenshot each turn.**

## The question

Every turn the player faces five facilities. Does the app read each one by having
the player hover them in turn, then produce a recommendation?

## The constraint that shapes everything

Measured against real captures: the five facility chips show **only** the
facility's level and its performance-token type. The predicted gains, the failure
percentage, and the support cards sitting on a facility are visible **only for
the facility currently selected**.

So a single frame never contains all five options.

## Why "hover all five" is the wrong answer

It inverts what the tool is for.

If the player hovers each facility, the game has already shown them every gain
number. The tool would be reading those numbers back to them — an expensive
transcription device. The entire point of calibrating the formula in M2 was that
the engine can now predict all five from one observation of state. If a hover is
still required to fetch the numbers, that work bought nothing.

It is also five interactions per turn across 72 turns. That is a ritual, and
rituals get abandoned.

**And the per-turn facility choice is the least valuable thing this tool does.**
The screen already says `+29 Speed`. What it can never say:

- Training Wit this turn, to push a card to bond 80, is worth more than +29 Speed
  across the remaining 40 turns.
- Which song to buy, and that buying it now rather than after the next concert is
  worth roughly 3x more.
- Whether the target build is still reachable, and at what probability.

None of those need a hover. They need run state, which one frame gives.

## What makes it smooth: `getDisplayMedia`

A web page can capture a screen or a single window, with one permission grant,
using `navigator.mediaDevices.getDisplayMedia()`. Frames are processed locally in
the page — nothing is uploaded, nothing is installed.

That collapses the per-turn cost to **zero interactions**:

1. Once per session, the player picks the game window in the browser's share
   dialog.
2. The page samples frames at ~2 fps and only does work when the frame changes.
3. It classifies the screen (training / event / race / lobby) and reads the
   always-visible state.
4. Advice is on screen before the player has finished reading the turn.

This preserves the web-only decision intact. No desktop app, no install, no
process attached to the game.

### Passive hover harvesting

The placement problem solves itself under continuous capture. Players already
move between facilities while deciding. Each glance the player makes anyway is a
free exact reading of that facility, accumulated across the turn.

So the design is **progressive, never blocking**:

- **Immediately**, from one frame: all five ranked, using the engine's prediction
  for the facilities not currently selected.
- **As the player browses**: predicted values are replaced by observed ones, and
  the ranking sharpens.
- **Only when it matters**: if the top two options are within noise *and* one of
  them is unobserved, the app says "hover Guts to be sure". On most turns it will
  not need to ask at all.

The tool never demands a fixed sequence. It uses whatever the player happened to
look at.

### Why prediction-first is safe here

Because the formula was validated in M2 against real data — exact on an observed
training, and bracketing the real run's average in the ideal state. Predicting an
unhovered facility is not guesswork; it is the same arithmetic the game runs,
with the state read off the frame. The UI should still mark predicted values
distinctly from observed ones, because the honest thing is to show which is
which.

## The layout this assumes

The player has two monitors: game on one, tool on the other. That is already how
the reference captures were taken, and it makes a persistent advice panel free —
no alt-tabbing, no overlay, no window management.

## Fallbacks, in order

1. **Continuous capture** (above) — the default.
2. **Paste a screenshot.** Browsers fire a `paste` event carrying image data, so
   `PrintScreen` then `Ctrl+V` into the page works with no file dialog. Two
   keypresses. This is the fallback when screen capture is declined or
   unavailable, and it is also the natural fit for "I only want advice on the
   turns I'm unsure about".
3. **Manual entry.** Always available, never the expected path.

## Known risks

- **Fullscreen-exclusive rendering** may not be capturable. Windowed or
  borderless-windowed will be.
- **The browser's persistent "sharing" indicator** is mildly intrusive and cannot
  be suppressed. Worth telling the user up front rather than surprising them.
- **Permission does not survive a page reload**, so a refresh costs one click.
- **Battery and CPU** on a laptop — hence sampling at ~2 fps with change
  detection rather than every frame.
- **Reading accuracy.** Digits sit in fixed boxes, so template matching is cheap
  and fast; but a misread must be visible, not silent. Every reading carries a
  confidence, and a low-confidence field is shown as unknown rather than guessed.

## What this rules out, and when to revisit

This deliberately does **not** build a desktop overlay. The right time to
reconsider is if continuous browser capture proves unreliable in practice — for
example if the game turns out to render in a way that cannot be captured — not
because an overlay sounds more capable. The measurement to make first is whether
the web version actually gets used every turn.
