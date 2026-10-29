// Ranking engine for the favourite-cards ranker (a tuned copy of ../../js/engine.js;
// the Pokémon ranker's engine is separate and unchanged). Pure functions only: every rating, standing, pairing and
// finals order is recomputed from the event log on every call to derive().
//
// Event shapes stored in save.events:
//   { id, t: 'tier',  c: cardId, v: 'S'|'A'|'B'|'C', ts }
//   { id, t: 'match', a: cardId, b: cardId, w: 'a'|'b'|'t',
//     s: 'swiss'|'rescue'|'finals'|'boundary'|'roundrobin', r?: round, ts }
//   { id, t: 'mark', m: 'tiers-reviewed', ts }   (tier review confirmed)

export const CONFIG = {
  swissRounds: 5,           // rounds 3-5 are contender rounds (see contenderFrom)
  rescueAfterRound: 2,
  rescueGames: 2,          // matches each rescued B/C card plays vs A/S cards
  finalists: 60,           // exact merge sort; 10 spare so #51-60 can still climb into the top 50
  cutoffs: [10, 25, 50],
  contenderFrom: 3,        // from this swiss round on, only cards that could still make the finals play
  contenderMinP: 0.01,     // ...meaning at least a 1% chance of being in the top `finalists`
  topN: 10,
  priorSigma: 1.0,         // starting spread of the tier prior, in logit units
  learnTiers: true,        // re-estimate each tier's centre (and spread) from results
  learnSpread: false,      // benchmarked: learning centres only was most accurate
  repeatRate: 0.14,        // share of close finals calls that get a hidden repeat
  closeGap: 0.6,           // |Δθ| below this counts as a close call
  repeatDelay: 6,          // finals picks to wait before asking a hidden repeat
  surpriseP: 0.2,
  // 'rating': the sort, boundary challenges and round robin decide which matchups
  // to ask, and the final order comes from a rating that combines every answer.
  // 'sort': the raw merge-sort order, with swaps and win counts applied on top.
  finalOrder: 'rating',
  rrFresh: true,           // ask every top-10 pair in the round robin, even if they've met before          // a finals result the ratings gave < 20% gets re-checked (misclick guard)
};

export const TIERS = ['S', 'A', 'B', 'C'];
export const TIER_INFO = {
  S: { label: 'Obsessed', prior: 1.5 },
  A: { label: 'Love', prior: 0.5 },
  B: { label: 'Like', prior: -0.5 },
  C: { label: "It's fine", prior: -1.5 },
};

// Display rating: Elo-like scale centred on 1500.
export const toRating = (theta) => Math.round(1500 + theta * (400 / Math.LN10));

export const pairKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);

