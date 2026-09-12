# M3: the planner

**Status: engine only.** The beam search, the objective, the shadow prices and
the headless CLI are in. The web UI and the pre-run scan, which M3 also names,
are not — deliberately, and for the reason M1 and M2 were built before any UI: a
recommender that has not been shown to beat its own fallback policy produces
confident, specific, wrong advice, and the user cannot tell.

---

## What it does

`plan(scenario, state, target, options)` ranks every legal action for the
current turn, each with:

- an **ev**, the change in the run's value against a baseline of *no search at
  all* — the rollout policy simply playing on from here. A positive ev means the
  search found something better than that. A near-zero ev on the top action
  means the turn does not matter much, which is worth saying.
- a **goal probability** with a Wilson interval, for the top few actions.
- a **breakdown** into stats / tokens / bonds / skill points / energy-and-mood,
  all in the same units, so the numbers can be added and argued with.
- a **spread** across independent worlds, and a `topIsClear` flag that is false
  when the top two cannot be separated at this sample count.

Plus a **shop schedule** and the **measured price** of every resource.

```
npm run plan -- --state examples/run.json
npm run plan -- --state examples/run.json --worlds 8 --objective goalProbability
```

---

## Why a search and not a scoring formula

This is the argument from `interaction-design.md`, restated because it is what
the whole design rests on.

A training yields stats now. A rest yields **zero** stats. Any "expected stats
this turn" comparison therefore ranks every training above every rest — always,
structurally, not by a tuning margin. No choice of weights fixes it, because the
value of rest is not stats; it is energy, and energy has no value except through
the trainings it later buys.

The same is true of mood (a multiplier on every remaining training, so worth far
more in Junior year than in Senior), of performance tokens (worth whatever they
eventually purchase), and of bond (worth the rainbow trainings it unlocks).

So the planner prices them by measurement rather than by choosing weights, and
the mechanism is one forward search over both decision layers.

---

## How it handles the parts that are easy to get wrong

### The domain is stochastic, and beam search on a stochastic domain lies

`step` rolls for training failure, token type and card placement. A beam that
samples one successor per action and keeps the highest-scoring children does not
find the best actions — it finds the actions that drew the best luck. With a
beam of 24 over a dozen actions and six turns, the winner is a maximum over
hundreds of samples of noise, and the search reliably prefers whatever is
highest-variance. This is the standard failure mode of beam search on an MDP and
it looks exactly like a working planner.

Two mechanisms, both cheap:

**Common random numbers.** Every expansion at a given depth builds a *fresh*
generator seeded from `(world, depth)`, so all siblings face identical draws and
the difference between two actions is attributable to the actions. The same
pairing is used for every shadow-price difference, where it is even more
load-bearing: the perturbation is ten energy points against a career that varies
by hundreds of stat points between seeds, and measured with independent
randomness the signal is simply invisible.

**Root determinization.** The whole search is repeated over `worlds` independent
seeds and a root action scores its **mean**, not its best. An action that wins
one world by luck and loses the rest does not survive averaging. The spread
across worlds is reported rather than hidden.

### Two kinds of starvation in the beam's own pruning

Both are search artefacts that masquerade as findings about the game.

**Root starvation.** A plain top-N cut lets one strong opening monopolise the
beam by depth two, after which every other opening is scored from a thin
remnant. That makes the search unfalsifiable: everything it pruned early comes
back looking worst, whether or not it was.

**Spending starvation.** A purchase costs tokens now and pays off later, so at
the moment of buying a buy-node scores no better than the hold-node it branched
from — and when token prices are near zero it scores *exactly* the same. Ties
then resolve by insertion order, which favours holding. Purchase lines were
being cut at depth 0 and 1 and never reaching the concert that justified them.
The search was not deciding against buying; it was never pricing the option.

Both are fixed by bucketing the beam on `(root action, purchases so far)` and
filling round-robin across buckets. That carries both kinds of line forward to
the depth where the difference shows up and lets the leaf evaluation decide,
without inventing any value for a purchase.

### Shop purchases are not depth

Buying costs no turn, so a node may buy several times and then take exactly one
turn action, which is what advances depth. `maxBuysPerTurn` bounds the branching
that free actions would otherwise make unbounded.

Techniques are collapsed to the two cheapest affordable. They are near-identical
— +5 SP at the next concert, one tick toward the next song gate — so the only
thing distinguishing two of them is which currencies they drain. Songs are *not*
collapsed: which song and when is the question Layer B exists to answer.

---

## Two objectives, and why both

| | cost | used for |
|---|---|---|
| **shortfall** | microseconds, deterministic | ordering interior nodes, where only the ranking matters |
| **goal probability** | ~milliseconds per action | the reported number, at the root |

Goal probability is not monotone in the scalar: once a stat target is met,
further gains in that stat are worth nothing to the goal, but a naive sum keeps
paying for them. Using the scalar everywhere would be wrong in that specific
way. Using goal probability everywhere would be right and unaffordable.

