#!/bin/bash
# Downloads the full-size image for every card id in cool-cards-ids.txt from
# Dex's image server into originals/. Skips files already downloaded.
cd "$(dirname "$0")"
tr ',' '\n' < cool-cards-ids.txt | grep . | while read -r id; do
  set="${id%-*}"; num="${id##*-}"
  out="originals/${id}.png"
  [ -s "$out" ] && continue
  echo "$id $set $num"
done | xargs -P 6 -L 1 sh -c 'curl -sf --retry 3 -o "originals/$0.png.part" "https://static.dextcg.com/cards/$1%2F$2.png" && mv "originals/$0.png.part" "originals/$0.png" || echo "FAILED $0"'
echo "done: $(ls originals/*.png 2>/dev/null | wc -l | tr -d ' ') files"
