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
**trainee alone, or a support card** — the venue is the game's choice, not the
player's.

Going with a companion advances an **event chain**, shown as chevrons ("Event
Progress"). There are two different structures behind those chevrons, and
conflating them was a real bug.

**Friend cards own one ordered chain**, keyed by chara id:

| friend | steps |
|---|---:|
| Tazuna Hayakawa | 5 |
| Aoi Kiryuin | 5 |
| Riko Kashimoto | 5 |
| Light Hello | 5 |
| **Sasami Anshinzawa** | **3** |

**They are not all the same length.** A planner that assumes five would over-book
two turns.

**Group cards are a bundle**, keyed by card id. `support_card_group` lists the
characters packed into the card, each with its own independent one-step outing,
*plus* the card owns a short chain of its own:

| group card | members | card chain | total outings |
|---|---:|---:|---:|
| [Esteemed and Adored] Heirs to the Throne | 3 | 2 | **5** |
| [Passing the Dream On] Team Sirius | 6 | 1 | **7** |

Team Sirius is the largest standing turn commitment of any companion in the
game — seven turns against Light Hello's five — and none of that is visible from
its chain length, which is 1. **The chain is not the schedule.**

Three independent tables agree on those counts, so the extractor asserts them
rather than trusting any one: `support_card_data.outing_max` (the card's own
chain), `support_card_group` (one row per member), and `single_mode_story_data`
(one progress row per outing). The first version of that check assumed every
"1 of 1" story row was a member outing, and died on Team Sirius — whose card
chain is *also* one step, and therefore indistinguishable from a member outing by
progress value. Only the total is checkable; the split is not.

This is a **deadline-constrained scheduling problem**, structurally identical to
the song unlock gates: the outings have to fit somewhere in 72 turns, and each
one displaces a training. Run every companion in the dataset and the bill is 35
turns — nearly half a career — so which companions to take is itself a planning
decision rather than a given.

**The two kinds fail differently, and a planner must not treat them alike.** A
friend chain is ordered and pays out at the end, so abandoning it part-way wastes
every turn already spent — a real cliff. A group card's member outings are
independent one-step events, so an unfinished group card has merely left value on
the table. `friendChainStatus()` reports that as `allOrNothing`, alongside
remaining outings against turns left and a `feasible` flag.

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

### Group cards are the awkward third kind, and the deck screen must know it

There are exactly two in the game, and they behave like neither of the other
kinds. Measured across all 235 cards in `master.mdb`:

| kind | `command_id` | carries `friendship_bonus` | in `support_card_group` |
|---|---|---:|---|
| stat | 101–106 | 223/223 | no |
| friend | 0 | **0/10** | no |
| group | 0 | **2/2** | **yes** |

A group card has **no facility specialty**, so it can never show the rainbow
glow — but it **does** carry a real friendship bonus (Heirs to the Throne 10 →
35%, Team Sirius 5 → 15%). The engine's friendship term used to test
`card.stat === facility`, which no group card can ever satisfy on any facility.
The card was extracted, stored, placed on a facility each turn, and then silently
ignored by the one term that made it worth playing. It failed as a slightly low
projection, which is the worst way for a model to be wrong.

So `isRainbow()` (does it glow?) and `contributesFriendship()` (does the
multiplier apply?) are now **different questions**, and `PlacedCard` carries an
explicit `kind` — because a friend card and a group card both have `stat: null`
and cannot be told apart any other way.

Both group cards also carry a **bond-80 unique effect** that the model previously
left as an undecoded blob. `support_card_unique_effect.type_0 = 101` is a
conditional wrapper — *at bond N, add M to effect T* — and the shape is consistent
across all 17 cards that use it. Team Sirius's is worth
`training_effectiveness +10`, larger than most of its base curve.

**Still unverified:** `master.mdb` stores a group card's friendship bonus but not
its *condition*. The model applies it at bond ≥ 80 on whichever facility the card
lands on, which is the reading that makes the extracted number mean anything — a
bonus with no facility that could ever satisfy it would be dead data. The
alternative (no bond gate at all) predicts a measurably different curve early in
a career. One logged run with a group card in the deck separates them, and the
projection says so in its `assumptions` until then.

### One open question worth a single in-game look

`single_mode_restrict_support` holds exactly two rows, both for **Team Sirius**,
against Unity Cup and **Grand Concert**. The schema does not say whether
"restrict" means *banned from* or *exclusive to*, and with one card in the table
there is no second example to disambiguate against. Both readings change a deck
recommendation, and getting it backwards would be worse than saying nothing.

The dataset therefore carries the rows with `semantics: "unknown"`, and
`restrictedCards()` surfaces the fact without deciding. **Open a Grand Concert
run and see whether Team Sirius is selectable** — that settles it in one look,
and is the only thing blocking this from being modelled properly.

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
