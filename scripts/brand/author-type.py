#!/usr/bin/env python3
"""Outlines the brand's lettering from Geist and writes scripts/brand/type.json.

Authoring-time only. The repository build reads the JSON this writes, so neither CI
nor `pnpm brand:build` needs Python, HarfBuzz or the font. Run it when the copy or the
lettering parameters change, then run `pnpm brand:build`.

    pip install uharfbuzz fonttools
    GEIST_DIR=/path/to/geist/static python3 scripts/brand/author-type.py

Geist 1.8 (https://github.com/vercel/geist-font) is SIL Open Font License 1.1. The font
files are not part of this repository and are not redistributed. Only the glyph outlines
of the strings below are, as vector paths, which the licence permits for a logotype.

Every string is shaped at 100 units per em with kerning and no ligatures, with the
baseline at y=0 and up negative, so a caller scales it with one transform.
"""

import json
import os
import sys
from pathlib import Path

import uharfbuzz as hb
from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont

SIZE = 100.0

# id -> (weight, tracking in em, text)
# U+0131 is the dotless i: the wordmark draws its own tittle (see geometry.mjs).
STRINGS = {
    "wordmark": ("SemiBold", -0.025, "Conduıt"),
    "headline.1": ("SemiBold", -0.045, "Two chains."),
    "headline.2": ("SemiBold", -0.045, "One commitment."),
    "descriptor.1": ("Regular", -0.005, "Cross-chain delivery versus payment"),
    "descriptor.2": ("Regular", -0.005, "for verified assets."),
    "url": ("Regular", 0.0, "tryconduit.xyz"),
    "fact.1.title": ("SemiBold", -0.02, "Nothing is bridged"),
    "fact.1.body.1": ("Regular", 0.0, "Each asset stays on the chain"),
    "fact.1.body.2": ("Regular", 0.0, "that issued it."),
    "fact.2.title": ("SemiBold", -0.02, "Checked again at commit"),
    "fact.2.body.1": ("Regular", 0.0, "Cleanverse is asked a second time,"),
    "fact.2.body.2": ("Regular", 0.0, "after finality."),
    "fact.3.title": ("SemiBold", -0.02, "Verifiable by anyone"),
    "fact.3.body.1": ("Regular", 0.0, "Read both chains and the guardian set."),
    "fact.3.body.2": ("Regular", 0.0, "No application database."),
}


def fmt(value):
    text = ("%.2f" % value).rstrip("0").rstrip(".")
    return "0" if text in ("-0", "") else text


def outline(font_path, text, tracking):
    face = hb.Face(hb.Blob.from_file_path(str(font_path)))
    font = hb.Font(face)
    buf = hb.Buffer()
    buf.add_str(text)
    buf.guess_segment_properties()
    hb.shape(font, buf, {"kern": True, "liga": False, "calt": False})

    upm = face.upem
    tt = TTFont(str(font_path))
    glyphs = tt.getGlyphSet()
    order = tt.getGlyphOrder()
    scale = SIZE / upm

    x = 0.0
    parts = []
    stems = []
    ink = BoundsPen(glyphs)
    for info, pos in zip(buf.glyph_infos, buf.glyph_positions):
        name = order[info.codepoint]
        ox = (x + pos.x_offset) * scale
        placement = (scale, 0, 0, -scale, ox, -pos.y_offset * scale)
        pen = SVGPathPen(glyphs, ntos=fmt)
        glyphs[name].draw(TransformPen(pen, placement))
        glyphs[name].draw(TransformPen(ink, placement))
        parts.append(pen.getCommands())
        if name == "dotlessi":
            bounds = BoundsPen(glyphs)
            glyphs[name].draw(bounds)
            x0, _, x1, y1 = bounds.bounds
            stems.append({"x0": round(ox + x0 * scale, 2), "x1": round(ox + x1 * scale, 2), "top": round(-y1 * scale, 2)})
        x += pos.x_advance + tracking * upm

    os2 = tt["OS/2"]
    x0, y0, x1, y1 = ink.bounds
    entry = {
        "d": "".join(parts),
        "width": round((x - tracking * upm) * scale, 2),
        "bbox": [round(x0, 2), round(y0, 2), round(x1, 2), round(y1, 2)],
        "capHeight": round(os2.sCapHeight * scale, 2),
        "xHeight": round(os2.sxHeight * scale, 2),
        "ascender": round(tt["hhea"].ascent * scale, 2),
    }
    if stems:
        entry["stem"] = stems[0]
    return entry


def main():
    geist = os.environ.get("GEIST_DIR")
    if not geist:
        sys.exit("Set GEIST_DIR to the folder holding Geist-Regular.ttf and Geist-SemiBold.ttf")

    fonts = {w: Path(geist) / f"Geist-{w}.ttf" for w in ("Regular", "SemiBold")}
    for path in fonts.values():
        if not path.is_file():
            sys.exit(f"missing {path}")

    out = {
        "font": {
            "family": "Geist",
            "version": "1.8",
            "licence": "SIL Open Font License 1.1",
            "source": "https://github.com/vercel/geist-font",
            "unitsPerEm": SIZE,
        },
        "strings": {},
    }
    for key, (weight, tracking, text) in STRINGS.items():
        entry = outline(fonts[weight], text, tracking)
        entry.update({"weight": weight, "tracking": tracking, "text": text})
        out["strings"][key] = entry

    target = Path(__file__).with_name("type.json")
    target.write_text(json.dumps(out, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"wrote {target} ({len(STRINGS)} strings)")


if __name__ == "__main__":
    main()
