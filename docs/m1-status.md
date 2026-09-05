# M1 status

The forward simulator exists, is pure, is reproducible from a seed, and is
**not yet accurate**. This document says exactly how inaccurate and why, because
a simulator whose error is undocumented is worse than one with a known error bar.

## What works

- `GrandConcertScenario` implements the `Scenario` interface end to end: 72
  turns, five concerts, token economy, lesson shop, bonds, facility levels.
- `step` and `buy` are pure functions of `(state, action, rng)`. No module
  state, no `Math.random`, no clock.
- Base training values for facility levels 1 and 5 come from `master.mdb`.
- Stat caps are **derived** from the database, not hardcoded.
- 33 tests pass: property tests for purity, determinism and bounds, plus a
  golden-file career regression.
- The CLI runs headless: `npx tsx packages/engine/src/cli.ts --runs 200 < examples/run.json`.

## The measured gap

With six SSR cards and a reasonable policy over a full career, the simulator
projects roughly:

| stat | projected median | a real optimised run |
|---|---:|---:|
| speed | ~484 | 1000+ |
| stamina | ~342 | 700+ |
| power | ~390 | 800+ |

**The model is roughly 2-3x low.** That is a large, systematic underestimate, and
it is stated plainly here rather than hidden behind a plausible-looking number.

## First: the "3.1x gap" conflated two different errors

That figure came from comparing a *simulated* career against a *real logged*
one. Two things differ between those, not one:

- **Model error** — the formula disagrees with the game about what a given
  training yields. Measured by comparing a prediction against the number the
  training screen displays for the same state.
- **Policy error** — the simulated player makes worse choices than a real one.

A naive policy under-performs a skilled player even with a perfect model, so the
endpoint comparison was never a clean measurement of the formula. Separating them
changed the conclusion.

**Measured, same model, same seeds, 120 runs:**

| policy | total |
|---|---:|
| naive (train the lowest stat, rest when tired) | 1,440 |
| competent (failure threshold, Wit for energy, build bonds first) | 1,707 |
| real logged run | 5,149 |

Policy is worth ~19%. It is **not** where the gap lives.

## The formula itself is close to right

Checked against a real observation — screenshot 09, Power facility Lvl 1, three
cards, no rainbow, which the game displayed as **+6 Stamina, +15 Power**:

```
Kitasan Black + Maruzensky + Fine Motion  ->  stamina +5, power +15
```

Power exact, Stamina one low. A one-point residual on the smaller term is
consistent with a growth-rate term whose value we do not have; it is not a broken
multiplier chain. The base values from `master.mdb` and the verified card effects
reproduce the game's own number.

## Where the gap actually is — calibrated against a real run

### The formula is correct. Two independent confirmations.

**Against a single observed training.** Screenshot 09 — Power facility Lvl 1,
three cards, no rainbow — displayed `+6 Stamina, +15 Power`. The model with
Kitasan Black + Maruzensky + Fine Motion predicts `stamina +5, power +15`. Power
exact; one low on the smaller term, consistent with an unknown growth rate.

**In the ideal state.** Speed facility, level 5, four cards all at rainbow, great
mood, all song bonuses:

| state | speed | power | total |
|---|---:|---:|---:|
| Lvl 1, 1 card, normal mood, no songs | +11 | +6 | 17 |
| Lvl 5, 3 rainbow cards, normal mood | +34 | +19 | 53 |
| Lvl 5, 3 rainbow, great mood | +45 | +26 | 71 |
| Lvl 5, 3 rainbow + friend, great mood | +51 | +29 | 80 |
| **Lvl 5, 3 rainbow + friend, great mood, all songs** | **+63** | **+40** | **103** |

The real logged run averaged **~82–95 stat per training** across the career. The
model brackets it. **The multiplier chain is not the problem.**

### The gap is state occupancy, not arithmetic

The simulated player almost never reaches the state where those numbers happen:

| | simulated | real run |
|---|---|---|
| trainings with a rainbow card | 38% | near-continuous on the focused facilities |
| mood | rarely great | managed to great |
| facility levels reached | Speed 4, Wit 5, rest 1 | Speed 5, Wit 5, rest 1 |
| songs learned | few, late | 19 of 23 |
| average gain per training | ~20 | ~82 |

Same formula, different state. **That makes the residual a search problem, which
is precisely what the recommender is for — not a modelling defect.**

### Three real bugs found along the way