The scalar caps each stat's contribution at its target and adds a small
overshoot term. Not zero, because a flat objective past the target gives the
search no reason to prefer a run that finishes clear of the target over one that
scrapes it — and under noise the second misses far more often. Not one, because
that is the naive sum, and pouring 600 points into a stat with a 400 target
while another sits short is the exact failure this project exists to avoid. The
test suite pins the ratio: 640 points past a target buy less than 60 points
still short.

---

## What a target means, and what a point in it costs

The scalar caps each stat at its target. What it does *below* the target is a
separate choice, and until 0022 it was one nobody had priced.

`shortfallScore` scored a stat as `min(1, have/goal)` and averaged over the
targeted stats, so the value of one raw point was **`1/goal`**. Every target
was worth the same share of the score, which sounds neutral and is not: it
means **the size of a target sets the price of a point in it.** Under a speed
700 / guts 200 target a guts point was worth **3.5x** a speed point, while the
simulator's own yields said a speed training pays **1.8x** a guts training. The
objective outbid its own yield model, and the search dutifully followed it onto
facilities the player's deck can never rainbow.

`TargetNorm` is the replacement and the default:

| | score | value of one point below target |
|---|---|---|
| `fraction` | mean of `min(1, have/goal)` | `1/goal` — each TARGET weighted equally |
| **`points`** | `sum(min(have, goal)) / sum(goal)` | `1/sum(goal)` — each POINT weighted equally |

Under `points` the price is flat across stats, so which facility wins is
decided by what it pays. The per-stat cap is unchanged: a met target still
drops to the overshoot weight, so the objective still refuses to pour 600
points into a 400 target.

**The trade is real.** `fraction` guarantees a small target a full share of the
score; `points` gives it a share proportional to its size, so a small target
*can* be left unmet. That is measured below, in both directions.

### How it was measured

Not by agreement with the captured career. `replay-validation.md` Part 3 showed
that removing the off-deck pull moves agreement *below* chance for a reason
that lives in the leaf evaluator — the player alternates speed and wit to
conserve energy, and the rollout policy rests instead — so agreement penalises
a correct fix here. It is reported and not gated.

The yardstick is `meetsTarget`, the predicate the UI reports. Neither norm
optimises it directly; both are surrogates for it. 48 paired seeds, full
`plan()`-driven careers, his real deck, reachable target:

| | `fraction` | `points` | paired difference |
|---|---:|---:|---|
| all targets met | 12.5% | **39.6%** | +0.271, t = 3.27, 95% CI [0.108, 0.433] |
| — McNemar on the discordant pairs | 3 | **16** | exact two-sided **p = 0.0044** |
| targets met, of 5 | 3.52 | **4.13** | +0.60, t = 3.92 |
| final stats, race-effective | 2370 | **2491** | +121, t = 3.42 |

Per target, `points` wins where it matters and pays for it in one place:
speed **35% -> 81%**, wit **19% -> 44%**, stamina **100% -> 88%**.

The estimate *grew* from +0.200 at n = 20 to +0.271 at n = 48 — the opposite of
the shape this project has twice mistaken for a result.

### Where `points` is worse

On an **unreachable** target it is worse on the thing that matters. Against his
stated 1600/650/1200/550/1000 build, neither norm meets everything, but
`fraction` meets 0.40 of the five targets on average and `points` meets
**0.00** (t = -3.56): `points` chases the big goals proportionally — speed 408
-> 909, wit 397 -> 526 — and abandons the small reachable ones — stamina 586 ->
306, guts 459 -> 279.

This is the predicted failure mode, and it is confined to a state the product
is already supposed to prevent: `statOutlook` (0019) reports an unreachable
target before the first recommendation. The honest fix is to renormalise
against the projected reachable frontier rather than the typed goal, which is
the number `statOutlook` already computes. Not done.

`--target-norm fraction` restores the old behaviour on the CLI.

---

## What a shadow price means

`shadowPrices()` returns objective-score per unit of energy, mood, each token,
bond and skill point, measured by paired rollouts. Read them like this:

- **A price of zero usually means the resource is not binding here.** Energy on
  the last turn: there is nothing left to spend it on. A token whose supply
  already exceeds what the shop can absorb. Both are true answers, and both are
  exactly when the tool should stop telling you to rest or to save.
- **A small negative price is sampling noise.** Raise `--shadow-samples` rather
  than reading meaning into it.
- **They are local.** Valid near the state they were measured at, and nowhere
  else. They are re-measured on every call.

They are also Layer B's dual: "what is a Visual token worth" is answered by the
same rollouts that value everything else, which is the coupling the original
design recommendation asked for.

---

## Three bugs this milestone surfaced

All three were silent, and all three were found by building something that
enumerates actions programmatically rather than following a script.

