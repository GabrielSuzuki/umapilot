# extract

Reads the game's `master.mdb` and emits versioned JSON for `packages/data`.

Build-time only — nothing here ships to the browser.

```bash
python extract.py --out ../../packages/data/generated
```

Requires Python 3.10+. No third-party dependencies: `sqlite3` is in the standard
library, which is the whole reason this is Python and not TypeScript.

## Tables it reads

| table | what it gives us |
|---|---|
| `single_mode_live_square` | every technique and song: token costs, effect ids |
| `single_mode_live_song_list` | concert bonus type/value per song |
| `single_mode_live_live_data` | the five concert turns, Great Success threshold |
| `single_mode_live_master_bonus` | raw effect opcodes |
| `text_data` | names (category 209) and effect wording (category 207) |
| `skill_data` + `single_mode_skill_need_point` | the skill index and SP prices |

## When the game patches

Re-run it. If an invariant breaks, the extractor exits non-zero and says which —
that is the intended behaviour, not a bug to work around. Fix the mapping, then
diff the new dataset against the previous hash to see what Cygames changed.

`--allow-invalid` exists for local debugging. Do not use it in CI.