export function hash01(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  h ^= h >>> 15;
  h = Math.imul(h, 2246822507);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

function seededOrder(n, seed) {
  return Array.from({ length: n }, (_, i) => i)
    .map((i) => [hash01(`${seed}:order:${i}`), i])
    .sort((x, y) => x[0] - y[0])
    .map((x) => x[1]);
}

// Bradley-Terry MAP fit with a Gaussian prior per card.
// games: [{ i, j, s }] where s is i's score (1 win, 0 loss, 0.5 tie).
function fitCore(n, adj, mu, tau, theta0) {
  const theta = theta0.slice();
  for (let iter = 0; iter < 60; iter++) {
    let maxStep = 0;
    for (let i = 0; i < n; i++) {
      const a = adj[i];
      if (!a.length) { theta[i] = mu[i]; continue; }
      const inv = 1 / (tau[i] * tau[i]);
      let g = -(theta[i] - mu[i]) * inv;
      let h = inv;
      for (let k = 0; k < a.length; k += 2) {
        const p = 1 / (1 + Math.exp(theta[a[k]] - theta[i]));
        g += a[k + 1] - p;
        h += p * (1 - p);
      }
      const step = Math.max(-1, Math.min(1, g / h));
      theta[i] += step;
      if (Math.abs(step) > maxStep) maxStep = Math.abs(step);
    }
    if (maxStep < 1e-5) break;
  }
  const sigma = new Array(n);
  for (let i = 0; i < n; i++) {
    let h = 1 / (tau[i] * tau[i]);
    const a = adj[i];
    for (let k = 0; k < a.length; k += 2) {
      const p = 1 / (1 + Math.exp(theta[a[k]] - theta[i]));
      h += p * (1 - p);
    }
    sigma[i] = 1 / Math.sqrt(h);
  }
  return { theta, sigma };
}

// Tiers seed each card's rating. Once there are enough results, each tier's
// centre and spread are re-learned from the data (empirical Bayes / EM), so the
// tiers count exactly as much as your head-to-head picks say they deserve, and a
// card in the wrong tier can climb or fall freely.
export function fitBT(n, tierOf, games) {
  const adj = Array.from({ length: n }, () => []);
  for (const g of games) {
    adj[g.i].push(g.j, g.s);
    adj[g.j].push(g.i, 1 - g.s);
  }
  const tierMu = Object.fromEntries(TIERS.map((t) => [t, TIER_INFO[t].prior]));
  const tierTau = Object.fromEntries(TIERS.map((t) => [t, CONFIG.priorSigma]));
  const mu = new Array(n);
  const tau = new Array(n);
  const setPrior = () => {
    for (let i = 0; i < n; i++) {
      const t = tierOf[i];
      mu[i] = t ? tierMu[t] : 0;
      tau[i] = t ? tierTau[t] : CONFIG.priorSigma;
    }
  };
  setPrior();
  let fit = fitCore(n, adj, mu, tau, mu);
  if (CONFIG.learnTiers && games.length >= n * 0.75) {
    const anchor = TIERS.reduce((a, t) => a + TIER_INFO[t].prior, 0) / TIERS.length;
    for (let it = 0; it < 8; it++) {
      for (const t of TIERS) {
        let cnt = 0;
        let sum = 0;
        for (let i = 0; i < n; i++) if (tierOf[i] === t) { cnt++; sum += fit.theta[i]; }
        if (cnt < 4) continue;
        const m = sum / cnt;
        let v = 0;
        for (let i = 0; i < n; i++) if (tierOf[i] === t) v += (fit.theta[i] - m) ** 2 + fit.sigma[i] ** 2;
        tierMu[t] = m;
        if (CONFIG.learnSpread) tierTau[t] = Math.min(3, Math.max(0.4, Math.sqrt(v / cnt)));
      }
      // Ratings only matter relative to each other; keep the scale anchored.
      const shift = TIERS.reduce((a, t) => a + tierMu[t], 0) / TIERS.length - anchor;
      for (const t of TIERS) tierMu[t] -= shift;
      setPrior();
      fit = fitCore(n, adj, mu, tau, fit.theta.map((x) => x - shift));
    }
  }
  return { ...fit, tierMu, tierTau };
}

// Standard normal CDF.
function phi(z) {
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(z * z) / 2);
  return z >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}

function orderBy(n, theta) {
  return Array.from({ length: n }, (_, i) => i).sort((x, y) => theta[y] - theta[x] || x - y);
}

function mergeSort(items, before) {
  if (items.length < 2) return items.slice();
  const mid = items.length >> 1;
  const left = mergeSort(items.slice(0, mid), before);
  const right = mergeSort(items.slice(mid), before);
  const out = [];
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    if (before(left[i], right[j])) out.push(left[i++]);
    else out.push(right[j++]);
  }
  while (i < left.length) out.push(left[i++]);
  while (j < right.length) out.push(right[j++]);
  return out;
}

export const STAGE_LABELS = {
  triage: 'Quick sort',
  tier: 'Tier draft',
  swiss: 'Swiss rounds',
  rescue: 'Rescue round',
  finals: 'Finals',
  boundary: 'Boundary challenges',
  roundrobin: 'Top 10 round robin',
  done: 'Complete',
};

export function stageLabel(stage, round) {
  if (stage === 'swiss') return `Swiss · Round ${round} of ${CONFIG.swissRounds}`;
  return STAGE_LABELS[stage] || stage;
}

