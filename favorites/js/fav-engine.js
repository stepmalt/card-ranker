// Favourites ranker: a quick-sort layer in front of the ranking engine.
//
// Every card is first shown on a page of PAGE_SIZE; the ones you heart become
// your favourites, and only those go through the full funnel (tier draft,
// swiss, finals, ...) in ./engine.js. Everything is still derived from the log.
//
// Extra event shapes:
//   { id, t: 'triage', p: pageIndex, keep: [cardId, ...], ts }   (latest per page wins)
//   { id, t: 'mark', m: 'hearts-reviewed', ts }                   (hearts checked after the quick sort)

import { derive as deriveRanking, hash01, CONFIG } from './engine.js';

export const PAGE_SIZE = 12;

// Rough number of picks the ranking stages need for k favourites (after the quick
// sort). Small sets use the stage-by-stage count; larger ones a line fitted to
// simulated sessions (214 -> ~1,110, 414 -> ~1,810, 928 -> ~3,690 picks).
export function picksForFavourites(k) {
  if (k > 60) return Math.round(3.5 * k + 370);
  const f = Math.min(CONFIG.finalists, k);
  const swiss = Math.round((k / 2) * CONFIG.swissRounds);
  return k + 2 + swiss + Math.round(k * 0.1) * CONFIG.rescueGames
    + Math.round(f * Math.log2(Math.max(2, f)) * 0.88) + (k > 50 ? CONFIG.cutoffs.length * 4 : 0) + (CONFIG.topN * (CONFIG.topN - 1)) / 2;
}

export function derive(save, cards) {
  const n = cards.length;
  const pages = Math.ceil(n / PAGE_SIZE);
  const pageOrder = cards
    .map((c, i) => [hash01(`${save.seed}:triage:${c.id}`), i])
    .sort((x, y) => x[0] - y[0] || x[1] - y[1])
    .map((x) => cards[x[1]].id);
  const pageCards = (p) => pageOrder.slice(p * PAGE_SIZE, (p + 1) * PAGE_SIZE);
  const pageOfId = new Map(pageOrder.map((id, k) => [id, Math.floor(k / PAGE_SIZE)]));

  // Latest triage answer per page decides which of that page's cards are favourites.
  const pageKeep = new Map();
  for (const e of save.events) if (e.t === 'triage') pageKeep.set(e.p, e.keep);
  const fav = new Set();
  for (const [p, keep] of pageKeep) {
    const onPage = new Set(pageCards(p));
    for (const id of keep) if (onPage.has(id)) fav.add(id);
  }
  let nextPage = -1;
  for (let p = 0; p < pages; p++) {
    if (!pageKeep.has(p)) { nextPage = p; break; }
  }

  const favCards = cards.filter((c) => fav.has(c.id));
  const favIndex = new Map(favCards.map((c, i) => [c.id, i]));
  const inner = deriveRanking(save, favCards, favIndex);

  const heartsReviewed = save.events.some((e) => e.t === 'mark' && e.m === 'hearts-reviewed');
  const rankingStarted = save.events.some((e) => e.t === 'tier' || e.t === 'match');
  let question = inner.question;
  let stage = inner.stage;
  let round = inner.round;
  let left = inner.progress.left;
  const byStage = { triage: 0, ...inner.progress.byStage };
  if (nextPage >= 0) {
    question = { kind: 'triage', stage: 'triage', page: nextPage, pages, cards: pageCards(nextPage) };
    stage = 'triage';
    round = null;
    byStage.triage = pages - pageKeep.size;
    // Guess the final number of favourites from the pages done so far.
    const done = pageKeep.size;
    const k = done ? Math.round((fav.size / (done * PAGE_SIZE)) * n) : Math.round(n * 0.25);
    left = byStage.triage + 1 + picksForFavourites(k);
  } else if (!heartsReviewed && !rankingStarted) {
    // Pause after the quick sort so the hearts can be checked as a whole.
    question = { kind: 'heart-review', stage: 'triage' };
    stage = 'triage';
    round = null;
    byStage.triage = 1;
    left = 1 + picksForFavourites(fav.size);
  }

  const rest = cards.filter((c) => !fav.has(c.id)).sort((a, b) => a.name.localeCompare(b.name)).map((c) => c.id);
  const order = inner.order.concat(rest);
  const rankMap = new Map(order.map((id, k) => [id, k + 1]));
  const isFav = (id) => fav.has(id);
  const pick = (fn, fallback) => (id) => (fav.has(id) ? fn(id) : fallback);

  const roundProgress = question && question.kind === 'triage' ? { done: pageKeep.size, left: pages - pageKeep.size }
    : question && question.kind === 'heart-review' ? { done: pages, left: 0 } : inner.progress.round;

  return {
    ...inner,
    stage,
    round,
    question,
    order,
    favCount: fav.size,
    pagesDone: pageKeep.size,
    totalCards: n,
    isFav,
    pageOf: (id) => pageOfId.get(id),
    pageTriaged: (p) => pageKeep.has(p),
    nextPageCards: nextPage >= 0 && nextPage + 1 < pages ? pageCards(nextPage + 1) : [],
    rank: (id) => rankMap.get(id),
    theta: pick(inner.theta, -Infinity),
    sigma: pick(inner.sigma, 0),
    rating: pick(inner.rating, null),
    record: pick(inner.record, { w: 0, l: 0, t: 0 }),
    tier: pick(inner.tier, null),
    matchesFor: pick(inner.matchesFor, []),
    progress: { done: save.events.length, left, byStage, round: roundProgress },
  };
}
