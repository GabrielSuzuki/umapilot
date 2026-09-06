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

## The recommendation covers every action, not just the five facilities

Rest, Recreation and optional races are ranked alongside training. They have to
be — a turn spent resting is a turn not spent training, and that trade is exactly
where players lose runs.

### Why they cannot be scored the way training is

A training yields stats now. A rest yields **zero** stats. Any per-turn
"expected stats this turn" comparison therefore ranks every training above every
rest, always. That answer is not slightly off; it is structurally wrong, and no
amount of weight-tuning fixes it.

The correct framing is that **energy and mood are resources with shadow prices**:

- **Rest** converts a turn into energy. Energy converts into future trainings.
  Its value is `energy gained x marginal value of energy - value of the training
  forgone`. The marginal value of energy comes out of the forward search: how
  many more good trainings does this energy actually buy before turn 72?
- **Recreation** converts a turn into mood, and mood is a *multiplier on every
  remaining training*. So its value scales with turns remaining — worth far more
  in Junior year than in Senior. Same time-value structure as buying a song
  early, and for the same reason.
- **An optional race** buys fans, skill points and a stat bump, and spends energy
  and a turn. Its value depends on whether fan requirements are actually binding
  — which only the forward plan knows.

All three are priced by the same mechanism that prices performance tokens. That
consistency is not a coincidence: it is what a lookahead search gives you for
free, and it is the strongest argument for making the recommender a search rather
than a scoring heuristic.

**This is the load-bearing reason M3 is a beam search and not a formula.**

### Recreation is a choice of companion, not of venue

An earlier draft of this document had it wrong. The Recreation screen offers the
**trainee alone or a friend support card** — the venue is the game's choice, not
the player's.

Going with a friend advances that card's **event chain**, shown as chevrons
("Event Progress"). Every friend in `master.mdb` has one:

| friend | steps |
|---|---:|
| Tazuna Hayakawa | 5 |
| Aoi Kiryuin | 5 |
| Riko Kashimoto | 5 |
| Light Hello | 5 |
| **Sasami Anshinzawa** | **3** |

**They are not all the same length.** A planner that assumes five would over-book
two turns on a Sasami run.

This is a **deadline-constrained scheduling problem**, structurally identical to
the song unlock gates: five outings must fit somewhere in 72 turns, each one
displaces a training, and the payoff only lands when the chain completes. It is
precisely the case a myopic recommender gets wrong — a single friend outing looks
like a wasted turn right up until the chain pays out.

So the engine tracks progress per friend and exposes `friendChainStatus()`,
which reports remaining steps against turns left and flags a chain that has
become infeasible. A planner has to *reserve* those turns, not discover at turn
68 that it owes four outings it can no longer afford.

The venue still matters for the immediate payoff, and `master.mdb` names them:

| destination | energy | mood |
|---|---:|---:|
| Karaoke | — | +2 |
| Riverside | +10 | +1 |
| Shrine | +30 / +20 / +10 | +1 |
| Beach | +40 | +1 |

Per-step chain **rewards** are not in `master.mdb` — like all event outcomes they
live in the story assets (see `events.md`). The structure is extracted, which is
what the scheduler needs; the payouts are flagged as unmodelled.

### What is still missing for races

Race rewards are not yet extracted. Until they are, a race recommendation would
be guesswork, so the engine exposes the action but flags it. The tables to mine
are `single_mode_race_group`, `single_mode_route_race` and the race program data.

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
