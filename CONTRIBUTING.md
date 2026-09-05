# Contributing

## Setup

```bash
npm ci
python tools/extract/extract.py --out packages/data/generated   # needs your own game install
npm run typecheck
npx tsx packages/engine/test/smoke.ts
```

The smoke test skips itself if no dataset is present, so a fresh clone without
the game still passes.

## The one rule

**Don't write a guess into the dataset.**

Much of `master.mdb` is unlabelled integers. When you work out what a field
means, you must be able to say how you know. Three acceptable answers:

1. The database says so (a `text_data` category that names it).
2. It reproduces an independently published figure exactly — the way summing
   song costs per `perf_type` reproduces the community token totals.
3. It matches observed in-game behaviour, with the observation recorded as a test.

If you have none of those, store the raw value and label it undecoded. There are
already examples of both the right way (`perf_type`) and the wrong way
(`disable_singlemode`, which was guessed, was wrong, and is now raw) in
`tools/extract/extract.py`.

## Adding a scenario

`packages/engine/src/scenario.ts` is the boundary. Nothing outside
`packages/engine/src/scenarios/` may name a specific scenario.

The interface currently has exactly one implementation, which means it is
probably wrong in ways only a second scenario will reveal. Widen it when that
happens — don't pre-generalise.

## Game data

Never commit `master.mdb`, extracted datasets, or game art. `.gitignore` covers
these; check `git status` before committing anyway.

The extractor is the artifact. Users generate data from their own install.

## Scope

Out of scope, permanently:

- Reading game memory, injecting, or modifying game files
- Automating input
- Race simulation (use [uma-skill-tools](https://github.com/alpha123/uma-skill-tools))

The first two are what get accounts banned and would make this unshareable. The
third is already solved well by someone else.
