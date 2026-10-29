#!/usr/bin/env python3
"""Looks up each card's name and set name on the public Pokémon TCG API
(pokemontcg.io) and writes names.json: {id: {name, setName}}."""
import json
import subprocess
import time
import urllib.parse
from pathlib import Path

HERE = Path(__file__).resolve().parent
ids = [i for i in (HERE / "cool-cards-ids.txt").read_text().strip().split(",") if i]
names_path = HERE / "names.json"
out = json.loads(names_path.read_text()) if names_path.exists() else {}

# Dex set codes that the card database spells differently.
ALIASES = {"sv35": "sv3pt5", "sv45": "sv4pt5", "sv65": "sv6pt5", "sv85": "sv8pt5",
           "sv105w": "zsv10pt5", "sv105b": "rsv10pt5", "me25": "me2pt5", "swsh35": "swsh35"}


def api_id(card_id):
    set_code, num = card_id.rsplit("-", 1)
    return f"{ALIASES.get(set_code, set_code)}-{num}"


todo = [i for i in ids if i not in out]
back = {api_id(i): i for i in todo}
for k in range(0, len(todo), 20):
    batch = todo[k:k + 20]
    q = " OR ".join(f"id:{api_id(i)}" for i in batch)
    url = "https://api.pokemontcg.io/v2/cards?" + urllib.parse.urlencode({"q": q, "select": "id,name,set", "pageSize": 250})
    for attempt in range(4):
        try:
            # curl rather than urllib: some Python installs lack root certificates.
            raw = subprocess.run(["curl", "-sf", "--max-time", "90", url], capture_output=True, check=True).stdout
            data = json.loads(raw)["data"]
            break
        except Exception as e:  # rate limits / timeouts: back off and retry
            time.sleep(3 * (attempt + 1))
    else:
        print("batch failed", k)
        continue
    for c in data:
        if c["id"] in back:
            out[back[c["id"]]] = {"name": c["name"], "setName": c["set"]["name"]}
    time.sleep(0.5)

(HERE / "names.json").write_text(json.dumps(out, ensure_ascii=False, indent=1))
missing = [i for i in ids if i not in out]
print(f"found {len(out)} of {len(ids)}; missing {len(missing)}:", " ".join(missing))
