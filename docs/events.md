# Events and inspirations

Three sources of stats that are not training. All three are in scope for the
recommender; they differ sharply in how well the data is available.

| | what it is | data source | status |
|---|---|---|---|
| **General events** | scenario and chained story events with 2–3 choices | story assets under `dat/` | ⚠️ not in master.mdb |
| **Card events** | support-card-specific events, gated on bond level | story assets under `dat/` | ⚠️ not in master.mdb |
| **Inspirations** | 3 inheritance events per run | `succession_*` in master.mdb | ✅ extracted |

---

## The problem: event outcomes are not in master.mdb

Worth stating plainly because it is the one thing that does not fall out of the
extractor.

`single_mode_story_data` has all 7,825 events — ids, which card or character they
belong to, category flags. What it does not have is **what the choices do**.
`single_mode_event_choice_reward` looked promising and is not it: 36 rows of
icon-layout metadata, no stat values.

The actual outcomes live in the story timeline assets under
`~/AppData/LocalLow/Cygames/Umamusume/dat/`, as Unity assetbundles with hashed
filenames. That is where GameTora and Game8 get theirs.

### Options

**A. Parse the story assets.** Canonical, self-updating on patch day, same
philosophy as the master.mdb extractor. Needs UnityPy plus the asset-name
mapping. This is a real sub-project — [umamusu-translate] exists mostly to do
this — and it is not a weekend.

**B. Use a community event dataset.** Several exist in open repos, keyed by event
name. Immediately usable, but a third-party dependency that goes stale and that
someone else has to keep current.

**C. Don't model individual events at first.** Use aggregate expected value:
events fire at roughly known rates and give roughly known stat totals. Loses
per-choice advice, keeps the run projection honest.

### Recommendation

**C, then B, then A.**

The reason is what each layer actually buys. The recommender's job is which
*training* to pick and which *song* to buy. Events are mostly exogenous — they
happen to you, and modelling them as expected value shifts the projection
correctly even without naming them. Per-choice advice is a genuinely useful
feature, but GameTora's event helper already does that job well, and duplicating
it is not where this tool is differentiated.

So: aggregate EV in the simulator now (C), a bundled dataset when per-choice
advice is worth building (B), and asset parsing only if the dependency proves
unreliable (A). Do not start with A — it is the most work and the least payoff
per hour.

Card events do need one thing from day one regardless: **bond level tracking**,
since card events are gated on it and bond drives rainbow training. That comes
from the run state, not from event data.

[umamusu-translate]: https://github.com/noccu/umamusu-translate

---

## Inspirations

Three per career, confirmed against umamusu.wiki:

| # | when | what fires |
|---|---|---|
| 1 | career start (the Legacy Select screen) | blue sparks → stats, pink → aptitudes, green → unique skill hints |
| 2 | Classic year, Early April (~turn 25) | blue, pink and white sparks |
| 3 | Senior year, Early April (~turn 49) | blue, pink and white sparks |

Blue spark stat gain at the initial inspiration: **1★ → +5, 2★ → +12, 3★ → +21**.
Later inspirations vary roughly 1–28 depending on stars.

### What is extracted

`sparks.<hash>.json` carries all 1,139 succession factors (type, stars, grade,
effect group), the raw effect rows, and the affinity rank thresholds
(0–50 / 51–150 / 151+, matching the ×/○/◎ display).

### What is not

**Factor effect opcodes are not decoded.** `succession_factor_effect` gives
`effect_id`, `target_type`, `value_1`, `value_2` with no labels, and unlike the
`perf_type` mapping there is no published total to pin them against. They are
stored raw.

Decoding them is an M1 task and it has an obvious method: the Legacy Select
screen *displays the answer*. It shows `+33 Speed / +54 Stamina / +21 Power` for
a known set of sparks. Scan a few different legacy setups, and the mapping falls
out of the observed deltas. The scan and the decode feed each other.

Until that is done, inspirations 2 and 3 are modelled from the wiki's published
ranges rather than from the factor table — approximate, flagged as approximate,
and never presented as exact.

---

## How each enters the objective

The engine's target is `P(final build ≥ target)`. Each source enters differently:

- **Inspiration 1** is deterministic and known before turn 1 — it is read
  straight off the scan and folded into the starting state. No uncertainty.
- **Inspirations 2 and 3** are known in *distribution* at turn 1 (the sparks are
  fixed; the roll is not). They belong in the Monte Carlo as sampled events at
  turns 25 and 49.
- **General and card events** are the noise floor. Aggregate EV in the projection;
  sampled variance in the MC so the confidence interval is honest.

The distinction matters for how results are shown. Inspiration 1 narrows the
interval; the others widen it. A tool that reports `78% ± 3%` when the true
spread is `±11%` is worse than one that reports nothing.
