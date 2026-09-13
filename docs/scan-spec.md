# Pre-run scan

Two screenshots, taken once before a career starts, become the run's starting
conditions.

## Why this stays web-only

A live per-turn overlay would need a desktop app, a capture loop, and a process
sitting next to the game. Two screenshots taken once do not. The user screenshots
Support Formation and Legacy Select, drops both onto the web page, and OCR runs
**client-side in the browser**. Nothing is installed, nothing touches the game,
no image leaves their machine.

So the M3 web decision survives this requirement intact. Live capture stays
deferred to M6, and may never be needed.

---

## Screen A — Support Formation

![support formation]

### Extractable

| field | method | confidence |
|---|---|---|
| Deck preset name (`rice`) | OCR | high |
| Card count (6) | layout | high |
| Card level (`Lvl 50`) | OCR | high |
| Limit break (◆◆◆◆) | count filled diamonds | high |
| Rarity badge (SSR/SR/R) | OCR or template | high |
| Type icon (shoe / heart / arm / flame / cap / smiley / group) | template match, 7 classes | high |
| `Scenario Link` ribbon | template match | high |
| `Friends` ribbon | template match | high |
| Type tally row (shoe ×3, cap ×2, smiley ×1) | OCR — **free checksum** | high |
| **Which card it is** | see below | **medium** |

### The one hard part

Everything above is text or a fixed icon. Card *identity* is full-bleed
character art, and there are 235 of them.

Recommended approach, in order:

1. **Perceptual hash against the game's own art.** The card images ship in the
   client under `dat/`. Build the pHash index from the user's own install — the
   same principle as the master.mdb extractor, and it means no scraping and no
   redistributing Cygames art.
2. **Narrow by what's already read.** Rarity + type + limit break cuts 235
   candidates to a handful before the hash even runs.
3. **Always show a confirmation step.** Six dropdowns, prefilled with the match
   and its confidence, that the user can correct in two seconds.

That third point is not a fallback, it is the design. A misread card silently
poisons every recommendation for 72 turns, and the user cannot tell. Cheap to
confirm, expensive to get wrong — so confirm.

### Free checksum

The tally row (`shoe ×3, cap ×2, smiley ×1`) is independently OCR-able and must
agree with the six identified cards. If it doesn't, at least one card is
misread — flag it rather than proceeding. Costs nothing, catches real errors.

---

## Screen B — Legacy Select

### Extractable

| field | method | confidence |
|---|---|---|
| Affinity symbol (◎ / ○ / ×) | template match, 3 classes | high |
| Starting stats (109 / 196 / 119 / 92 / 92) | OCR | high |
| Spark stat bonuses (+33 / +54 / +21) | OCR | high |
| **Stat caps** (1600 / 1366 / 1316 / 1500 / 1300) | OCR | high |
| Stat letter grades (F, F+, G+) | OCR | medium |
| Aptitudes — track / distance / style | OCR, 10 fields | high |
| Legacy ranks (SS, SS+, S, S+) and Guest flag | OCR | high |
| Which legacy umas | art match, as above | medium |

### The finding that changes the model

**Stat caps are per-run, not per-scenario.**

The screenshot reads Stamina `/1366` and Power `/1316`, against the scenario base
of 1300 for both — legacy raised them by 66 and 16. Speed (1600), Guts (1500) and
Wit (1300) are unmodified and match the extracted base exactly, which confirms
both the base values and the fact that they move.

`validateTarget` currently checks against the static caps from the dataset. That
is wrong: it would reject a legitimate 1350 Stamina target on a run where the cap
is actually 1366. Fixed — caps now come from the scanned run setup, with the
scenario base only as the fallback when nothing has been scanned.

Worth noting the check runs in both directions: the extracted base caps
corroborate the screenshot, and the screenshot proves the caps are dynamic. That
is two independent sources agreeing, which is the standard the whole dataset is
held to.

**And they are not per-run either. They move within a run.** (2026-09-13.)

That sentence above — "per-run, not per-scenario" — was half the finding, and the
half it got wrong stayed wrong for a week because a per-run constant is read once
and never questioned again. Reading the cap row on all 58 training frames of the
captured career (`tools/vision/caps-probe.ts`):

