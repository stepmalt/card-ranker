#!/usr/bin/env python3
"""Convert the source PNGs in "final pics/" into web-ready WebP files.

Outputs:
  cards/<id>.webp         full resolution, quality 85
  cards/thumbs/<id>.webp  ~300px wide thumbnail
  cards.json              manifest used by the site

Usage:  python3 scripts/build_cards.py            (skips files already converted)
        python3 scripts/build_cards.py --force    (re-encode everything)
Requires Pillow:  pip3 install Pillow
"""
import json
import re
import sys
import unicodedata
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "final pics"
OUT = ROOT / "cards"
THUMBS = OUT / "thumbs"
FULL_QUALITY = 85
THUMB_WIDTH = 300
THUMB_QUALITY = 80

# e.g. "sv3-3_Bellossom.png" -> set "sv3", number "3", name "Bellossom"
PATTERN = re.compile(r"^(?P<set>.+)-(?P<num>[^-_]+)_(?P<name>.+)\.png$", re.IGNORECASE)


def parse(path: Path):
    filename = unicodedata.normalize("NFC", path.name)
    m = PATTERN.match(filename)
    if not m:
        return None
    set_code, number, name = m.group("set"), m.group("num"), m.group("name")
    card_id = re.sub(r"[^a-z0-9-]", "", f"{set_code}-{number}".lower())
    return {"id": card_id, "name": name, "set": set_code, "number": number, "src": path}


def convert(card, force):
    full = OUT / f"{card['id']}.webp"
    thumb = THUMBS / f"{card['id']}.webp"
    if force or not full.exists() or not thumb.exists():
        with Image.open(card["src"]) as im:
            im = im.convert("RGBA") if im.mode in ("P", "LA", "RGBA") else im.convert("RGB")
            im.save(full, "WEBP", quality=FULL_QUALITY, method=6)
            h = round(im.height * THUMB_WIDTH / im.width)
            im.resize((THUMB_WIDTH, h), Image.LANCZOS).save(thumb, "WEBP", quality=THUMB_QUALITY, method=6)
    with Image.open(full) as im:
        w, h = im.size
    return card["id"], w, h


def main():
    force = "--force" in sys.argv
    if not SRC.is_dir():
        sys.exit(f'Source folder not found: {SRC}')
    THUMBS.mkdir(parents=True, exist_ok=True)

    cards, skipped = [], []
    for p in sorted(SRC.glob("*.png")):
        c = parse(p)
        (cards if c else skipped).append(c or p.name)
    ids = [c["id"] for c in cards]
    dupes = {i for i in ids if ids.count(i) > 1}
    if dupes:
        sys.exit(f"Duplicate card ids: {sorted(dupes)}")

    sizes = {}
    with ProcessPoolExecutor() as pool:
        for card_id, w, h in pool.map(convert, cards, [force] * len(cards)):
            sizes[card_id] = (w, h)

    manifest = [
        {
            "id": c["id"],
            "name": c["name"],
            "set": c["set"],
            "number": c["number"],
            "image": f"cards/{c['id']}.webp",
            "thumb": f"cards/thumbs/{c['id']}.webp",
            "width": sizes[c["id"]][0],
            "height": sizes[c["id"]][1],
        }
        for c in cards
    ]
    (ROOT / "cards.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")

    print(f"Wrote {len(manifest)} cards to cards/ and cards.json")
    for name in skipped:
        print(f"  skipped (name didn't match set-number_Name.png): {name}")


if __name__ == "__main__":
    main()
