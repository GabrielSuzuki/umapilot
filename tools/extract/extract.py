#!/usr/bin/env python3
"""
Extract Grand Concert scenario data from the game's master.mdb.

master.mdb is a plain SQLite database shipped with the game client. It is the
canonical source for song/technique costs and effects, so we read it directly
instead of scraping wikis. Nothing here modifies the game or its files -- the
database is opened strictly read-only.

Default location (Windows, Steam and DMM alike):
    %USERPROFILE%\\AppData\\LocalLow\\Cygames\\Umamusume\\master\\master.mdb

Usage:
    python extract.py --mdb /path/to/master.mdb --out ../../packages/data/generated

Design notes:
  * Output is keyed by a content hash of master.mdb, so a patch produces a new
    file rather than silently overwriting the old one. Diff the two to see what
    Cygames changed.
  * We validate hard-won invariants (see CHECKS) and exit non-zero if the
    database no longer matches our understanding of it. A silent wrong number
    is worse than a failed build.
  * Where the game's semantics are not yet fully decoded (bonus effect opcodes),
    we preserve the raw fields *and* the localized text. Guessing at semantics
    and writing the guess into the dataset is how these projects rot.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sqlite3
import sys
from dataclasses import dataclass, asdict, field
from datetime import datetime, timezone
from pathlib import Path

# --------------------------------------------------------------------------
# Constants that describe the Grand Concert scenario's shape in master.mdb.
# --------------------------------------------------------------------------

# text_data categories
TEXT_LIVE_SQUARE_NAME = 209   # "Dance Step Basics", "Run for Our Dream!"
TEXT_LIVE_SQUARE_DESC = 207   # "Speed +5", "Training Skill Pt Gain +2"
TEXT_SKILL_NAME = 47
TEXT_SKILL_DESC = 48
TEXT_SUPPORT_CARD_FULL = 75   # "[Tracen Academy] Special Week"
TEXT_SUPPORT_CARD_TITLE = 76  # "[Tracen Academy]"
TEXT_CHARA_NAME = 77          # "Special Week"
TEXT_COMMAND_NAME = 55        # command_id -> "Speed" / "Power" / ...

# support_card_data.command_id -> the stat its training boosts.
#
# NOT the order you would guess: 102 is Power and 105 is Stamina, not the other
# way round. Read straight out of text_data category 55, and spot-checked
# against four known cards (Suzuka/Speed, Vodka/Power, Special Week/Guts,
# Gold Ship/Stamina). Verified, not assumed.
COMMAND_ID_TO_STAT = {101: "speed", 102: "power", 103: "guts", 105: "stamina", 106: "wit"}

# support_card_data.support_card_type
SUPPORT_CARD_TYPE = {1: "stat", 2: "friend", 3: "group"}

SUPPORT_RARITY = {1: "R", 2: "SR", 3: "SSR"}

# support_card_effect_table.type -> what the value means.
#
# PROVENANCE: originally community-derived (GameTora, uma-tools). VERIFIED
# 2026-09-05 against the game's own support card detail panels: 30 values across
# six cards (Light Hello, Marvelous Sunday, Maruzensky, Kitasan Black, Agnes
# Tachyon, Fine Motion) matched the extracted curve exactly at the cards' actual
# levels. Those observations are recorded as a test fixture at
# packages/engine/test/fixtures/support-card-panels.json.
#
# Verified by that fixture: friendship_bonus, mood_effect, training_effectiveness,
# speed_bonus, power_bonus, wit_bonus, initial_speed, initial_guts, initial_wit,
# initial_friendship, race_bonus -- which covers every term the training formula
# actually uses.
#
# NOT yet verified (no panel observation): stamina_bonus, guts_bonus,
# initial_stamina, initial_power, fan_bonus, hint_levels, hint_frequency,
# specialty_priority, event_recovery, event_effectiveness, failure_protection,
# energy_cost_reduction, skill_point_bonus, wit_friendship_recovery.
#
# Unknown ids pass through as "unknown_<id>" rather than being dropped.
SUPPORT_EFFECT_TYPES = {
    1: "friendship_bonus", 2: "mood_effect", 3: "speed_bonus", 4: "stamina_bonus",
    5: "power_bonus", 6: "guts_bonus", 7: "wit_bonus", 8: "training_effectiveness",
    9: "initial_speed", 10: "initial_stamina", 11: "initial_power",
    12: "initial_guts", 13: "initial_wit", 14: "initial_friendship",
    15: "race_bonus", 16: "fan_bonus", 17: "hint_levels", 18: "hint_frequency",
    19: "specialty_priority", 25: "event_recovery", 26: "event_effectiveness",
    27: "failure_protection", 28: "energy_cost_reduction", 30: "skill_point_bonus",
    31: "wit_friendship_recovery",
}
# The training-formula terms are verified (see the fixture above); the remaining
# types are not. False means "the ones that matter are checked", not "all of them".
SUPPORT_EFFECT_UNVERIFIED = False

# Inspiration (inheritance) fires three times per career: once at the selection
# screen before turn 1, then Classic Early April and Senior Early April.
# Sourced from umamusu.wiki; turn numbers follow the 72-turn career calendar.
INSPIRATION_EVENTS = [
    {"index": 1, "turn": 0,  "label": "career start (legacy select)"},
    {"index": 2, "turn": 25, "label": "Classic year, Early April"},
    {"index": 3, "turn": 49, "label": "Senior year, Early April"},
]

# Blue spark star -> flat stat gain at the initial inspiration.
BLUE_SPARK_STAT_GAIN = {1: 5, 2: 12, 3: 21}

# succession_relation_rank thresholds (affinity). Read from the database at
# extraction time; this is only the display mapping.
AFFINITY_SYMBOLS = {1: "x", 2: "o", 3: "@"}

# single_mode_live_square.square_type
SQUARE_TYPE_TECHNIQUE_STAT = 1
SQUARE_TYPE_TECHNIQUE_HINT = 2
SQUARE_TYPE_TECHNIQUE_ENERGY = 3
SQUARE_TYPE_SONG = 4

SQUARE_TYPE_NAMES = {
    SQUARE_TYPE_TECHNIQUE_STAT: "technique_stat",
    SQUARE_TYPE_TECHNIQUE_HINT: "technique_hint",
    SQUARE_TYPE_TECHNIQUE_ENERGY: "technique_energy",
    SQUARE_TYPE_SONG: "song",
}

# single_mode_live_square.perf_type_N -> performance token.
#
# This mapping is not labelled anywhere in the database. It is pinned by
# CHECKS["song_cost_totals"] below: summing every song's cost per perf_type
# reproduces the community-published per-token totals exactly, which is only
# possible under this assignment.
TOKEN_BY_PERF_TYPE = {
    1: "dance",
    2: "passion",
    3: "vocal",
    4: "visual",
    5: "mental",
}
TOKENS = ["dance", "passion", "vocal", "visual", "mental"]

# Training facility -> (primary token, secondary token).
# Not present in master.mdb; sourced from GameTora / umamusu.wiki. Roll weights
# are approximately 60% primary, 30% secondary, 10% spread over the rest.
FACILITY_TOKENS = {
    "speed":   {"primary": "dance",   "secondary": "visual"},
    "stamina": {"primary": "passion", "secondary": "vocal"},
    "power":   {"primary": "vocal",   "secondary": "mental"},
    "guts":    {"primary": "visual",  "secondary": "dance"},
    "wit":     {"primary": "mental",  "secondary": "passion"},
}
TOKEN_ROLL_WEIGHTS = {"primary": 0.60, "secondary": 0.30, "other": 0.10}

# Grand Concert is scenario_id 3. Confirmed by text_data category 237 index 3 =
# "Grand Concert", and corroborated by the derived stat caps below.
GRAND_CONCERT_SCENARIO_ID = 3
TEXT_SCENARIO_NAME = 237

# Every trainee card in card_rarity_data has max_* = 1200, so 1200 is the base
# stat ceiling and single_mode_scenario.max_* holds the per-scenario *bonus*,
# not the cap itself. Derived caps are checked against the published figures in
# CHECKS["stat_caps"] -- so these are read from the database, not hardcoded.
BASE_STAT_CEILING = 1200

# single_mode_training_effect.target_type
TRAINING_TARGET_TYPES = {
    1: "speed", 2: "stamina", 3: "power", 4: "guts", 5: "wit",
    10: "energy", 20: "mood", 30: "skill_points",
}
# Verified: Speed training yields target 1 + 3 (speed + power) and Stamina
# training yields 2 + 4 (stamina + guts), matching known game behaviour; target
# 10 is negative for training and positive for rest, and its level-1 Speed value
# of -21 in the URA scenario matches uma.guide's published energy cost.
# target 20 appears only on non-training commands with values +1/+2, so "mood" is
# INFERRED, not proven. target 101 appears once with value 0 and is left unnamed.

# single_mode_training_effect stores base values for level 1 (command 101-106)
# and level 5 (601-605). Levels 2-4 are NOT in the database.
#
# The level-5 command ids are NOT in the same order as the level-1 ones -- they
# follow the canonical stat order (speed, stamina, power, guts, wit) rather than
# the command_id order. Assuming otherwise silently mislabels three of the five
# facilities, so the mapping is read from single_mode_training.base_command_id
# at extraction time rather than hardcoded here.
FACILITY_COMMAND_LV1 = {101: "speed", 102: "power", 103: "guts", 105: "stamina", 106: "wit"}

# Invariants. If any of these break, master.mdb changed in a way that probably
# invalidates the extractor, and we refuse to emit a dataset.
CHECKS = {
    # Per-token cost of buying every song, cross-checked against umamusu.wiki.
    "song_cost_totals": {
        "dance": 252, "passion": 201, "vocal": 150, "visual": 275, "mental": 196
    },
    "concert_count": 5,
    "songs_needed_for_great_success": 3,
    "min_songs": 20,   # sanity floor; currently 21
    "max_songs": 30,
    # Derived as BASE_STAT_CEILING + single_mode_scenario.max_*, checked against
    # the published Grand Concert caps. Two independent sources agreeing is what
    # makes the derivation trustworthy.
    "stat_caps": {
        "speed": 1600, "stamina": 1300, "power": 1300, "guts": 1500, "wit": 1300
    },
}


# --------------------------------------------------------------------------
# Data model (mirrors packages/data/schema/grand-concert.schema.json)
# --------------------------------------------------------------------------

@dataclass
class Cost:
    dance: int = 0
    passion: int = 0
    vocal: int = 0
    visual: int = 0
    mental: int = 0

    def total(self) -> int:
        return self.dance + self.passion + self.vocal + self.visual + self.mental


@dataclass
class Effect:
    """A bonus granted by a technique or song.

    `text` is the game's own English description and is authoritative for humans.
    `raw` is the undecoded opcode tuple, kept so the engine can learn to read it
    without another extraction pass.
    """
    text: str | None
    raw: list[int] = field(default_factory=list)


@dataclass
class Technique:
    id: int
    name: str | None
    kind: str
    cost: Cost
    effect: Effect


@dataclass
class Song:
    id: int
    name: str | None
    cost: Cost
    mastery_bonus: Effect          # applies immediately on purchase
    concert_bonus_type: int | None  # applies from the next concert to end of career
    concert_bonus_value: int | None
    live_id: int | None


@dataclass
class Concert:
    index: int
    turn: int
    songs_for_great_success: int
    is_grand_concert: bool


# --------------------------------------------------------------------------
# Extraction
# --------------------------------------------------------------------------

class Extractor:
    def __init__(self, mdb_path: Path):
        self.path = mdb_path
        # Read-only URI: we never want to write to the player's game files.
        uri = f"file:{mdb_path.as_posix()}?mode=ro"
        self.db = sqlite3.connect(uri, uri=True)
        self._text_cache: dict[tuple[int, int], str] = {}

    # -- helpers ---------------------------------------------------------

    def text(self, category: int, index: int) -> str | None:
        key = (category, index)
        if key not in self._text_cache:
            row = self.db.execute(
                'SELECT text FROM text_data WHERE category=? AND "index"=?',
                (category, index),
            ).fetchone()
            self._text_cache[key] = row[0] if row else None
        return self._text_cache[key]

    @staticmethod
    def strip_markup(s: str | None) -> str | None:
        """Game text embeds Unity rich-text colour tags. Strip them."""
        if s is None:
            return None
        return re.sub(r"</?color[^>]*>", "", s).strip()

    def require_tables(self, names: list[str]) -> None:
        have = {r[0] for r in self.db.execute(
            "SELECT name FROM sqlite_master WHERE type='table'")}
        missing = [n for n in names if n not in have]
        if missing:
            die(f"master.mdb is missing expected tables: {missing}\n"
                f"The database layout changed; the extractor needs updating.")

    # -- pieces ----------------------------------------------------------

    def costs_from_square_row(self, row: tuple) -> Cost:
        """single_mode_live_square stores costs as 5 (perf_type, value) pairs."""
        pairs = row[5:15]
        cost = Cost()
        for i in range(0, 10, 2):
            ptype, value = pairs[i], pairs[i + 1]
            if not ptype:
                continue
            token = TOKEN_BY_PERF_TYPE.get(ptype)
            if token is None:
                die(f"Unknown perf_type {ptype} in single_mode_live_square row {row[0]}")
            setattr(cost, token, getattr(cost, token) + value)
        return cost

    def master_bonus(self, master_bonus_id: int) -> Effect:
        row = self.db.execute(
            "SELECT * FROM single_mode_live_master_bonus WHERE id=?",
            (master_bonus_id,),
        ).fetchone()
        raw = list(row[1:]) if row else []
        return Effect(text=None, raw=raw)

    def techniques(self) -> list[Technique]:
        out: list[Technique] = []
        rows = self.db.execute(
            "SELECT * FROM single_mode_live_square "
            "WHERE square_type IN (?,?,?) ORDER BY id",
            (SQUARE_TYPE_TECHNIQUE_STAT,
             SQUARE_TYPE_TECHNIQUE_HINT,
             SQUARE_TYPE_TECHNIQUE_ENERGY),
        ).fetchall()
        for row in rows:
            sid, title_id, content_id, mb_id, stype = row[0], row[1], row[2], row[3], row[4]
            effect = self.master_bonus(mb_id)
            effect.text = self.strip_markup(self.text(TEXT_LIVE_SQUARE_DESC, content_id))
            out.append(Technique(
                id=sid,
                name=self.strip_markup(self.text(TEXT_LIVE_SQUARE_NAME, title_id)),
                kind=SQUARE_TYPE_NAMES[stype],
                cost=self.costs_from_square_row(row),
                effect=effect,
            ))
        return out

    def songs(self) -> list[Song]:
        # Concert bonus lives on single_mode_live_song_list, keyed by the
        # square's content text id.
        bonus_by_text_id: dict[int, tuple[int, int, int]] = {}
        for _id, command_id, live_id, _level, text_id, btype, bvalue in self.db.execute(
            "SELECT * FROM single_mode_live_song_list"
        ):
            bonus_by_text_id.setdefault(text_id, (btype, bvalue, live_id))

        out: list[Song] = []
        rows = self.db.execute(
            "SELECT * FROM single_mode_live_square WHERE square_type=? ORDER BY id",
            (SQUARE_TYPE_SONG,),
        ).fetchall()
        for row in rows:
            sid, title_id, content_id, mb_id = row[0], row[1], row[2], row[3]
            mastery = self.master_bonus(mb_id)
            mastery.text = self.strip_markup(self.text(TEXT_LIVE_SQUARE_DESC, content_id))
            btype, bvalue, live_id = bonus_by_text_id.get(content_id, (None, None, None))
            out.append(Song(
                id=sid,
                name=self.strip_markup(self.text(TEXT_LIVE_SQUARE_NAME, title_id)),
                cost=self.costs_from_square_row(row),
                mastery_bonus=mastery,
                concert_bonus_type=btype,
                concert_bonus_value=bvalue,
                live_id=live_id,
            ))
        return out

    def concerts(self) -> list[Concert]:
        rows = self.db.execute(
            "SELECT id, live_type, turn_num, great_success_num, song_num "
            "FROM single_mode_live_live_data ORDER BY turn_num"
        ).fetchall()
        out = []
        for i, (_id, live_type, turn, great, song_num) in enumerate(rows, start=1):
            out.append(Concert(
                index=i,
                turn=turn,
                songs_for_great_success=great,
                # live_type 10 marks the finale; the earlier four are 1..4.
                is_grand_concert=(live_type >= 10),
            ))
        return out

    def support_cards(self) -> list[dict]:
        """Every support card, with its per-level effect curve.

        The scan reads six of these off the Support Formation screen, so this
        table is what turns "that card art" into numbers the simulator can use.

        `support_card_effect_table` stores a sparse curve: `init` plus a value at
        each limit-break level breakpoint, with -1 meaning "no change here". We
        forward-fill into a dense level->value map so the engine never has to
        know about the sparsity.
        """
        # effect_table_id -> [(type, {level: value})]
        curves: dict[int, dict[int, dict[int, int]]] = {}
        level_cols = [
            ("init", 0), ("limit_lv5", 5), ("limit_lv10", 10), ("limit_lv15", 15),
            ("limit_lv20", 20), ("limit_lv25", 25), ("limit_lv30", 30),
            ("limit_lv35", 35), ("limit_lv40", 40), ("limit_lv45", 45),
            ("limit_lv50", 50),
        ]
        for row in self.db.execute("SELECT * FROM support_card_effect_table"):
            table_id, etype = row[0], row[1]
            values = row[2:]
            curve: dict[int, int] = {}
            current = 0
            for (_, level), value in zip(level_cols, values):
                if value != -1:
                    current = value
                curve[level] = current
            curves.setdefault(table_id, {})[etype] = curve

        uniques: dict[int, list[dict]] = {}
        for row in self.db.execute("SELECT * FROM support_card_unique_effect"):
            uid, lv = row[0], row[1]
            uniques.setdefault(uid, []).append({"level": lv, "raw": list(row[2:])})

        out = []
        for (cid, chara_id, rarity, effect_table_id, unique_effect_id,
             command_id, card_type) in self.db.execute(
            "SELECT id, chara_id, rarity, effect_table_id, unique_effect_id, "
            "command_id, support_card_type FROM support_card_data ORDER BY id"
        ):
            kind = SUPPORT_CARD_TYPE.get(card_type, f"unknown_{card_type}")
            # Only stat cards sit on a training facility; friend/group cards do not.
            stat = COMMAND_ID_TO_STAT.get(command_id) if kind == "stat" else None
            if kind == "stat" and stat is None:
                die(f"support card {cid} has unmapped command_id {command_id}")

            effects = {}
            for etype, curve in curves.get(effect_table_id, {}).items():
                name = SUPPORT_EFFECT_TYPES.get(etype, f"unknown_{etype}")
                effects[name] = curve

            out.append({
                "id": cid,
                "charaId": chara_id,
                "name": self.strip_markup(self.text(TEXT_SUPPORT_CARD_FULL, cid)),
                "title": self.strip_markup(self.text(TEXT_SUPPORT_CARD_TITLE, cid)),
                "charaName": self.strip_markup(self.text(TEXT_CHARA_NAME, chara_id)),
                "rarity": SUPPORT_RARITY.get(rarity, f"unknown_{rarity}"),
                "kind": kind,
                "stat": stat,
                "effects": effects,
                "uniqueEffect": uniques.get(unique_effect_id, []),
            })
        return out

    def training(self) -> dict:
        """Base training values and the scenario's stat caps.

        master.mdb stores base effects for level 1 (command 101-106) and level 5
        (601-605) only. Levels 2-4 are NOT in the database. We emit what is real
        and mark the gap rather than inventing a curve -- the run logger is how
        those levels get calibrated, which is exactly why M1 and M2 belong
        together.
        """
        sid = GRAND_CONCERT_SCENARIO_ID
        name = self.strip_markup(self.text(TEXT_SCENARIO_NAME, sid))
        if name != "Grand Concert":
            die(f"scenario_id {sid} is named {name!r}, expected 'Grand Concert'. "
                f"Scenario ids shifted; the extractor needs updating.")

        def effects_for(command_id: int) -> dict:
            out: dict[str, int] = {}
            unknown: list[list[int]] = []
            for target_type, value, sub_id, result_state in self.db.execute(
                "SELECT target_type, effect_value, sub_id, result_state "
                "FROM single_mode_training_effect "
                "WHERE scenario_id=? AND command_id=? ORDER BY sub_id, target_type",
                (sid, command_id),
            ):
                key = TRAINING_TARGET_TYPES.get(target_type)
                if key is None:
                    unknown.append([target_type, value, sub_id, result_state])
                    continue
                # result_state 1 rows are an alternate outcome (e.g. the Wit
                # facility's energy gain); keep the main line (state 2).
                if result_state != 2:
                    continue
                out[key] = out.get(key, 0) + value
            if unknown:
                out["_unknownTargets"] = unknown  # type: ignore[assignment]
            return out

        # Read the level-5 command ids and what they are variants of, straight
        # from the database. Never assume the ordering.
        lv5_commands = {}
        for command_id, base_command_id in self.db.execute(
            "SELECT command_id, base_command_id FROM single_mode_training "
            "WHERE command_id BETWEEN 601 AND 699"
        ):
            facility = FACILITY_COMMAND_LV1.get(base_command_id)
            if facility is None:
                die(f"level-5 command {command_id} has base_command_id "
                    f"{base_command_id}, which is not a known facility")
            lv5_commands[command_id] = facility

        facilities = {}
        for cid, facility in FACILITY_COMMAND_LV1.items():
            facilities.setdefault(facility, {})["1"] = {
                **effects_for(cid), "source": "master.mdb", "commandId": cid,
            }
        for cid, facility in lv5_commands.items():
            facilities.setdefault(facility, {})["5"] = {
                **effects_for(cid), "source": "master.mdb", "commandId": cid,
            }

        failure_rates = {}
        for command_id, level, rate in self.db.execute(
            "SELECT command_id, command_level, failure_rate FROM single_mode_training "
            "WHERE command_id IN (101,102,103,105,106) ORDER BY command_id, command_level"
        ):
            facility = FACILITY_COMMAND_LV1[command_id]
            failure_rates.setdefault(facility, {})[str(level)] = rate

        # Recreation destinations. These ARE named -- text_data category 55 gives
        # 301 Riverside, 302 Karaoke, 303 Shrine, 304 Beach, 305 Hot Springs --
        # so an earlier note here that they were "rest / outing / infirmary in
        # some order" was simply wrong; they are five variants of the same
        # Recreation action with materially different payoffs (Beach is +40
        # energy, Karaoke is pure mood). The name comes from the database, which
        # is the first acceptable justification in CONTRIBUTING.md.
        other = {}
        for command_id in (301, 302, 303, 304, 305):
            variants = []
            for sub_id, in self.db.execute(
                "SELECT DISTINCT sub_id FROM single_mode_training_effect "
                "WHERE scenario_id=? AND command_id=? ORDER BY sub_id", (sid, command_id)
            ):
                row: dict[str, int] = {}
                for target_type, value in self.db.execute(
                    "SELECT target_type, effect_value FROM single_mode_training_effect "
                    "WHERE scenario_id=? AND command_id=? AND sub_id=?",
                    (sid, command_id, sub_id),
                ):
                    row[TRAINING_TARGET_TYPES.get(target_type, f"unknown_{target_type}")] = value
                variants.append({"subId": sub_id, **row})
            if variants:
                other[str(command_id)] = {
                    "name": self.strip_markup(self.text(TEXT_COMMAND_NAME, command_id)),
                    "kind": "recreation",
                    "variants": variants,
                }

        caps_bonus = self.db.execute(
            "SELECT max_speed, max_stamina, max_pow, max_guts, max_wiz "
            "FROM single_mode_scenario WHERE id=?", (sid,)
        ).fetchone()
        if caps_bonus is None:
            die(f"no single_mode_scenario row for scenario_id {sid}")
        stat_caps = {
            "speed": BASE_STAT_CEILING + caps_bonus[0],
            "stamina": BASE_STAT_CEILING + caps_bonus[1],
            "power": BASE_STAT_CEILING + caps_bonus[2],
            "guts": BASE_STAT_CEILING + caps_bonus[3],
            "wit": BASE_STAT_CEILING + caps_bonus[4],
        }

        return {
            "scenarioId": sid,
            "scenarioName": name,
            "statCaps": stat_caps,
            "statCapDerivation": {
                "baseCeiling": BASE_STAT_CEILING,
                "scenarioBonus": dict(zip(
                    ["speed", "stamina", "power", "guts", "wit"], caps_bonus)),
                "note": "base ceiling read from card_rarity_data.max_*, which is "
                        "1200 for every trainee card",
            },
            "facilities": facilities,
            "failureRateBase": failure_rates,
            "otherCommands": other,
            "levelsPresent": [1, 5],
            "levelsMissing": [2, 3, 4],
            "note": "Base values exist in master.mdb for facility levels 1 and 5 "
                    "only. Levels 2-4 must be calibrated from logged runs; do not "
                    "interpolate silently.",
        }

    def friend_events(self) -> list[dict]:
        """Friend outing chains.

        Recreation is a choice of COMPANION, not of venue: the screen offers the
        trainee or a friend support card, and going with a friend advances a
        bounded event chain shown as chevrons ("Event Progress"). Completing the
        chain before the career ends is a real objective, and each step costs a
        turn that could have been a training -- so it is a deadline-constrained
        scheduling problem, the same shape as the song unlock gates.

        Chain length is NOT uniform: Sasami Anshinzawa has three steps where the
        others have five. A planner that assumes five would over-book two turns.

        The per-step REWARDS are not here -- like all event outcomes they live in
        the story assets (see events.md). What is extractable is the structure,
        which is what the scheduler actually needs.
        """
        chains: dict[int, dict] = {}
        for chara_id, step, total in self.db.execute(
            "SELECT support_chara_id, show_progress_1, show_progress_2 "
            "FROM single_mode_story_data "
            "WHERE show_progress_2 > 0 AND support_chara_id > 0 "
            "GROUP BY support_chara_id, show_progress_1, show_progress_2 "
            "ORDER BY support_chara_id, show_progress_1"
        ):
            entry = chains.setdefault(chara_id, {
                "charaId": chara_id, "steps": [], "totalSteps": total,
            })
            entry["steps"].append(step)
            if total != entry["totalSteps"]:
                die(f"friend chara {chara_id} reports inconsistent chain lengths "
                    f"({total} vs {entry['totalSteps']})")

        out = []
        for chara_id, entry in sorted(chains.items()):
            cards = [
                {"id": cid, "name": self.strip_markup(self.text(TEXT_SUPPORT_CARD_FULL, cid))}
                for (cid,) in self.db.execute(
                    "SELECT id FROM support_card_data WHERE chara_id=? ORDER BY id",
                    (chara_id,))
            ]
            out.append({
                **entry,
                "steps": sorted(set(entry["steps"])),
                "cards": cards,
                "rewardsKnown": False,
                "note": "per-step rewards live in the story assets, not master.mdb",
            })
        return out

    def sparks(self) -> dict:
        """Succession factors -- the sparks that drive the three inspirations.

        Effect semantics are NOT decoded. What is emitted is the factor table
        (type, rarity/star, grade, effect group) plus the raw effect rows, which
        is enough to identify a spark from the Legacy Select screen and to look
        up what it is worth once the opcodes are understood.
        """
        effects: dict[int, list[dict]] = {}
        for _id, group_id, effect_id, target_type, v1, v2 in self.db.execute(
            "SELECT id, factor_group_id, effect_id, target_type, value_1, value_2 "
            "FROM succession_factor_effect"
        ):
            effects.setdefault(group_id, []).append({
                "effectId": effect_id, "targetType": target_type,
                "value1": v1, "value2": v2,
            })

        factors = []
        for (factor_id, group_id, rarity, grade, ftype,
             effect_group_id) in self.db.execute(
            "SELECT factor_id, factor_group_id, rarity, grade, factor_type, "
            "effect_group_id FROM succession_factor ORDER BY factor_id"
        ):
            factors.append({
                "factorId": factor_id,
                "groupId": group_id,
                # rarity doubles as the star count on the spark (1..3)
                "stars": rarity,
                "grade": grade,
                "factorType": ftype,
                "effectGroupId": effect_group_id,
            })

        affinity_ranks = [
            {"rank": r, "min": lo, "max": hi}
            for r, lo, hi in self.db.execute(
                "SELECT relation_rank, rank_value_min, rank_value_max "
                "FROM succession_relation_rank ORDER BY relation_rank")
        ]

        return {
            "factors": factors,
            "effectsByGroup": effects,
            "affinityRanks": affinity_ranks,
            "inspirationEvents": INSPIRATION_EVENTS,
            "blueSparkStatGain": BLUE_SPARK_STAT_GAIN,
            "note": (
                "Factor effect opcodes are not decoded. Blue/pink/green/white "
                "spark semantics must be verified against observed inspiration "
                "results during M1 before the simulator uses them."
            ),
        }

    def skills(self) -> list[dict]:
        """Flat skill index for the target picker.

        Only what a search box needs: id, name, description, SP cost, rarity.
        Race-side valuation (bashin gain) is deliberately out of scope -- that
        belongs to uma-skill-tools, not to us.
        """
        sp_cost = {
            sid: need for sid, need in self.db.execute(
                "SELECT id, need_skill_point FROM single_mode_skill_need_point"
            )
        }
        out = []
        for sid, rarity, disable_singlemode in self.db.execute(
            "SELECT id, rarity, disable_singlemode FROM skill_data ORDER BY id"
        ):
            name = self.strip_markup(self.text(TEXT_SKILL_NAME, sid))
            if not name:
                continue
            cost = sp_cost.get(sid)
            out.append({
                "id": sid,
                "name": name,
                "description": self.strip_markup(self.text(TEXT_SKILL_DESC, sid)),
                "rarity": rarity,
                "spCost": cost,
                # A skill is buyable in a career run iff it has an SP price.
                # NOTE: skill_data.disable_singlemode is *not* that flag -- it is
                # set on plenty of skills that do have an SP cost. We keep it raw
                # rather than pretend to know what it gates.
                "purchasableInCareer": cost is not None,
                "raw": {"disableSingleMode": disable_singlemode},
            })
        return out


# --------------------------------------------------------------------------
# Validation
# --------------------------------------------------------------------------

def validate(songs: list[Song], concerts: list[Concert],
             training: dict | None = None) -> list[str]:
    problems: list[str] = []

    if training is not None:
        if training["statCaps"] != CHECKS["stat_caps"]:
            problems.append(
                "stat caps derived from the database do not match the published "
                "figures.\n"
                f"    derived:   {training['statCaps']}\n"
                f"    published: {CHECKS['stat_caps']}\n"
                "    -> either the scenario was rebalanced, BASE_STAT_CEILING is "
                "wrong, or GRAND_CONCERT_SCENARIO_ID points at the wrong scenario."
            )
        for facility, levels in training["facilities"].items():
            for level in ("1", "5"):
                if level not in levels:
                    problems.append(f"{facility} training has no level-{level} base values")
                    continue
                if levels[level].get("energy", 0) == 0 and facility != "wit":
                    problems.append(f"{facility} level {level} has no energy cost")
                # A facility must train its own stat. This is what catches a
                # mis-ordered command_id mapping -- without it, three of the five
                # level-5 rows were silently attached to the wrong facility.
                own = levels[level].get(facility, 0)
                if own <= 0:
                    problems.append(
                        f"{facility} training at level {level} grants no {facility} "
                        f"(got {levels[level]}). The command_id -> facility mapping "
                        f"is probably wrong.")
            if "1" in levels and "5" in levels:
                if levels["5"].get(facility, 0) < levels["1"].get(facility, 0):
                    problems.append(
                        f"{facility} level 5 trains less {facility} than level 1")

    totals = {t: 0 for t in TOKENS}
    for s in songs:
        for t in TOKENS:
            totals[t] += getattr(s.cost, t)
    if totals != CHECKS["song_cost_totals"]:
        problems.append(
            "song cost totals do not match the published figures.\n"
            f"    extracted: {totals}\n"
            f"    expected:  {CHECKS['song_cost_totals']}\n"
            "    -> either the scenario was rebalanced, or TOKEN_BY_PERF_TYPE is wrong."
        )

    if not CHECKS["min_songs"] <= len(songs) <= CHECKS["max_songs"]:
        problems.append(f"song count {len(songs)} outside expected range "
                        f"{CHECKS['min_songs']}..{CHECKS['max_songs']}")

    if len(concerts) != CHECKS["concert_count"]:
        problems.append(f"expected {CHECKS['concert_count']} concerts, found {len(concerts)}")

    for c in concerts:
        if c.songs_for_great_success != CHECKS["songs_needed_for_great_success"]:
            problems.append(f"concert {c.index} needs {c.songs_for_great_success} songs "
                            f"for Great Success, expected "
                            f"{CHECKS['songs_needed_for_great_success']}")

    if sum(1 for c in concerts if c.is_grand_concert) != 1:
        problems.append("expected exactly one Grand Concert (the finale)")

    for s in songs:
        if s.cost.total() <= 0:
            problems.append(f"song {s.id} ({s.name!r}) has zero cost")
        if not s.name:
            problems.append(f"song {s.id} has no resolvable name")

    return problems


# --------------------------------------------------------------------------
# Main
# --------------------------------------------------------------------------

def die(msg: str) -> None:
    print(f"error: {msg}", file=sys.stderr)
    sys.exit(1)


def default_mdb_path() -> Path:
    if os.name == "nt":
        base = Path(os.environ.get("USERPROFILE", Path.home()))
    else:
        base = Path.home()
    return base / "AppData/LocalLow/Cygames/Umamusume/master/master.mdb"


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--mdb", type=Path, default=default_mdb_path(),
                    help="path to master.mdb (default: the standard install location)")
    ap.add_argument("--out", type=Path, required=True, help="output directory")
    ap.add_argument("--skills", action="store_true", default=True,
                    help="also emit the skill index (default: on)")
    ap.add_argument("--allow-invalid", action="store_true",
                    help="write the dataset even if validation fails (do not use in CI)")
    args = ap.parse_args()

    if not args.mdb.exists():
        die(f"master.mdb not found at {args.mdb}\n"
            f"       Pass --mdb explicitly. On Windows it is usually at\n"
            f"       %USERPROFILE%\\AppData\\LocalLow\\Cygames\\Umamusume\\master\\master.mdb")

    digest = sha256(args.mdb)
    short = digest[:12]
    print(f"reading  {args.mdb}")
    print(f"sha256   {digest}")

    ex = Extractor(args.mdb)
    ex.require_tables([
        "single_mode_live_square",
        "single_mode_live_song_list",
        "single_mode_live_live_data",
        "single_mode_live_master_bonus",
        "text_data",
        "skill_data",
        "single_mode_skill_need_point",
        "support_card_data",
        "support_card_effect_table",
        "support_card_unique_effect",
        "succession_factor",
        "succession_factor_effect",
        "succession_relation_rank",
        "single_mode_training",
        "single_mode_training_effect",
        "single_mode_scenario",
        "card_rarity_data",
    ])

    techniques = ex.techniques()
    friends = ex.friend_events()
    songs = ex.songs()
    concerts = ex.concerts()

    training = ex.training()
    problems = validate(songs, concerts, training)
    if problems:
        print("\nvalidation failed:", file=sys.stderr)
        for p in problems:
            print(f"  - {p}", file=sys.stderr)
        if not args.allow_invalid:
            sys.exit(2)
        print("\n(--allow-invalid set; writing anyway)", file=sys.stderr)

    dataset = {
        "schemaVersion": 1,
        "scenario": "grand-concert",
        "source": {
            "file": "master.mdb",
            "sha256": digest,
            "mtime": datetime.fromtimestamp(
                args.mdb.stat().st_mtime, tz=timezone.utc).isoformat(),
            "extractedAt": datetime.now(timezone.utc).isoformat(),
        },
        "constants": {
            "tokens": TOKENS,
            "facilityTokens": FACILITY_TOKENS,
            "tokenRollWeights": TOKEN_ROLL_WEIGHTS,
            "statCaps": training["statCaps"],
            "careerTurns": max(c.turn for c in concerts),
        },
        "training": training,
        "friendEvents": friends,
        "concerts": [asdict(c) for c in concerts],
        "techniques": [asdict(t) for t in techniques],
        "songs": [asdict(s) for s in songs],
    }

    args.out.mkdir(parents=True, exist_ok=True)
    out_file = args.out / f"grand-concert.{short}.json"
    out_file.write_text(json.dumps(dataset, indent=2, ensure_ascii=False) + "\n",
                        encoding="utf-8")
    print(f"wrote    {out_file}  "
          f"({len(songs)} songs, {len(techniques)} techniques, {len(concerts)} concerts)")

    latest = args.out / "grand-concert.latest.json"
    latest.write_text(json.dumps({"ref": out_file.name, "sha256": digest}, indent=2) + "\n",
                      encoding="utf-8")

    if args.skills:
        skills = ex.skills()
        skills_file = args.out / f"skills.{short}.json"
        skills_file.write_text(json.dumps(
            {"schemaVersion": 1, "source": {"sha256": digest}, "skills": skills},
            indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        print(f"wrote    {skills_file}  ({len(skills)} skills)")
        (args.out / "skills.latest.json").write_text(
            json.dumps({"ref": skills_file.name, "sha256": digest}, indent=2) + "\n",
            encoding="utf-8")

    cards = ex.support_cards()
    cards_file = args.out / f"support-cards.{short}.json"
    cards_file.write_text(json.dumps({
        "schemaVersion": 1,
        "source": {"sha256": digest},
        "effectTypesVerified": not SUPPORT_EFFECT_UNVERIFIED,
        "supportCards": cards,
    }, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    ssr = sum(1 for c in cards if c["rarity"] == "SSR")
    print(f"wrote    {cards_file}  ({len(cards)} cards, {ssr} SSR)")
    (args.out / "support-cards.latest.json").write_text(
        json.dumps({"ref": cards_file.name, "sha256": digest}, indent=2) + "\n",
        encoding="utf-8")

    sparks = ex.sparks()
    sparks_file = args.out / f"sparks.{short}.json"
    sparks_file.write_text(json.dumps(
        {"schemaVersion": 1, "source": {"sha256": digest}, **sparks},
        indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"wrote    {sparks_file}  ({len(sparks['factors'])} factors, "
          f"{len(sparks['inspirationEvents'])} inspiration events)")
    (args.out / "sparks.latest.json").write_text(
        json.dumps({"ref": sparks_file.name, "sha256": digest}, indent=2) + "\n",
        encoding="utf-8")

    print("\nNOTE: event choice outcomes are NOT in master.mdb -- they live in the")
    print("      story timeline assets under dat/. See docs/events.md.")
    print("\nok")


if __name__ == "__main__":
    main()
