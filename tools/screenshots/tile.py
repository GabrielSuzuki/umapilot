#!/usr/bin/env python3
"""
Turn a folder of full-screen game captures into compact, readable tiles.

A `Win + PrintScreen` capture of a dual-monitor setup is 3840x1080, of which the
game occupies about 812x1080. Reading 80 of those at full size is wasteful and,
worse, imprecise: at thumbnail scale the training screen's gain badges sit
between stat columns and are easy to attribute to the wrong stat.

So this crops the three regions that actually carry data and stacks them:

  header   turn counter, concert countdown, energy bar, mood badge
  banner   the selected facility and its level ("Wit Lvl 1 / Studying")
  gains    the +N badges and the current stat row
  cards    the support cards on the selected facility, with bond gauges

Usage:
    python tile.py --src "~/OneDrive/Pictures/Screenshots" --out ./tiles

REGIONS ARE RESOLUTION-SPECIFIC. They are calibrated for a 3840x1080 capture
with the game on the right monitor. Run with --probe first on a new setup: it
writes one full game panel so you can re-measure rather than silently cropping
the wrong pixels.
"""

from __future__ import annotations

import argparse
import re
from pathlib import Path

from PIL import Image, ImageDraw

# The game panel within a 3840x1080 dual-monitor capture.
GAME_PANEL = (2068, 0, 2880, 1080)

# Regions within the 812x1080 game panel.
REGIONS = {
    # turn counter, "Concert in N turns", energy bar, mood badge
    "header": (110, 30, 700, 160),
    # selected facility + level, e.g. "Wit Lvl 1 / Studying"
    "banner": (0, 168, 420, 240),
    # +N gain badges and the current stat row
    "gains": (110, 665, 700, 795),
    # support card portraits with bond gauges, on the right edge
    "cards": (676, 140, 812, 700),
}


def game_panel(path: Path) -> Image.Image:
    im = Image.open(path).convert("RGB")
    if im.size == (3840, 1080):
        return im.crop(GAME_PANEL)
    # Single monitor, or a different layout: hand back the whole thing and let
    # the caller notice rather than cropping blind.
    return im


def tile(panel: Image.Image, label: str) -> Image.Image:
    header = panel.crop(REGIONS["header"]).resize((885, 195), Image.LANCZOS)
    banner = panel.crop(REGIONS["banner"]).resize((525, 90), Image.LANCZOS)
    gains = panel.crop(REGIONS["gains"]).resize((885, 195), Image.LANCZOS)
    cards = panel.crop(REGIONS["cards"]).resize((136, 560), Image.LANCZOS)

    out = Image.new("RGB", (1060, 500), "white")
    draw = ImageDraw.Draw(out)
    draw.text((6, 240), label, fill="black")
    out.paste(banner, (40, 4))
    out.paste(header, (30, 100))
    out.paste(gains, (30, 300))
    out.paste(cards, (915, 4))
    draw.line([(0, 499), (1060, 499)], fill="black")
    return out


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--src", required=True, help="folder of screenshots")
    ap.add_argument("--out", required=True, help="folder to write tiles/sheets into")
    ap.add_argument("--per-sheet", type=int, default=6)
    ap.add_argument("--probe", action="store_true",
                    help="write one full game panel and stop, so regions can be re-measured")
    args = ap.parse_args()

    src = Path(args.src).expanduser()
    out = Path(args.out).expanduser()
    out.mkdir(parents=True, exist_ok=True)

    def order(p: Path) -> int:
        m = re.search(r"\((\d+)\)", p.name)
        return int(m.group(1)) if m else 0

    files = sorted([p for p in src.glob("*.png")], key=order)
    if not files:
        raise SystemExit(f"no .png files in {src}")

    if args.probe:
        panel = game_panel(files[0])
        target = out / "probe-panel.png"
        panel.save(target)
        print(f"wrote {target} ({panel.size[0]}x{panel.size[1]})")
        print("Check the regions in REGIONS against this image before tiling.")
        return

    tiles = []
    for p in files:
        label = str(order(p))
        tiles.append(tile(game_panel(p), label))

    for i in range(0, len(tiles), args.per_sheet):
        batch = tiles[i:i + args.per_sheet]
        sheet = Image.new("RGB", (1060, 500 * len(batch)), "white")
        for j, t in enumerate(batch):
            sheet.paste(t, (0, 500 * j))
        target = out / f"sheet{i // args.per_sheet:02d}.png"
        sheet.save(target)
        print(f"wrote {target}  ({len(batch)} captures)")

    print(f"\n{len(tiles)} captures -> {(len(tiles) + args.per_sheet - 1) // args.per_sheet} sheets")


if __name__ == "__main__":
    main()
