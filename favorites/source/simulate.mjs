// Plays a full simulated favourites session: node favorites/source/simulate.mjs [heartRate=0.22]
import { readFileSync } from 'node:fs';
import { derive } from '../js/fav-engine.js';
import { hash01 } from '../js/engine.js';

import { CONFIG } from '../js/engine.js';
const heartRate = Number(process.argv[2] ?? 0.22);
const noise = Number(process.argv[3] ?? 0);   // per-answer noise, as a share of the favourites' spread
const runs = Number(process.argv[4] ?? 1);
for (const kv of process.argv.slice(5)) { const [k, v] = kv.split('='); CONFIG[k] = isNaN(v) ? v : Number(v); }
const ids = readFileSync(new URL('./cool-cards-ids.txt', import.meta.url), 'utf8').trim().split(',');
const cards = ids.map((id) => ({ id, name: id }));
const truth = new Map(ids.map((id) => [id, hash01('t' + id)]));
let agg = { picks: 0, missed: 0, err10: 0, err50: 0, exact10: 0 };
for (let run = 0; run < runs; run++) {
let rc = 0;
const rnd = () => hash01(`n${run}:${rc++}`);
const gauss = () => (rnd() + rnd() + rnd() + rnd() - 2) * 1.732;
const save = { seed: 'sim' + run, events: [], nextId: 1 };
const counts = {};
let d;
let maxMs = 0;
for (let step = 0; step < 8000; step++) {
  const t0 = performance.now();
  d = derive(save, cards);
  maxMs = Math.max(maxMs, performance.now() - t0);
  const q = d.question;
  if (!q) break;
  counts[q.stage] = (counts[q.stage] || 0) + 1;
  const ev = { id: save.nextId++ };
  if (q.kind === 'triage') Object.assign(ev, { t: 'triage', p: q.page, keep: q.cards.filter((id) => truth.get(id) > 1 - heartRate) });
  else if (q.kind === 'review') Object.assign(ev, { t: 'mark', m: 'tiers-reviewed' });
  else if (q.kind === 'heart-review') Object.assign(ev, { t: 'mark', m: 'hearts-reviewed' });
  else if (q.kind === 'tier') {
    const v = (truth.get(q.card) - (1 - heartRate)) / heartRate;
    Object.assign(ev, { t: 'tier', c: q.card, v: v > 0.75 ? 'S' : v > 0.5 ? 'A' : v > 0.25 ? 'B' : 'C' });
  } else Object.assign(ev, { t: 'match', a: q.a, b: q.b, w: truth.get(q.a) - truth.get(q.b) + gauss() * noise * heartRate > 0 ? 'a' : 'b', s: q.stage, r: q.round });
  save.events.push(ev);
}
const trueOrder = ids.slice().sort((a, b) => truth.get(b) - truth.get(a));
const tr = new Map(trueOrder.map((id, k) => [id, k + 1]));
const fin = new Set(d.finalists || []);
agg.picks += save.events.length;
agg.missed += trueOrder.slice(0, 50).filter((id) => !fin.has(id)).length;
agg.err10 += d.order.slice(0, 10).reduce((a, id, k) => a + Math.abs(tr.get(id) - (k + 1)), 0) / 10;
agg.err50 += d.order.slice(0, 50).reduce((a, id, k) => a + Math.abs(tr.get(id) - (k + 1)), 0) / 50;
if (d.order.slice(0, 10).every((id, k) => id === trueOrder[k])) agg.exact10++;
if (run === 0) console.log('favourites', d.favCount, counts, `slowest ${maxMs.toFixed(0)}ms`);
}
const f = (x) => (x / runs).toFixed(2);
console.log(`picks ${f(agg.picks)} | true top-50 missing from finals ${f(agg.missed)} | top-10 err ${f(agg.err10)} (exact ${agg.exact10}/${runs}) | top-50 err ${f(agg.err50)}`);