| | Junior + Classic to Mar | Classic Apr → | Senior Apr → |
|---|---|---|---|
| Speed   | 1625 | 1630 | 1635 |
| Stamina | 1332 | 1336 | 1342 |
| Power   | 1332 | 1337 | 1343 |
| Guts    | 1500 | 1500 | 1500 |
| Wit     | 1300 | 1300 | 1304 |

**When, exactly.** Mapping the bracketing frames to career turns: the caps hold
at the Legacy Select values through turn 30 and read the second column at turn
31; they hold the second column through turn 54 and read the third at turn 55.
Turns 31 and 55 are **Classic Early Apr** and **Senior Early Apr**.

That rules out the two obvious explanations, including the one this document
first offered:

- **Not "the first turn of a new year"** — that is turn 25 and turn 49, and
  frames at turns 25–30 and 49–54 read the *old* caps. This was written here as
  fact and was wrong; it came from the calendar string saying "Apr" and nobody
  converting it to a turn number.
- **Not "after each concert"** — the concerts are at 24, 36, 48, 60, 72. Turns 31
  and 55 are seven turns after two of them, and nothing moves after the concerts
  at 36 or 60. Frames at turns 37–43 read the same caps as turn 31, and turn 61
  reads the same as turn 55.
- **Not every Early Apr either** — Junior Early Apr is turn 7, and every frame
  from turn 1 to turn 30 reads the Legacy Select caps unchanged.

So: twice in a career, at Early Apr of the Classic and Senior years. What causes
it is unknown, and the sizes are not a flat bonus or a clean percentage — guts
never moves and wit moves once.

The player's own account is *"after concerts the stat cap is raised as well based
on stat inherits"*. The **inherits** half fits in one place — guts had a legacy
bonus of 0 (cap 1500 = the scenario base) and is the one stat that never rises —
and fails in another: wit also had a bonus of 0 (1300 = base) and still went to
1304. The **after concerts** half does not fit the turn numbers at all. Recorded
here as stated, next to the measurement that disagrees, rather than resolved.

Three witnesses, none of them the OCR that proposed the numbers: the player's
Legacy Select transcription for the first column; his own note on frame 59
("Stat caps have crept up to 1635/1342/1343/1500/1304"), written while
transcribing and before anyone was looking for this; and frame 80, where speed
sits at 1635 with the training preview reading +0, i.e. the cap read off a
different field in a different template set.

Consequence for the app: the cap row is read **every turn**, not once. A cap
scanned at Legacy Select and held is 10 points low for the last third of a
career, which is exactly the region where `statOutlook` is deciding whether more
speed is worth anything. See `capField` in `packages/engine/src/vision/fields.ts`
and `examples/stat-caps-2026-09-05.json`.

---

## What the scan produces

```ts
interface RunSetup {
  supportCards: Array<{
    cardId: number;
    level: number;
    limitBreak: 0 | 1 | 2 | 3 | 4;
    borrowed: boolean;        // the pink "Friends" ribbon
    scenarioLink: boolean;
    confidence: number;       // < 1 means the user should confirm
  }>;
  legacy: {
    affinity: 1 | 2 | 3;
    startingStats: StatVector;
    sparkBonuses: Partial<StatVector>;
    statCaps: StatVector;     // per-run; overrides the scenario base
    aptitudes: Aptitudes;
    legacyRanks: [string, string];
  };
  scannedAt: string;
  needsConfirmation: string[];  // field paths the user should check
}
```

`needsConfirmation` is never empty on a first scan. That is intentional.

---

## Two ribbons, two meanings

Easy to conflate, and the scan must not:

- **Orange smiley icon** (top-right of a card) = the card is a **Friend-type**
  support card. 10 of these exist.
- **Pink `Friends` ribbon** (bottom of a card) = the card is **borrowed from a
  friend** for this run. Any type of card can carry it.

In the reference screenshot, card 1 is a Friend-type card and card 6 is a
borrowed Speed card. Different fields; the tally row counts only the first.