1. **`initial_friendship` was extracted and never applied.** Cards started at
   bond 0 instead of 20–35. Since rainbow needs 80, that was a third of the
   distance thrown away on every card, compounding across the career. Fixing it
   moved rainbow frequency from 13% to 38%.
2. **The harness only ever bought techniques, never songs.** No simulated career
   learned a single song, forfeiting both the per-training stat bonuses and the
   Great Success bump that needs three songs before each concert.
3. **Mood was never managed.** With these cards' `mood_effect` values, great
   versus normal is worth ~38% on every training, and the policy left it at
   normal.

### A correction: real runs do NOT level most facilities

The end-of-run capture shows **Speed 5, Wit 5, and Stamina, Power and Guts still
at level 1** — untouched for 72 turns. The earlier claim here that a real career
"reaches 4-5" across the board was wrong, and the inference built on it
("facility levels never rise") was measuring the wrong thing. Facility level is a
*consequence* of concentrating training, not an independent lever.

## Original candidate list, for the record

1. **Rainbow / friendship training.** ✅ **CONFIRMED as a top cause** — 19% of
   trainings, three cards never reaching bond 80.
2. **Card placement weighting.** ✅ **CONFIRMED** — entangled with (1) as
   predicted, and the flat 2:1 bias is what starves it.
3. **Facility levels.** ✅ **CONFIRMED, and I had this backwards.** Adding
   level-ups moved the projection ~2%, and I read that as "not the dominant
   term". Wrong inference: the mechanic barely fired, so of course adding it
   changed little. Instrumenting the run shows facilities ending at 1-3 where a
   real career reaches 4-5. A small measured effect from a mechanism that is
   itself broken says nothing about the mechanism's importance.
4. ~~**Song and concert bonuses.**~~ **RESOLVED 2026-09-05.** Songs grant
   permanent per-training stat bonuses ("Training Speed Gain +1") worth up to +3
   per stat, decoded from the game's own effect text and now fed into the model.
   Concert bonuses remain undecoded.
5. **Events and inspirations.** Not modelled at all (see `events.md`).
6. **Interpolated facility levels 2-4.** Real values are absent from `master.mdb`.
7. **Growth rates and starting stats** come from the scan. Starting stats are
   fine; the growth rate is the most likely explanation for the one-point
   stamina residual above, and its value is still unknown.

## Why this is not "fix it before shipping"

Every remaining lever is an unverified quantity. Tuning the model until its output
looks like a real run would produce a number that matches by construction and
tells you nothing — and it would bake in whichever wrong assumption happened to
compensate.

The correct next step is **M2**, and its tooling now exists: see
[m2-logging.md](m2-logging.md).

M2 does not log outcomes turn by turn. It captures the **training screen**, which
displays the game's own predicted gains for all five facilities simultaneously
with no RNG in them -- five clean observations per screenshot instead of one
noisy one. The residual analysis then buckets observed/predicted ratios by each
term's input; whichever grouping shows a trend names the broken term, which is
what converts the unranked list above into a ranked one.

The diagnostics are tested against synthetic data with a planted bug, so a clean
reading on real data is evidence rather than wishful.

This is why M1 and M2 were always going to be one piece of work.

## Assumptions the engine reports at runtime

Every projection carries these in an `assumptions` array, and the CLI prints
them. Nothing here is silent:

- stat-gain formula shape is community-derived, not verified against a logged run
- ~~support card effect type ids are community-derived~~ **VERIFIED 2026-09-05**
  against the game's own card detail panels: 30 values across six cards matched
  the extracted curves exactly. Covers every term the training formula uses.
  See `packages/engine/test/fixtures/support-card-panels.json`.
- facility levels 2-4 are linearly interpolated
- training failure rate is a placeholder
- token gain omits the scenario-link term (2L)
- bond gain per training is approximate
- support card placement weighting is a 2:1 approximation
- rest energy gain is approximate
- facility level-up thresholds are approximated (one level per four uses)
- song mastery and concert bonus effects are not decoded, so are worth nothing

## What must not happen

Do not ship a recommendation UI on top of this model. A 2-3x systematic error
would produce confident, specific, wrong advice — and the user cannot tell.
Goal probabilities in particular (`P(hit target)` currently reads 0% against a
realistic target) are meaningless until the model is calibrated.

The engine's output includes a `warning` field saying exactly this. Do not remove
it until logged runs justify doing so.
