# M2 — calibrating the simulator

M1 shipped a simulator that projects 2–3× below real runs. M2 is how that gets
fixed: real observations, a residual analysis that says *which* term is wrong,
and a solver for the values `master.mdb` does not contain.

## The design decision that makes this cheap

The obvious way to log a run is to record your stats before and after each
training and diff them. Don't. It is 72 tedious entries, it captures one
observation per turn, and every observation is polluted by training failures,
events and rounding.

**The training screen already shows the game's own predicted gains for all five
facilities at once.** Those predictions are the exact output of the formula we
are trying to reproduce, with no RNG in them.

That changes the economics completely:

| | before/after diffing | training-screen capture |
|---|---|---|
| observations per turn | 1 | **5** |
| needs a clean turn | yes | no |
| contaminated by failures/events | yes | **no** |
| effort | note stats twice per turn | one screenshot |

Twenty screenshots gives ~100 clean observations across a range of facility
levels, moods and card placements. That is enough to fit a six-term multiplicative
model comfortably.

**So: screenshot the training screen. That's the whole ask.**

## What one observation is

A single (facility, this turn) row:

```jsonc
{
  "turn": 14,
  "facility": "speed",
  "facilityLevel": 3,
  "mood": "good",
  "energy": 71,
  "predictedGains": { "speed": 27, "power": 13 },   // as the game displays them
  "predictedSkillPoints": 4,
  "cards": [
    { "cardId": 30002, "bond": 84, "stat": "speed" },
    { "cardId": 30052, "bond": 40, "stat": null }
  ],
  "growthRate": { "stamina": 20 },
  "source": "training-screen"
}
```

Everything here is visible on that one screen except `cardId` and `growthRate`,
which come from the pre-run scan and stay constant for the whole career.

Logs are JSONL — one observation per line, append-only. See
`examples/calibration-sample.jsonl`.

## What the analysis does with it

### 1. Residual diagnostics — which term is wrong

The model is multiplicative, so the informative residual is a **ratio**:

```
residual = observedGain / predictedGain
```

A residual of 1.0 everywhere means the model is right. What matters is not the
average but the *structure*: group the residuals and see which grouping shows a
trend.

| residual correlates with | the broken term |
|---|---|
| rainbow card count | friendship bonus |
| facility level | the interpolated levels 2–4 |
| total card count | the 1 + 0.05n count term |
| mood | the mood multiplier |
| nothing (flat offset) | base values or growth rate |

This is the point of M2. `m1-status.md` lists candidate causes and refuses to
rank them because ranking without data is guessing. This ranks them.

`calibrate` reports, for each grouping, the residual mean per bucket and a
**spread** figure — max bucket mean minus min. Large spread means that term is
the culprit; flat means it is innocent.

### 2. Solver — recover facility levels 2–4

`master.mdb` has base values for levels 1 and 5 only. With every other term
known, the base value falls straight out:

```
base = observedGain / (friendship × mood × effectiveness × count × growth)
```

Given observations at level 3, `calibrate --solve` reports the implied base
values with a spread across samples. A tight spread means the rest of the model
is right and the number is trustworthy; a wide one means something else is off
and you should fix the diagnostics first.

## How to run it

```bash
npx tsx packages/engine/src/calibration/cli.ts --log examples/calibration-sample.jsonl
npx tsx packages/engine/src/calibration/cli.ts --log mylog.jsonl --solve
```

## Capture checklist

For each turn you log:

1. Open the training menu.
2. Screenshot it — the whole screen, so all five facilities and the energy and
   mood indicators are in frame.
3. Note the turn number.

Vary what you capture. Twenty screenshots all at facility level 1 with the same
mood tell you much less than twenty spread across levels, moods and bond states.
In particular, **capture turns where a card has gone rainbow**, because the
friendship term is the leading suspect and it only shows up in those rows.

## Why the tooling exists before the data

The diagnostics are tested against synthetic observations generated from a known
model with **one term deliberately broken**. The test asserts that the analysis
fingers that specific term. That means when real data arrives, a clean result is
evidence rather than a hopeful reading of noise.

See `packages/engine/test/calibration.ts`.