export function derive(save, cards, index) {
  const n = cards.length;
  const seed = save.seed;
  const events = save.events;

  // ---- read the log -------------------------------------------------------
  const tierOf = new Array(n).fill(null);
  const matches = [];
  for (let k = 0; k < events.length; k++) {
    const e = events[k];
    if (e.t === 'tier') {
      const i = index.get(e.c);
      if (i !== undefined) tierOf[i] = e.v;
    } else if (e.t === 'match') {
      const i = index.get(e.a);
      const j = index.get(e.b);
      if (i === undefined || j === undefined || i === j) continue;
      matches.push({ e, k, i, j, s: e.w === 'a' ? 1 : e.w === 'b' ? 0 : 0.5 });
    }
  }
  const all = fitBT(n, tierOf, matches);
  const theta = all.theta;
  const sigma = all.sigma;

  const records = Array.from({ length: n }, () => ({ w: 0, l: 0, t: 0 }));
  const byPair = new Map();
  const byCard = Array.from({ length: n }, () => []);
  for (const m of matches) {
    if (m.s === 1) { records[m.i].w++; records[m.j].l++; }
    else if (m.s === 0) { records[m.i].l++; records[m.j].w++; }
    else { records[m.i].t++; records[m.j].t++; }
    const key = pairKey(m.i, m.j);
    if (!byPair.has(key)) byPair.set(key, []);
    byPair.get(key).push(m);
    byCard[m.i].push(m);
    byCard[m.j].push(m);
  }
  const faced = (i, j) => byPair.has(pairKey(i, j));
  // Score of x against y for one match record.
  const scoreFor = (m, x) => (m.i === x ? m.s : 1 - m.s);

  const thetaOrder = orderBy(n, theta);
  const rankOf = new Array(n);
  thetaOrder.forEach((i, r) => (rankOf[i] = r + 1));

  const mk = (i, j, stage, round, extra = {}) => {
    // Randomise which side each card appears on (stable for a given log state).
    const prev = (byPair.get(pairKey(i, j)) || []).length;
    const flip = hash01(`${seed}:side:${pairKey(i, j)}:${prev}`) < 0.5;
    const [a, b] = flip ? [j, i] : [i, j];
    return { kind: 'match', a: cards[a].id, b: cards[b].id, stage, round, ...extra };
  };

  let question = null;
  let stage = null;
  let round = null;
  const left = { tier: 0, swiss: 0, rescue: 0, finals: 0, boundary: 0, roundrobin: 0 };
  const halfN = Math.floor(n / 2);

  // ---- 1. tier draft --------------------------------------------------------
  const draftOrder = seededOrder(n, seed);
  const untiered = draftOrder.filter((i) => !tierOf[i]);
  left.tier = untiered.length ? untiered.length + 1 : 0;
  if (untiered.length) {
    question = { kind: 'tier', card: cards[untiered[0]].id, stage: 'tier' };
    stage = 'tier';
  } else if (!matches.length && !events.some((e) => e.t === 'mark' && e.m === 'tiers-reviewed')) {
    // Pause after the draft so tiers can be checked before the swiss rounds.
    question = { kind: 'review', stage: 'tier' };
    stage = 'tier';
    left.tier = 1;
  }

  // ---- 2. swiss rounds + rescue round --------------------------------------
  const sequence = [];
  for (let r = 1; r <= CONFIG.swissRounds; r++) {
    sequence.push({ stage: 'swiss', round: r });
    if (r === CONFIG.rescueAfterRound) sequence.push({ stage: 'rescue', round: null });
  }

  const F = Math.min(CONFIG.finalists, n);
  // Extra attention for cards near a cutoff, including the line into the finals.
  const lines = [...CONFIG.cutoffs, F];
  const cutoffBoost = new Array(n);
  for (let i = 0; i < n; i++) {
    let b = 0;
    for (const c of lines) {
      const d = rankOf[i] - (c + 0.5);
      const w = Math.max(6, c * 0.08);
      b = Math.max(b, Math.exp(-(d * d) / (2 * w * w)));
    }
    cutoffBoost[i] = 1 + 1.2 * b;
  }

  // Late swiss rounds are for cards that could still make the finals. The set is
  // fixed from the ratings as they stood when the round began.
  function contendersFor(r) {
    if (r < CONFIG.contenderFrom || F >= n) return null;
    let startK = Infinity;
    for (const m of matches) if (m.e.s === 'swiss' && m.e.r === r && m.k < startK) startK = m.k;
    const fit = startK === Infinity ? all : fitBT(n, tierOf, matches.filter((m) => m.k < startK));
    const cut = orderBy(n, fit.theta)[F - 1];
    const set = new Set();
    for (let i = 0; i < n; i++) {
      const z = (fit.theta[i] - fit.theta[cut]) / Math.sqrt(fit.sigma[i] ** 2 + fit.sigma[cut] ** 2);
      if (phi(z) >= CONFIG.contenderMinP) set.add(i);
    }
    return set;
  }

  let contenderCount = null;
  function swissNext(r) {
    const played = new Uint8Array(n);
    for (const m of matches) if (m.e.s === 'swiss' && m.e.r === r) played[m.i] = played[m.j] = 1;
    const contenders = contendersFor(r);
    if (contenders) contenderCount = contenders.size;
    const U = [];
    for (let i = 0; i < n; i++) if (!played[i] && (!contenders || contenders.has(i))) U.push(i);
    const prio = (i) => sigma[i] * cutoffBoost[i];
    U.sort((x, y) => prio(y) - prio(x) || x - y);
    for (const i of U) {
      let best = -1;
      let bestScore = Infinity;
      for (const j of U) {
        if (j === i || faced(i, j)) continue;
        // Close ratings first, nudged toward uncertain / cutoff-adjacent partners.
        const sc = Math.abs(theta[i] - theta[j]) - 0.2 * sigma[j] * cutoffBoost[j];
        if (sc < bestScore) { bestScore = sc; best = j; }
      }
      if (best >= 0) return { pair: [i, best], left: Math.max(1, Math.floor(U.length / 2)) };
    }
    return null;
  }

  // Rescue: B/C cards with a winning record after the early swiss rounds.
  const rescueCandidates = [];
  {
    const pts = new Array(n).fill(0);
    const games = new Array(n).fill(0);
    for (const m of matches) {
      if (m.e.s !== 'swiss' || m.e.r > CONFIG.rescueAfterRound) continue;
      pts[m.i] += m.s; pts[m.j] += 1 - m.s;
      games[m.i]++; games[m.j]++;
    }
    for (let i = 0; i < n; i++) {
      if ((tierOf[i] === 'B' || tierOf[i] === 'C') && games[i] > 0 && pts[i] > games[i] / 2) rescueCandidates.push(i);
    }
  }
  const rescueCount = new Array(n).fill(0);
  for (const m of matches) if (m.e.s === 'rescue') { rescueCount[m.i]++; rescueCount[m.j]++; }

  function rescueNext() {
    const isCand = new Set(rescueCandidates);
    const pending = rescueCandidates
      .filter((i) => {
        let played = 0;
        for (const m of byCard[i]) if (m.e.s === 'rescue') played++;
        return played < CONFIG.rescueGames;
      })
      .sort((x, y) => rescueCount[x] - rescueCount[y] || theta[y] - theta[x] || x - y);
    let leftCount = 0;
    for (const i of pending) {
      let played = 0;
      for (const m of byCard[i]) if (m.e.s === 'rescue') played++;
      leftCount += CONFIG.rescueGames - played;
    }
    for (const i of pending) {
      const target = theta[i] + 0.3;
      let best = -1;
      let bestScore = Infinity;
      for (let j = 0; j < n; j++) {
        if (j === i || isCand.has(j) || faced(i, j)) continue;
        if (tierOf[j] !== 'S' && tierOf[j] !== 'A') continue;
        const sc = Math.abs(theta[j] - target) + 0.4 * rescueCount[j];
        if (sc < bestScore) { bestScore = sc; best = j; }
      }
      if (best >= 0) return { pair: [i, best], left: leftCount };
    }
    return null;
  }

  let swissDone = false;
  if (!question) {
    let reached = false;
    for (const spec of sequence) {
      if (reached) {
        left[spec.stage] += spec.stage === 'rescue' ? Math.round(n * 0.1) * CONFIG.rescueGames
          : spec.round >= CONFIG.contenderFrom ? Math.min(halfN, Math.round(F * 0.8)) : halfN;
        continue;
      }
      const nx = spec.stage === 'rescue' ? rescueNext() : swissNext(spec.round);
      if (nx) {
        reached = true;
        stage = spec.stage;
        round = spec.round;
        left[spec.stage] += nx.left;
        question = mk(nx.pair[0], nx.pair[1], spec.stage, spec.round);
      }
    }
    swissDone = !reached;
  } else {
    left.swiss = halfN * CONFIG.swissRounds;
    left.rescue = Math.round(n * 0.1) * CONFIG.rescueGames;
  }

  // ---- 3. finals: exact merge sort of the top N ---------------------------
  let finalists = null;
  let finals = null;
  let preTheta = null;
  if (swissDone) {
    const preGames = matches.filter((m) => m.e.s === 'swiss' || m.e.s === 'rescue');
    preTheta = fitBT(n, tierOf, preGames).theta;
    finalists = orderBy(n, preTheta).slice(0, F);
    // Merge in a fixed seeded order so later edits to swiss results don't
    // reshuffle the whole merge tree (and re-ask lots of pairs).
    const fixed = finalists.slice().sort((x, y) => hash01(`${seed}:finals:${x}`) - hash01(`${seed}:finals:${y}`));
    finals = finalsReplay(fixed);
  }

  function finalsReplay(items) {
    // Prefix counts of finals-stage events, for spacing out hidden repeats.
    const finalsBefore = new Array(events.length + 1).fill(0);
    for (let k = 0; k < events.length; k++) {
      finalsBefore[k + 1] = finalsBefore[k] + (events[k].t === 'match' && events[k].s === 'finals' ? 1 : 0);
    }
    const totalFinals = finalsBefore[events.length];
    const SOURCES = new Set(['swiss', 'rescue', 'finals']);
    const memo = new Map();
    let firstNeed = null;
    let needCount = 0;
    const pending = [];

    function result(x, y) {
      const key = pairKey(x, y);
      if (memo.has(key)) return memo.get(key);
      const ms = (byPair.get(key) || []).filter((m) => SOURCES.has(m.e.s));
      let wx = 0;
      let wy = 0;
      let nFinals = 0;
      let lastK = -1;
      for (const m of ms) {
        const sc = scoreFor(m, x);
        if (sc === 1) wx++;
        else if (sc === 0) wy++;
        if (m.e.s === 'finals') nFinals++;
        lastK = Math.max(lastK, m.k);
      }
      const fallback = preTheta[x] > preTheta[y] || (preTheta[x] === preTheta[y] && x < y) ? x : y;
      let res;
      if (wx + wy === 0) res = nFinals === 0 ? { need: true, winner: fallback } : { winner: fallback };
      else if (wx === wy) res = nFinals < 3 ? { need: true, winner: fallback, contradiction: true } : { winner: fallback };
      else {
        res = { winner: wx > wy ? x : y };
        const close = Math.abs(preTheta[x] - preTheta[y]) < CONFIG.closeGap;
        const flagged = close && hash01(`${seed}:repeat:${key}`) < CONFIG.repeatRate;
        // Misclick guard: an answer the ratings strongly disagree with gets asked again.
        const loser = res.winner === x ? y : x;
        const surprising = 1 / (1 + Math.exp(preTheta[loser] - preTheta[res.winner])) < CONFIG.surpriseP;
        if ((flagged || surprising) && ms.length < 2) {
          res.pending = true;
          res.since = totalFinals - finalsBefore[lastK + 1];
        }
      }
      memo.set(key, res);
      return res;
    }

    const order = mergeSort(items, (x, y) => {
      const r = result(x, y);
      if (r.need) {
        needCount++;
        if (!firstNeed) firstNeed = [x, y];
      }
      if (r.pending && !pending.some((p) => p.key === pairKey(x, y))) {
        pending.push({ key: pairKey(x, y), pair: [x, y], since: r.since });
      }
      return r.winner === x;
    });

    const ready = pending.find((p) => p.since >= CONFIG.repeatDelay);
    const next = ready ? ready.pair : firstNeed || (pending[0] && pending[0].pair) || null;
    return { order, done: !next, next, left: needCount + pending.length };
  }

  if (!question && finals && finals.next) {
    stage = 'finals';
    question = mk(finals.next[0], finals.next[1], 'finals', null);
  }
  left.finals = finals ? finals.left : Math.round(F * Math.log2(Math.max(2, F)) * 0.88);

  // ---- ranking assembly + 4. boundary challenges + 5. round robin ----------
  let order;
  if (!swissDone) order = thetaOrder.slice();
  else {
    const inF = new Set(finalists);
    const top = finals.done && CONFIG.finalOrder === 'sort' ? finals.order : finalists.slice().sort((x, y) => theta[y] - theta[x] || x - y);
    order = top.concat(thetaOrder.filter((i) => !inF.has(i)));
  }

  const ratingMode = CONFIG.finalOrder === 'rating';
  // The order as it stood just before a stage's first pick, so the boundary
  // windows and the round-robin lineup stay fixed while you answer them.
  const orderAtStageStart = (st) => {
    let k0 = Infinity;
    for (const m of matches) if (m.e.s === st && m.k < k0) k0 = m.k;
    if (k0 === Infinity) return order;
    const th = fitBT(n, tierOf, matches.filter((m) => m.k < k0)).theta;
    const inF = new Set(finalists);
    return finalists.slice().sort((x, y) => th[y] - th[x] || x - y).concat(orderBy(n, th).filter((i) => !inF.has(i)));
  };
  const stageCount = (st) => matches.reduce((a, m) => a + (m.e.s === st ? 1 : 0), 0);
  const boundary = [];
  let boundaryDone = false;
  // In rating mode the windows follow the live order, so answers can shift which
  // cards sit at a cutoff. The cap guarantees the stage always ends.
  const boundaryCapped = ratingMode && stageCount('boundary') >= CONFIG.cutoffs.length * 4 * 3;
  if (finals && finals.done) {
    boundaryDone = true;
    const cuts = CONFIG.cutoffs.filter((c) => c >= 2 && c + 2 <= order.length).sort((x, y) => y - x);
    const base = ratingMode ? orderAtStageStart('boundary') : order.slice();
    for (const c of cuts) {
      const inside = [base[c - 2], base[c - 1]];
      const outside = [base[c], base[c + 1]];
      const pairs = [];
      for (const o of outside) for (const d of [inside[1], inside[0]]) pairs.push([o, d]);
      const res = pairs.map(([o, d]) => {
        const ms = (byPair.get(pairKey(o, d)) || []).filter((m) => m.e.s === 'boundary');
        if (!ms.length) return null;
        let so = 0;
        for (const m of ms) so += scoreFor(m, o);
        return so / ms.length; // challenger's score
      });
      const missing = pairs.filter((_, k) => res[k] === null);
      left.boundary += missing.length;
      boundary.push({ cutoff: c, inside, outside, pairs, res, complete: !missing.length || boundaryCapped });
      if (missing.length && !question && !boundaryCapped) {
        stage = 'boundary';
        const [o, d] = missing[0];
        question = mk(o, d, 'boundary', null, { cutoff: c });
      }
    }
    if (boundaryCapped) left.boundary = 0;
    for (const w of boundary) {
      if (!w.complete) { boundaryDone = false; continue; }
      if (ratingMode) continue;
      const win = [...w.inside, ...w.outside];
      const pos = new Map(win.map((x) => [x, order.indexOf(x)]));
      const pts = new Map(win.map((x) => [x, 0]));
      const h2h = new Map();
      w.pairs.forEach(([o, d], k) => {
        pts.set(o, pts.get(o) + w.res[k]);
        pts.set(d, pts.get(d) + 1 - w.res[k]);
        if (w.res[k] !== 0.5) h2h.set(pairKey(o, d), w.res[k] > 0.5 ? o : d);
      });
      const sorted = win.slice().sort((x, y) => {
        const dp = pts.get(y) - pts.get(x);
        if (dp) return dp;
        const hw = h2h.get(pairKey(x, y));
        if (hw !== undefined) return hw === x ? -1 : 1;
        return pos.get(x) - pos.get(y);
      });
      const slots = win.map((x) => pos.get(x)).sort((a, b) => a - b);
      sorted.forEach((x, k) => (order[slots[k]] = x));
    }
  } else {
    left.boundary = CONFIG.cutoffs.length * 4;
  }

  let rr = null;
  const rrCapped = ratingMode && stageCount('roundrobin') >= CONFIG.topN * (CONFIG.topN - 1);
  if (boundaryDone) {
    const top = (ratingMode ? orderAtStageStart('roundrobin') : order).slice(0, Math.min(CONFIG.topN, order.length));
    const pts = new Map(top.map((x) => [x, 0]));
    const winner = new Map();
    let missing = 0;
    for (let a = 0; a < top.length; a++) {
      for (let b = a + 1; b < top.length; b++) {
        const x = top[a];
        const y = top[b];
        const ms = byPair.get(pairKey(x, y)) || [];
        let sx = null;
        const rrMs = ms.filter((m) => m.e.s === 'roundrobin');
        if (rrMs.length) sx = scoreFor(rrMs[rrMs.length - 1], x);
        else if (ms.length && !CONFIG.rrFresh) {
          let wx = 0;
          let wy = 0;
          for (const m of ms) {
            const sc = scoreFor(m, x);
            if (sc === 1) wx++;
            else if (sc === 0) wy++;
          }
          sx = wx > wy ? 1 : wy > wx ? 0 : 0.5;
        }
        if (sx === null && rrCapped) continue;
        if (sx === null) {
          missing++;
          if (!question) {
            stage = 'roundrobin';
            question = mk(x, y, 'roundrobin', null);
          }
          continue;
        }
        pts.set(x, pts.get(x) + sx);
        pts.set(y, pts.get(y) + 1 - sx);
        if (sx !== 0.5) winner.set(pairKey(x, y), sx === 1 ? x : y);
      }
    }
    left.roundrobin = missing;
    rr = { top, pts, complete: !missing };
    if (!missing && !ratingMode) {
      const groups = new Map();
      for (const x of top) {
        const p = pts.get(x);
        if (!groups.has(p)) groups.set(p, []);
        groups.get(p).push(x);
      }
      const pos = new Map(top.map((x, k) => [x, k]));
      const sorted = [];
      for (const p of [...groups.keys()].sort((a, b) => b - a)) {
        const g = groups.get(p);
        // Tiebreak: head-to-head within the tied group, then previous position.
        const mini = new Map(g.map((x) => [x, 0]));
        for (const x of g) for (const y of g) if (x !== y && winner.get(pairKey(x, y)) === x) mini.set(x, mini.get(x) + 1);
        g.sort((x, y) => mini.get(y) - mini.get(x) || pos.get(x) - pos.get(y));
        sorted.push(...g);
      }
      sorted.forEach((x, k) => (order[k] = x));
    }
  } else {
    left.roundrobin = Math.round(CONFIG.topN * (CONFIG.topN - 1) / 2 * (CONFIG.rrFresh ? 1 : 0.35));
  }

  if (!question) stage = 'done';

  const rank = new Array(n);
  order.forEach((i, r) => (rank[i] = r + 1));

  // Consistency: of the matchups you've answered more than once (hidden repeats,
  // misclick checks, boundary and round-robin rematches), how often you agreed.
  let checked = 0;
  let agreed = 0;
  for (const ms of byPair.values()) {
    const dec = ms.filter((m) => m.s !== 0.5).map((m) => (m.s === 1 ? m.i : m.j));
    if (dec.length < 2) continue;
    checked++;
    if (dec.every((w) => w === dec[0])) agreed++;
  }

  const picksLeft = Object.values(left).reduce((a, b) => a + b, 0);
  const tierQueue = untiered.slice(0, 6).map((i) => cards[i].id);

  return {
    stage,
    round,
    question,
    order: order.map((i) => cards[i].id),
    rank: (id) => rank[index.get(id)],
    theta: (id) => theta[index.get(id)],
    sigma: (id) => sigma[index.get(id)],
    rating: (id) => toRating(theta[index.get(id)]),
    record: (id) => records[index.get(id)],
    tier: (id) => tierOf[index.get(id)],
    matchesFor: (id) => byCard[index.get(id)].map((m) => m.e),
    tierQueue,
    rescueCandidates: rescueCandidates.map((i) => cards[i].id),
    finalists: finalists ? finalists.map((i) => cards[i].id) : null,
    swissDone,
    finalsDone: !!(finals && finals.done),
    boundary: boundary.map((w) => ({ cutoff: w.cutoff, complete: w.complete })),
    rrComplete: !!(rr && rr.complete),
    contenderCount,
    consistency: { checked, agreed },
    progress: { done: events.length, left: picksLeft, byStage: left },
  };
}
