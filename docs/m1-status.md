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

## Candidate causes, unranked

They are unranked on purpose. Ranking them without logged data would be guessing,
and guessing is what the project's one rule forbids.

1. **Rainbow / friendship training.** Requires bond ≥ 80 *and* the card sitting
   on its own facility. In the model, cards scatter and bonds climb slowly, so
   rainbow almost never fires. In a real run it is the dominant multiplier.
2. **Card placement weighting.** A flat 2:1 bias toward a card's own facility is
   a placeholder. The real distribution is not decoded, and it directly controls
   how often rainbow triggers — so this and (1) are entangled.
3. **Facility levels.** Modelled as one level per four uses. Adding this moved
   the projection by only ~2%, which is itself informative: it is *not* the
   dominant term.
4. ~~**Song and concert bonuses.**~~ **RESOLVED 2026-09-05.** Songs grant
   permanent per-training stat bonuses ("Training Speed Gain +1") worth up to +3
   per stat, decoded from the game's own effect text and now fed into the model.
   Concert bonuses remain undecoded.
5. **Events and inspirations.** Not modelled at all (see `events.md`).
6. **Interpolated facility levels 2-4.** Real values are absent from `master.mdb`.
7. **Growth rates and starting stats** come from the scan and are probably fine.

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
