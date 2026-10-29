# ✨ Card Ranker

A static, mobile-first website for ranking my 282 Pokémon cards. It runs entirely in the browser with no backend, and saves to localStorage plus downloadable `.json` backups.

## How the ranking works

1. **Tier draft:** each card on its own, sorted into S / A / B / C. This sets each card's starting rating. Once there are enough results, each tier's centre is re-learned from your picks. If your S cards really do beat your A cards by a mile, the gap widens; if B and C barely differ, it shrinks.
2. **Swiss rounds (5):** this-or-that matchups scored with a Bradley-Terry model. Each card has a rating and an uncertainty. Each round pairs cards with close ratings where the model is least sure, with extra attention near #10, #25, #50, #100 and the finals line. No matchup ever repeats. Rounds 4 and 5 are **contender rounds**: only cards with at least a 1% chance of making the finals play (usually about 180).
3. **Rescue round (after round 2):** B/C cards with a winning record each play 2 matches against A/S cards.
4. **Finals:** the top 115 go through a full merge sort, so cards around #100–115 can still climb into the top 100. A few close calls are re-asked later without warning. Any answer that looks like a misclick (one the ratings gave under 20%) is also re-asked. If the answers disagree, the pair is asked a third time and the majority wins.
5. **Boundary challenges:** the two cards just outside #10, #25, #50 and #100 each play the two just inside.
6. **Top 10 round robin:** every top-10 pair is played fresh, 45 matchups.

**Final order:** the merge sort, boundary challenges and round robin decide *which* matchups to ask. The order itself comes from a rating that combines every answer a card has given, so one shaky answer can't drag a card out of place when its other answers disagree. In a benchmark against simulated users with realistic noise and 2% misclicks, this cut the average rank error from 3.1 to 1.7 in the top 10, from 10.4 to 6.6 in #26–50, and from 13.6 to 9.5 in #51–100. The price is about 1,780 picks for a full run instead of about 1,480. (`finalOrder: 'sort'` in `js/engine.js` switches back to the raw sort order.)

All of this is recomputed from one **event log** every time anything changes. The log holds every tier pick and every head-to-head, with stage, round and timestamp. Ratings, standings and the finals order are never stored. Editing a result in a card's detail sheet rewrites that one event and the whole ranking recalculates. If the edit means the finals need a new comparison, that comparison is asked next.

The results screen also shows a **consistency score**: how often you gave the same answer to a matchup you saw more than once.

Keys on desktop: `1–4` tiers · `←/→` (or `↑/↓`) pick · `Space` tie · `Z` undo · `L` leaderboard · `Esc` close.

## Files

```
index.html, css/, js/        the site (js/engine.js = ranking logic, js/app.js = UI)
cards/  cards/thumbs/        WebP images generated from "final pics/"
cards.json                   card manifest
scripts/build_cards.py       PNG → WebP converter + manifest builder
scripts/build_icons.py       draws the Home Screen icons in icons/
manifest.webmanifest         lets the site be added to a Home Screen as an app
scripts/simulate.mjs         accuracy benchmark: node scripts/simulate.mjs [runs] [noise] [misclick] [setting=value]
final pics/                  original PNGs, git-ignored (never committed)
```

## Run it locally

The site loads `cards.json` with `fetch`, so it has to be served over HTTP. Double-clicking `index.html` won't work.

```bash
cd ~/pokemonnn
python3 -m http.server 8000
```

Then open <http://localhost:8000>.

To try it on your phone over the same Wi-Fi, open `http://<your-mac's-IP>:8000`. The IP is under System Settings → Wi-Fi → Details. A save made there stays on the phone, so use Back up / Load backup to move it between devices.

### Regenerating the images

Only needed if you add or replace PNGs in `final pics/`:

```bash
pip3 install Pillow
python3 scripts/build_cards.py           # converts only new cards
python3 scripts/build_cards.py --force   # re-encodes everything
```

## Publish to GitHub Pages

1. Create an empty repository on GitHub (for example `card-ranker`). Don't add a README or .gitignore there.
2. In Terminal:

   ```bash
   cd ~/pokemonnn
   git init -b main
   git add .
   git status          # check that "final pics/" is NOT listed
   git commit -m "Card ranker site"
   git remote add origin https://github.com/<your-username>/card-ranker.git
   git push -u origin main
   ```

3. On GitHub, go to the repository's **Settings → Pages**. Under **Build and deployment**, set Source to **Deploy from a branch**, Branch to **main**, folder **/ (root)**, then Save.
4. After a minute or two the site is live at `https://<your-username>.github.io/card-ranker/`.

To update the site later, run `git add . && git commit -m "update" && git push`.

Notes:
- A Pages site is public even if only you use it. Your picks are not public, because they stay in your browser's localStorage and your backup files.
- **Keeping your save safe.** Your progress lives in the browser, and Safari on iPhone can clear a website's data if you don't visit it for about a week. The app asks the browser to keep its data permanently (browsers may say no). It reminds you to back up every 100 picks, and again when your last backup is 3 or more days old. On iPhone, the safest setup is to open the site in Safari, tap **Share → Add to Home Screen**, and always rank from that Home Screen icon. The app shows this tip once, and it's also under **⋯ → Add to Home Screen**. The Home Screen app has its own storage separate from Safari, so if you already have picks in Safari, **Back up** there first and **Load backup** inside the Home Screen app.
- Saves belong to each browser and each address, so `localhost:8000` and the github.io site keep separate saves. Use **Back up** on one and **Load backup** on the other to move a ranking.
- `.nojekyll` makes GitHub serve the files as they are.

## Favourite cards ranker (`favorites/`)

A second, completely separate ranker for the 928 cards in my Dex "cool cards" folder. It lives at `…/card-ranker/favorites/`, with its own copy of the code (`favorites/js/`, `favorites/css/`), its own save and its own backups. Nothing in it touches the Pokémon ranker, and Pokémon-ranker backups are refused there.

How it ranks 928 cards in about 1,000–1,100 picks instead of 5,500:
1. **Quick sort:** 12 cards per page (78 pages). Tap the ones you love. Only hearted cards go on; the rest are listed at the bottom as "not a favourite". You can heart or un-heart any card later from its detail sheet.
2. **Tier draft** of your favourites, then the tier review step.
3. **5 Swiss rounds.** Rounds 3–5 are contender rounds, for cards that could still make the finals.
4. **Finals** for the top 60, so the top 50 is precise. Then boundary challenges at #10, #25 and #50, and a top 10 round robin.

In simulations, a session with about 210 hearted cards took about 1,060 picks, and no true top-50 card missed the finals.

Rebuilding its data (only needed if the folder changes):
```bash
favorites/source/download.sh                   # card images from Dex → favorites/source/originals/ (git-ignored, ~760 MB)
python3 -I favorites/source/lookup_names.py    # card names from pokemontcg.io → names.json
python3 favorites/source/build_cards.py        # WebP images, thumbnails and favorites/cards.json
node favorites/source/simulate.mjs             # simulated session: picks and accuracy
```
`favorites/source/cool-cards-ids.txt` is the list of card IDs read from the Dex folder.