**1. An unknown action was a free turn.** `step`'s switch had no default, so an
unrecognised action kind advanced the turn and did nothing else. `simulator.ts`
had been passing `{ kind: "outing" }` since the action was renamed to
`recreation`, so those turns did nothing at all and the golden digest had been
pinning that. It matters much more to a search: a no-op that costs a turn and
yields nothing is a "pass" move the game does not offer, and a search will find
and exploit one. `step` now throws, with a `never` binding so a new action
variant fails typecheck.

**2. Turn 1 had an empty board.** `initialState()` left `placement` empty and
only filled it at the *end* of `step`, so the first training of every simulated
career ran with no support cards on any facility — no friendship bonus, no
card-count multiplier, no bond growth. One turn in seventy-two is small in a
projection and large in a recommendation: turn 1 is the first advice a player
ever sees, and it was computed against a board that does not occur.

**3. Songs did nothing.** This is the big one. The decoder in
`packages/data/src/effects.ts` was written, `computeTraining` was given
`songBonuses` and `songSkillPointBonus` parameters to receive it — and nothing
ever passed them. Every song in the model was a pure token sink.

The consequence was not a mild under-projection. It priced a performance token
at **zero at the margin**, which left the entire lesson-shop layer an
unconstrained problem with no gradient. The first Layer B plans this milestone
produced were empty, and correctly so: a planner cannot schedule purchases whose
payoff its own model values at nothing. Wiring it in is what made the search
start choosing songs.

---

## What is still not modelled

In rough order of how much it distorts a recommendation:

1. **Concert Bonus opcodes are not decoded.** `master.mdb` stores a song's
   permanent from-next-concert effect as an integer type with no shipped
   description, so unlike the Mastery Bonus it cannot be read off the game's own
   text. It is stored, flagged, and not applied. Every song is therefore valued
   below its worth — and **songs bought early are undervalued most**, because
   the Concert Bonus is precisely the part whose value scales with turns
   remaining. That is the same time-value effect the project identified as the
   biggest gap in every existing planner, so it is the top item to close.
2. **Race rewards.** Races are exposed as an action and flagged; the reward
   tables are not extracted, so a race recommendation is not yet meaningful.
3. **Outing payouts.** The outing *structure* is extracted and schedulable, but
   per-step rewards live in the story assets. The planner will not schedule
   companion outings unless the caller declares which companions are in the
   deck, because the scenario does not model the deck-to-companion link and
   guessing it would produce turns spent with a friend the player never brought.
4. Everything already listed in `m1-status.md` — facility levels 2–4, bond
   growth rate, placement weighting, the failure-rate energy curve.

---

## Cost

On a 72-turn career at the defaults (`width 24`, `horizon 6`, `worlds 4`), one
recommendation is roughly 4,000 node expansions and ~100 rollouts, and lands in
around one second. That is comfortably inside a turn, which is what the
continuous-capture interaction design needs — the advice should be on screen
before the player has finished reading the turn.

The knobs, in the order worth turning: `--worlds` buys reduction in optimism
bias, `--prob-samples` narrows the reported interval, `--horizon` buys genuine
lookahead and costs the most.

---

## Testing without the game

`packages/engine/test/planner.ts` runs on a **synthetic fixture**, so unlike
every other suite here it runs on a machine with no `master.mdb` — including CI,
which until now executed zero engine assertions because every suite skipped
itself on a runner.

This is not a violation of the one rule in `CONTRIBUTING.md`. The fixture is not
a dataset: nothing in it is claimed to describe the game, it is not loadable
through the extractor's output path, its provenance field reads
`SYNTHETIC-FIXTURE-NOT-EXTRACTED`, and no assertion that uses it asserts a game
fact. The numbers are round and uniform on purpose. What is *real* is the effect
text's grammar — the engine decodes English rather than opcodes, and a fixture
whose text did not parse would exercise none of that path, which is exactly how
the song-bonus wiring stayed missing without any test noticing.

The suite asserts properties of the search: purity, determinism from a seed,
that no illegal action is ever proposed, that overshoot is worth less than
shortfall, that energy has a nonzero price at turn 1 and a lower one at turn 72,
that rest can outrank training when energy is low — and the one that decides
whether M3 was worth building, that searching beats the heuristic policy it
falls back on, on paired seeds.

The bar on that last one is deliberately weak. A short synthetic career with a
small horizon leaves little room to out-plan a decent heuristic, and claiming a
large margin there would be claiming something about a fixture. What must hold
is that the search is not *worse* — a search that loses to its own rollout
policy is broken, and that is the bug the test exists to catch on the day it
appears.

**The real measurement is still owed**, and it is the same one M2 established
the method for: run the search against a logged real career and compare its
choices to what a skilled player actually did. Until then the ranking is a
hypothesis about this model, not a measurement of the game, and every result
says so.
