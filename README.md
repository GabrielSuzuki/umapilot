# umapilot

A goal-conditioned planner for Umamusume: Pretty Derby career runs.

You say what you want at the end of a run — five stat targets and a list of
skills — and it tells you which plays maximise your chance of getting there,
with the reasoning shown.

Currently targets the **Grand Concert** (Grand Live) scenario on the global
version. Web-only, no install, nothing that touches the game.

> Status: **M2 tooling built.** The forward simulator runs and is reproducible
> from a seed, but projects roughly 2-3x below real runs
> ([docs/m1-status.md](docs/m1-status.md)). The calibration tools that fix that
> are in place and tested against planted bugs — they now need real observations.
> [docs/m2-logging.md](docs/m2-logging.md) says what to capture: screenshots of
> the training screen, which shows the game's own predicted gains for all five
> facilities at once. Do not build a recommendation UI until this is calibrated.

Before a run you scan two screens (Support Formation and Legacy Select) and the
tool reads your six support cards, your legacy setup, and the stat caps that
apply to *that* run — see [docs/scan-spec.md](docs/scan-spec.md).

During a run it gives per-turn advice with **zero interactions per turn**: the
page watches the game window through the browser's own screen-capture API,
processes frames locally, and ranks all five facilities before you have finished
reading the turn. No install, nothing attached to the game process. The design
and its fallbacks are in [docs/interaction-design.md](docs/interaction-design.md).

---

## Why another Umamusume tool

The existing ones fall into two groups:

- **Race simulators** ([uma-skill-tools], [VFalator]) — good, maintained, and
  they solve the race side properly. umapilot does not compete with them; it
  will consume their skill valuations.
- **Static planners** ([uma.guide's calculator], [daftuyda's token planner]) —
  checkbox budget trackers. They tell you what a set of songs costs. They do not
  tell you *when* to buy them.

That gap is the point. A Concert Bonus bought in Classic June multiplies every
remaining training; the same bonus bought in Senior November multiplies almost
nothing. Song value is a function of turns remaining, and nothing currently
models that.

The one serious planner, [UmaAi], does model it — with MCTS and a full scenario
simulator — but it maximises raw score, is built around the JP scenarios, and
its author stopped maintaining it in early 2026.

umapilot's objective is different: **maximise `P(final build ≥ your target)`**,
reported as a probability with an interval rather than a score.

[uma-skill-tools]: https://github.com/alpha123/uma-skill-tools
[VFalator]: https://kachi-dev.github.io/uma-tools/
[uma.guide's calculator]: https://uma.guide/grand-live-calculator/
[daftuyda's token planner]: https://daftuyda.moe/token-planner
[UmaAi]: https://github.com/hzyhhzy/UmaAi

---

## Layout

```
tools/extract/          master.mdb -> versioned JSON (Python, build-time only)
packages/data/          schema, generated datasets, shared TypeScript types
packages/engine/        scenario interface, simulator, recommender  [M1+]
packages/web/           the app                                      [M3]
```

The engine never imports the UI or the extractor. It should always be runnable
headless as `engine < state.json > recommendation.json`.

---

## Getting the data

`master.mdb` is a plain SQLite database shipped with the game client. It is the
canonical source for song and technique costs, so umapilot reads it directly
rather than scraping wikis — it is correct on patch day, and it costs nobody
else bandwidth.

**The dataset is not committed to this repo.** It is game content; you generate
it from your own installed copy. The extractor is the artifact, not its output.

```bash
python tools/extract/extract.py --out packages/data/generated
```

The default path is the standard Windows install location:

```
%USERPROFILE%\AppData\LocalLow\Cygames\Umamusume\master\master.mdb
```

Pass `--mdb` if yours is elsewhere. The database is opened **read-only**; the
extractor never writes to your game files.

Output is keyed by a content hash of `master.mdb`, so a patch produces a new
file next to the old one rather than silently overwriting it. Diff them to see
what changed.

### Validation

The extractor refuses to emit a dataset that fails its invariants. The load-bearing
one: summing every song's cost per token must reproduce the
independently-published totals —

| dance | passion | vocal | visual | mental |
|------:|--------:|------:|-------:|-------:|
|   252 |     201 |   150 |    275 |    196 |

`single_mode_live_square` stores costs as anonymous `perf_type` integers with no
labels anywhere in the database. That table matching exactly is what pins
`perf_type → token`; it is the reason the mapping is a fact rather than a guess,
and it is why the check runs on every extraction.

---

## Design principles

**Preserve raw, decode incrementally.** Effects are stored as the game's own
English text *plus* the undecoded opcode tuple. Where semantics aren't known,
they are not invented — see the `disableSingleMode` note in `extract.py` for
what happens when you guess.

**Reproducible from a seed.** `Scenario.step` is pure. Golden-file regression on
full career runs depends on it.

**Show the working.** Every recommendation carries a `ValueBreakdown`. A
recommender you can't audit is one nobody trusts, and the decomposition is the
fastest way to find engine bugs.

**Validate against reality.** M1/M2 exist to prove predicted stat gains match
logged real runs. No existing tool publishes accuracy numbers.

**Confirm what was guessed.** The scan always shows what it read before a run
starts. A misread support card silently poisons 72 turns of advice and the user
cannot tell — so it gets two seconds of confirmation instead.

---

## Not doing

- **No memory reading, injection, or file modification.** The client ships
  CrackProof anti-tamper. Nothing here goes near the game process.
- **No input automation.** Passive advice only. Auto-trainers are what actually
  get accounts banned, and this is meant to be shareable.
- **No race simulation.** [uma-skill-tools] already does it well.

---

## Roadmap

| | | |
|---|---|---|
| **M0** | Extractor, schema, types, support cards, sparks | ✅ |
| M1 | Forward simulator, pure and seeded; CLI; 33 tests | 🟡 built, uncalibrated |
| M1b | Validate against logged runs; decode spark and support-effect opcodes | |
| M2 | Calibration: training-screen log, residual diagnostics, base-value solver | 🟡 tooling built, awaiting real data |
| M3 | Lesson/song beam-search planner + web UI + pre-run scan | |
| M3b | Per-turn advice via continuous browser screen capture — see [docs/interaction-design.md](docs/interaction-design.md) | |
| M4 | Goal probability with confidence intervals | |
| M5 | Turn recommender using the planner's shadow prices | |

---

## License

MIT. Game data belongs to Cygames and is not distributed here.
