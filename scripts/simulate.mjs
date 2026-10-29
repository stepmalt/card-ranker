// Benchmarks the ranking engine against simulated users with a hidden "true"
// preference order, picking noisily and occasionally misclicking.
//
//   node scripts/simulate.mjs [runs=6] [noise=0.35] [misclick=0.02] [key=value ...]
//
// key=value pairs override CONFIG, e.g. finalists=110. Reports picks per stage
// and the mean rank error (|final rank - true rank|) per bracket.
import { readFileSync } from 'node:fs';
import { derive, hash01, CONFIG } from '../js/engine.js';

const TIER_NOISE = Number(process.env.TIER_NOISE ?? 0.35);
const [runs = 6, noise = 0.35, misclick = 0.02] = process.argv.slice(2, 5).map(Number);
for (const kv of process.argv.slice(5)) {
  const [k, v] = kv.split('=');
  CONFIG[k] = v.includes(',') ? v.split(',').map(Number) : Number(v);
}

const cards = JSON.parse(readFileSync(new URL('../cards.json', import.meta.url)));
const index = new Map(cards.map((c, i) => [c.id, i]));
const n = cards.length;

// Inverse normal CDF (Acklam) for evenly spread "true" scores.
function probit(p) {
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const q = p < 0.5 ? p : 1 - p;
  let x;
  if (q > 0.02425) {
    const r = q - 0.5; const s = r * r;
    x = (((((a[0] * s + a[1]) * s + a[2]) * s + a[3]) * s + a[4]) * s + a[5]) * r / (((((b[0] * s + b[1]) * s + b[2]) * s + b[3]) * s + b[4]) * s + 1);
  } else {
    const r = Math.sqrt(-2 * Math.log(q));
    x = (((((c[0] * r + c[1]) * r + c[2]) * r + c[3]) * r + c[4]) * r + c[5]) / ((((d[0] * r + d[1]) * r + d[2]) * r + d[3]) * r + 1);
  }
  return p < 0.5 ? x : -x;
}

const BRACKETS = [[1, 10], [11, 25], [26, 50], [51, 100], [101, 150], [151, n]];
const totals = { picks: 0, stages: {}, err: BRACKETS.map(() => 0), alt: BRACKETS.map(() => 0), exact10: 0, top100: 0 };

for (let run = 0; run < runs; run++) {
  let rc = 0;
  const rand = () => hash01(`run${run}:${rc++}`);
  const gauss = () => probit(Math.min(0.999999, Math.max(1e-6, rand())));
  // True scores: normal quantiles assigned to cards in a random order.
  const perm = cards.map((c, i) => [hash01(`perm${run}:${i}`), c.id]).sort((x, y) => x[0] - y[0]).map((x) => x[1]);
  const truth = new Map(perm.map((id, k) => [id, probit((n - k - 0.5) / n) * 1.6]));
  const trueRank = new Map(perm.map((id, k) => [id, k + 1]));

  const save = { seed: `bench${run}`, events: [], nextId: 1 };
  let d;
  for (let step = 0; step < 6000; step++) {
    d = derive(save, cards, index);
    const q = d.question;
    if (!q) break;
    totals.stages[q.stage] = (totals.stages[q.stage] || 0) + 1;
    if (q.kind === 'review') {
      save.events.push({ id: save.nextId++, t: 'mark', m: 'tiers-reviewed' });
    } else if (q.kind === 'tier') {
      const v = truth.get(q.card) + gauss() * TIER_NOISE;
      save.events.push({ id: save.nextId++, t: 'tier', c: q.card, v: v > 1.3 ? 'S' : v > 0.3 ? 'A' : v > -0.7 ? 'B' : 'C' });
    } else {
      const diff = truth.get(q.a) - truth.get(q.b) + gauss() * noise * Math.SQRT2;
      let w = Math.abs(diff) < 0.02 ? 't' : diff > 0 ? 'a' : 'b';
      if (w !== 't' && rand() < misclick) w = w === 'a' ? 'b' : 'a';
      const ev = { id: save.nextId++, t: 'match', a: q.a, b: q.b, w, s: q.stage };
      if (q.round) ev.r = q.round;
      save.events.push(ev);
    }
  }
  totals.picks += save.events.length;
  d.order.forEach((id, k) => {
    const tr = trueRank.get(id);
    const bi = BRACKETS.findIndex(([lo, hi]) => tr >= lo && tr <= hi);
    totals.err[bi] += Math.abs(k + 1 - tr) / (BRACKETS[bi][1] - BRACKETS[bi][0] + 1);
  });
  // Alternative: order the finalists by their all-results rating instead of the sort.
  if (d.finalists) {
    const fin = new Set(d.finalists);
    const alt = d.finalists.slice().sort((x, y) => d.theta(y) - d.theta(x)).concat(d.order.filter((id) => !fin.has(id)));
    alt.forEach((id, k) => {
      const tr = trueRank.get(id);
      const bi = BRACKETS.findIndex(([lo, hi]) => tr >= lo && tr <= hi);
      totals.alt[bi] += Math.abs(k + 1 - tr) / (BRACKETS[bi][1] - BRACKETS[bi][0] + 1);
    });
  }
  if (d.order.slice(0, 10).every((id, k) => trueRank.get(id) === k + 1)) totals.exact10++;
  totals.top100 += d.order.slice(0, 100).filter((id) => trueRank.get(id) <= 100).length;
}

const avg = (x) => (x / runs).toFixed(1);
console.log(`runs=${runs} noise=${noise} misclick=${misclick} finalists=${CONFIG.finalists}`);
console.log('picks', avg(totals.picks), Object.fromEntries(Object.entries(totals.stages).map(([k, v]) => [k, Math.round(v / runs)])));
console.log('mean rank error by true rank:', BRACKETS.map(([lo, hi], k) => `${lo}-${hi}: ${(totals.err[k] / runs).toFixed(2)}`).join('  '));
console.log('  (rating-ordered finals):  ', BRACKETS.map(([lo, hi], k) => `${lo}-${hi}: ${(totals.alt[k] / runs).toFixed(2)}`).join('  '));
console.log(`exact top 10: ${totals.exact10}/${runs}   true top 100 found in top 100: ${avg(totals.top100)}`);
