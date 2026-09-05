#!/usr/bin/env python3
"""
Self-consistency checks for the extractor's constant tables.

Runs without master.mdb, so CI can execute it. It cannot tell you whether a
mapping matches the game -- only that the tables agree with each other and with
themselves. That is a narrower claim than the invariants in extract.py's
`validate()`, but it catches the failure that actually happens in practice: a
typo in a hand-maintained dict that silently mis-types a whole category.

Exit code is non-zero on any failure.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import extract as E  # noqa: E402

STATS = {"speed", "stamina", "power", "guts", "wit"}

failures: list[str] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    print(f"{'  ok  ' if ok else 'FAIL  '}{name}{('  ' + detail) if detail else ''}")
    if not ok:
        failures.append(name)


# --- token tables ----------------------------------------------------------

check("TOKEN_BY_PERF_TYPE covers perf_type 1-5",
      sorted(E.TOKEN_BY_PERF_TYPE) == [1, 2, 3, 4, 5])

check("TOKEN_BY_PERF_TYPE is a bijection onto TOKENS",
      sorted(E.TOKEN_BY_PERF_TYPE.values()) == sorted(E.TOKENS))

check("song_cost_totals is keyed by exactly the tokens",
      set(E.CHECKS["song_cost_totals"]) == set(E.TOKENS))

check("every song cost total is positive",
      all(v > 0 for v in E.CHECKS["song_cost_totals"].values()))

# --- facilities ------------------------------------------------------------

check("FACILITY_TOKENS is keyed by the five stats",
      set(E.FACILITY_TOKENS) == STATS)

check("every facility payout names a real token",
      all(v["primary"] in E.TOKENS and v["secondary"] in E.TOKENS
          for v in E.FACILITY_TOKENS.values()))

check("no facility pays the same token twice",
      all(v["primary"] != v["secondary"] for v in E.FACILITY_TOKENS.values()))

check("each token is some facility's primary exactly once",
      sorted(v["primary"] for v in E.FACILITY_TOKENS.values()) == sorted(E.TOKENS))

check("token roll weights sum to 1",
      abs(sum(E.TOKEN_ROLL_WEIGHTS.values()) - 1.0) < 1e-9,
      str(E.TOKEN_ROLL_WEIGHTS))

# --- stats -----------------------------------------------------------------

# Stat caps are now derived from the database (BASE_STAT_CEILING + the
# scenario's bonus) and checked against these published figures at extraction
# time. Here we can only confirm the expectation table is well formed.
check("published stat caps are keyed by the five stats",
      set(E.CHECKS["stat_caps"]) == STATS)
check("every published stat cap exceeds the base ceiling",
      all(v >= E.BASE_STAT_CEILING for v in E.CHECKS["stat_caps"].values()),
      f"base ceiling {E.BASE_STAT_CEILING}")

check("training target types are distinct",
      len(set(E.TRAINING_TARGET_TYPES.values())) == len(E.TRAINING_TARGET_TYPES))
check("level-1 facility commands cover the five facilities, one each",
      sorted(E.FACILITY_COMMAND_LV1.values()) == sorted(STATS),
      str(E.FACILITY_COMMAND_LV1))
# There is deliberately no hardcoded level-5 table: those command ids follow the
# canonical stat order, not the command_id order, and assuming otherwise
# mislabelled three of five facilities. They are read from
# single_mode_training.base_command_id at extraction time instead.
check("no hardcoded level-5 facility table exists",
      not hasattr(E, "FACILITY_COMMAND_LV5"),
      "level-5 mapping must come from the database")

check("COMMAND_ID_TO_STAT maps onto the five stats, one each",
      sorted(E.COMMAND_ID_TO_STAT.values()) == sorted(STATS),
      str(E.COMMAND_ID_TO_STAT))

# --- support cards ---------------------------------------------------------

check("support card types are distinct",
      len(set(E.SUPPORT_CARD_TYPE.values())) == len(E.SUPPORT_CARD_TYPE))

check("support rarities are distinct",
      len(set(E.SUPPORT_RARITY.values())) == len(E.SUPPORT_RARITY))

check("support effect type names are distinct",
      len(set(E.SUPPORT_EFFECT_TYPES.values())) == len(E.SUPPORT_EFFECT_TYPES))

check("support effect types are still flagged unverified",
      E.SUPPORT_EFFECT_UNVERIFIED is True,
      "flip this only once the values are checked against real training numbers")

# --- inspirations ----------------------------------------------------------

check("three inspiration events", len(E.INSPIRATION_EVENTS) == 3)

check("inspiration turns are strictly increasing",
      all(a["turn"] < b["turn"] for a, b in
          zip(E.INSPIRATION_EVENTS, E.INSPIRATION_EVENTS[1:])))

check("the first inspiration is before turn 1 (the legacy screen)",
      E.INSPIRATION_EVENTS[0]["turn"] == 0)

check("blue spark gain rises with stars",
      list(E.BLUE_SPARK_STAT_GAIN.values()) ==
      sorted(E.BLUE_SPARK_STAT_GAIN.values()))

# --- square types ----------------------------------------------------------

check("square type names cover every square type constant",
      set(E.SQUARE_TYPE_NAMES) == {
          E.SQUARE_TYPE_TECHNIQUE_STAT, E.SQUARE_TYPE_TECHNIQUE_HINT,
          E.SQUARE_TYPE_TECHNIQUE_ENERGY, E.SQUARE_TYPE_SONG})

check("square type names are distinct",
      len(set(E.SQUARE_TYPE_NAMES.values())) == len(E.SQUARE_TYPE_NAMES))


print()
if failures:
    print(f"{len(failures)} check(s) failed: {', '.join(failures)}")
    sys.exit(1)
print("all self-checks passed")
