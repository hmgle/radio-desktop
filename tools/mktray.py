#!/usr/bin/env python3
# /// script
# dependencies = ["cairosvg==2.9.1"]
# ///
"""Render application and tray PNGs from SVG sources.

Run with `uv run tools/mktray.py`. The colored tray stays visible on both
light and dark panels; macOS uses the separate transparent template.
"""
from pathlib import Path

import cairosvg

RESOURCES = Path(__file__).resolve().parent.parent / "resources"

for source, destination, size in (
    ("icon.svg", "icon.png", 1024),
    ("icon.svg", "tray.png", 32),
    ("tray-template.svg", "tray-template.png", 32),
):
    cairosvg.svg2png(
        url=str(RESOURCES / source),
        write_to=str(RESOURCES / destination),
        output_width=size,
        output_height=size,
    )
    print(f"Wrote resources/{destination} ({size}x{size})")
