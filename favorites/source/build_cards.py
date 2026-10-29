#!/usr/bin/env python3
"""Builds the favourites ranker's images and manifest from the Dex downloads.

Inputs (this folder):  cool-cards-ids.txt, originals/<id>.png, names.json
Outputs (favorites/):  cards/<id>.webp (560px wide), cards/thumbs/<id>.webp, cards.json

Usage:  python3 favorites/source/build_cards.py [--force]
"""
import json
import sys
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

from PIL import Image

HERE = Path(__file__).resolve().parent
SITE = HERE.parent
OUT = SITE / "cards"
THUMBS = OUT / "thumbs"
FULL_WIDTH = 560    # sharp at phone sizes while keeping 900+ cards light
FULL_QUALITY = 80
THUMB_WIDTH = 240
THUMB_QUALITY = 76


def convert(card_id, force):
    src = HERE / "originals" / f"{card_id}.png"
    full = OUT / f"{card_id}.webp"
    thumb = THUMBS / f"{card_id}.webp"
    if force or not full.exists() or not thumb.exists():
        with Image.open(src) as im:
            im = im.convert("RGBA")
            for path, width, quality in ((full, FULL_WIDTH, FULL_QUALITY), (thumb, THUMB_WIDTH, THUMB_QUALITY)):
                h = round(im.height * width / im.width)
                im.resize((width, h), Image.LANCZOS).save(path, "WEBP", quality=quality, method=6)
    with Image.open(full) as im:
        return card_id, im.size


def main():
    force = "--force" in sys.argv
    ids = [i for i in (HERE / "cool-cards-ids.txt").read_text().strip().split(",") if i]
    names = json.loads((HERE / "names.json").read_text()) if (HERE / "names.json").exists() else {}
    missing = [i for i in ids if not (HERE / "originals" / f"{i}.png").exists()]
    if missing:
        sys.exit(f"Missing downloads (run download.sh): {' '.join(missing)}")
    THUMBS.mkdir(parents=True, exist_ok=True)

    with ProcessPoolExecutor() as pool:
        sizes = dict(pool.map(convert, ids, [force] * len(ids)))

    manifest = []
    for card_id in ids:
        set_code, number = card_id.rsplit("-", 1)
        info = names.get(card_id, {})
        manifest.append({
            "id": card_id,
            "name": info.get("name") or f"{set_code} #{number}",
            "set": set_code,
            "setName": info.get("setName", ""),
            "number": number,
            "image": f"cards/{card_id}.webp",
            "thumb": f"cards/thumbs/{card_id}.webp",
            "width": sizes[card_id][0],
            "height": sizes[card_id][1],
        })
    (SITE / "cards.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    unnamed = sum(1 for c in manifest if c["id"] not in names)
    print(f"Wrote {len(manifest)} cards to favorites/cards.json ({unnamed} without a looked-up name)")


if __name__ == "__main__":
    main()
