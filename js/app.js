import { derive, CONFIG, TIERS, TIER_INFO, stageLabel } from './engine.js';

const STORE_KEY = 'cardRanker.save.v1';
const REMIND_EVERY = 100;
const REMIND_DAYS = 3;
const TIP_KEY = 'cardRanker.homeTip.v1';
const HOLD_MS = 420;
const CARD_RATIO = 1024 / 733;
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');

const $ = (sel, el = document) => el.querySelector(sel);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

let cards = [];
const byId = new Map();
const index = new Map();
let save = null;
let d = null;
const ui = { interstitial: null, busy: false, layers: [], lastRemindAt: 0, zoom: null, hold: null };

// ---------------------------------------------------------------- storage

function newSave(name) {
  return {
    app: 'card-ranker',
    v: 1,
    name,
    seed: Math.random().toString(36).slice(2, 10),
    created: Date.now(),
    events: [],
    nextId: 1,
    picksAtLastBackup: 0,
    lastBackupAt: null,
  };
}

function persist() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(save));
  } catch (err) {
    toast("Couldn't autosave on this device — please use Back up.", { ms: 6000 });
  }
}

function loadStored() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    return raw ? validateSave(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

function validateSave(s) {
  if (!s || typeof s !== 'object' || !Array.isArray(s.events) || typeof s.seed !== 'string') return null;
  s.name = String(s.name || 'My Ranking');
  s.nextId = Math.max(s.nextId || 1, ...s.events.map((e) => (e.id || 0) + 1), 1);
  s.events.forEach((e, k) => { if (!e.id) e.id = s.nextId + k; });
  s.nextId += s.events.length;
  s.picksAtLastBackup = s.picksAtLastBackup || 0;
  s.lastBackupAt = s.lastBackupAt || null;
  return s;
}

function recompute() {
  d = save ? derive(save, cards, index) : null;
}

// ---------------------------------------------------------------- helpers

const card = (id) => byId.get(id);

function stageOfEvent(e) {
  if (e.s === 'swiss') return `Swiss · Round ${e.r}`;
  return { rescue: 'Rescue round', finals: 'Finals', boundary: 'Boundary challenge', roundrobin: 'Top 10 round robin' }[e.s] || e.s;
}

function tierPill(t) {
  return t ? `<span class="tier-pill tier-${t}" title="${TIER_INFO[t].label}">${t}</span>` : '<span class="tier-pill" title="Not drafted yet">·</span>';
}

function recordText(r) {
  return `${r.w}–${r.l}${r.t ? `–${r.t}` : ''}`;
}

const normalize = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

function download(filename, text, type) {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

const slug = (s) => normalize(s).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'ranking';
const today = () => new Date().toISOString().slice(0, 10);

// ---------------------------------------------------------------- preloading

const imgCache = new Map();
function preload(url) {
  if (!url || imgCache.has(url)) return;
  const im = new Image();
  im.decoding = 'async';
  im.src = url;
  imgCache.set(url, im);
  if (im.decode) im.decode().catch(() => {});
  if (imgCache.size > 80) imgCache.delete(imgCache.keys().next().value);
}

function preloadQuestion(q) {
  if (!q) return;
  if (q.kind === 'tier') preload(card(q.card).image);
  else if (q.kind === 'match') { preload(card(q.a).image); preload(card(q.b).image); }
}

// Work out what the next question would be for every possible answer and warm
// those images, so the next matchup appears instantly.
function preloadAhead() {
  const q = d && d.question;
  if (!q) return;
  if (q.kind === 'tier') {
    d.tierQueue.slice(1, 5).forEach((id) => preload(card(id).image));
    if (d.tierQueue.length > 2) return;
  }
  const outcomes = q.kind === 'review' ? [{ t: 'mark', m: 'tiers-reviewed' }]
    : q.kind === 'tier' ? [{ t: 'tier', c: q.card, v: 'B' }]
    : ['a', 'b', 't'].map((w) => ({ t: 'match', a: q.a, b: q.b, w, s: q.stage, r: q.round }));
  for (const ev of outcomes) {
    const next = derive({ ...save, events: [...save.events, ev] }, cards, index).question;
    preloadQuestion(next);
  }
}

// ---------------------------------------------------------------- actions

function commit(ev) {
  const prevQ = d.question;
  ev.id = save.nextId++;
  ev.ts = Date.now();
  save.events.push(ev);
  persist();
  recompute();
  const t = transition(prevQ, d.question);
  if (t === 'done') {
    ui.interstitial = null;
    render();
    openLayer('results');
    toast('🎉 Ranking complete! Here are your results.', { ms: 4000 });
  } else {
    ui.interstitial = t;
    render();
  }
  maybeRemind();
}

function transition(prevQ, nextQ) {
  if (!prevQ) return null;
  if (!nextQ) return 'done';
  // The review screen already explains what comes next.
  if (prevQ.kind === 'review') return null;
  if (prevQ.stage === nextQ.stage && prevQ.round === nextQ.round) return null;
  return { from: { stage: prevQ.stage, round: prevQ.round }, to: { stage: nextQ.stage, round: nextQ.round } };
}

function undo() {
  if (!save || !save.events.length || ui.busy) return;
  const ev = save.events.pop();
  persist();
  recompute();
  ui.interstitial = null;
  render();
  refreshLayers();
  const what = ev.t === 'tier' ? `${card(ev.c)?.name} → ${ev.v}` : ev.t === 'mark' ? 'start of the swiss rounds' : `${card(ev.a)?.name} vs ${card(ev.b)?.name}`;
  toast(`↶ Undid ${esc(what)}`, { ms: 1800 });
}

function pickMatch(w) {
  const q = d && d.question;
  if (ui.busy || !q || q.kind !== 'match' || ui.interstitial) return;
  ui.busy = true;
  const slots = document.querySelectorAll('.arena .slot');
  if (w === 't') slots.forEach((s) => s.classList.add('tied'));
  else {
    const win = slots[w === 'a' ? 0 : 1];
    win.classList.add('won');
    slots[w === 'a' ? 1 : 0].classList.add('lost');
    burst(win);
  }
  setTimeout(() => {
    ui.busy = false;
    const ev = { t: 'match', a: q.a, b: q.b, w, s: q.stage };
    if (q.round) ev.r = q.round;
    commit(ev);
  }, reduceMotion.matches ? 60 : 250);
}

function pickTier(tier) {
  const q = d && d.question;
  if (ui.busy || !q || q.kind !== 'tier' || ui.interstitial) return;
  ui.busy = true;
  document.querySelector(`.tier-btn.tier-${tier}`)?.classList.add('flash');
  const slot = $('.tier-card-wrap .slot');
  if (slot) { burst(slot, tier); slot.classList.add('fly'); }
  setTimeout(() => {
    ui.busy = false;
    commit({ t: 'tier', c: q.card, v: tier });
  }, reduceMotion.matches ? 60 : 200);
}

function burst(el, tier) {
  if (reduceMotion.matches) return;
  const b = document.createElement('div');
  b.className = 'burst';
  const colors = tier ? [`var(--tier-${tier})`, '#fff'] : ['#ffadd6', '#c8b4ff', '#9fe3c7', '#a6d4ff', '#fff'];
  for (let k = 0; k < 12; k++) {
    const i = document.createElement('i');
    const ang = (k / 12) * Math.PI * 2;
    const dist = 70 + Math.random() * 60;
    i.style.setProperty('--x', `${Math.cos(ang) * dist}px`);
    i.style.setProperty('--y', `${Math.sin(ang) * dist}px`);
    i.style.setProperty('--c', colors[k % colors.length]);
    b.appendChild(i);
  }
  el.appendChild(b);
}

function backup() {
  save.picksAtLastBackup = save.events.length;
  save.lastBackupAt = Date.now();
  download(`${slug(save.name)}-${today()}.json`, JSON.stringify(save), 'application/json');
  persist();
  toast('💾 Backup downloaded', { ms: 2200 });
}

const daysSince = (ts) => (Date.now() - ts) / 86400000;

function maybeRemind() {
  const n = save.events.length;
  const unsaved = n - save.picksAtLastBackup;
  if (unsaved >= REMIND_EVERY && n - ui.lastRemindAt >= REMIND_EVERY) {
    ui.lastRemindAt = n;
    toast(`${unsaved} picks since your last backup ☁️`, { ms: 8000, action: { label: 'Back up', fn: backup } });
    return;
  }
  // Browsers (Safari especially) may clear site data after a stretch away, so
  // also nudge once per visit when the last backup is a few days old.
  const since = daysSince(save.lastBackupAt || save.created);
  if (!ui.remindedDays && unsaved >= 10 && since >= REMIND_DAYS) {
    ui.remindedDays = true;
    toast(`${Math.floor(since)} days since your last backup — ${unsaved} picks only live in this browser ☁️`, { ms: 10000, action: { label: 'Back up', fn: backup } });
  }
}

function backupStatus() {
  if (!save.lastBackupAt) return 'Never backed up';
  const days = Math.floor(daysSince(save.lastBackupAt));
  const when = days < 1 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`;
  return `Last backup ${when} (at pick ${save.picksAtLastBackup})`;
}

// Ask the browser to keep this site's data instead of clearing it when space
// runs low or after a while unused. Browsers may say no; backups are the fallback.
function requestPersistence() {
  if (!navigator.storage || !navigator.storage.persist) return;
  navigator.storage.persisted().then((p) => p || navigator.storage.persist()).catch(() => {});
}

const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;

function homeTipDismissed() {
  try { return localStorage.getItem(TIP_KEY) === '1'; } catch { return true; }
}

function maybeHomeTip() {
  if (!isIOS || isStandalone || homeTipDismissed() || ui.tipShown) return;
  ui.tipShown = true;
  toast('📱 On iPhone, ranking from the Home Screen keeps your picks safer.', { ms: 10000, action: { label: 'How?', fn: () => openLayer('install') } });
}

function loadBackupFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    let s = null;
    try { s = validateSave(JSON.parse(reader.result)); } catch { s = null; }
    if (!s) { toast("That file doesn't look like a Card Ranker backup."); return; }
    if (save && save.events.length && !confirm(`Replace "${save.name}" (${save.events.length} picks) with "${s.name}" (${s.events.length} picks)?`)) return;
    save = s;
    save.picksAtLastBackup = save.events.length;
    save.lastBackupAt = Date.now();
    persist();
    requestPersistence();
    recompute();
    ui.interstitial = null;
    closeAllLayers();
    render();
    toast(`✨ Loaded "${esc(save.name)}" — ${save.events.length} picks`);
  };
  reader.readAsText(file);
}

function exportCsv() {
  const lines = [['rank', 'name', 'set', 'number', 'tier', 'rating', 'wins', 'losses', 'ties', 'id'].join(',')];
  d.order.forEach((id, k) => {
    const c = card(id);
    const r = d.record(id);
    const q = (s) => `"${String(s).replace(/"/g, '""')}"`;
    lines.push([k + 1, q(c.name), q(c.set), q(c.number), d.tier(id) || '', d.rating(id), r.w, r.l, r.t, id].join(','));
  });
  download(`${slug(save.name)}-results-${today()}.csv`, '﻿' + lines.join('\n'), 'text/csv');
}

// Editing from a card's detail sheet is a two-step flow: open the editor, pick
// the new outcome, then Save. Nothing changes until Save is tapped.

const outcomeFor = (e, id) => (e.w === 't' ? 't' : e.w === (e.a === id ? 'a' : 'b') ? 'won' : 'lost');

function detailLayerOf(el) {
  return ui.layers.find((l) => l.type === 'detail' && l.el.contains(el));
}

function rankChange(id, before) {
  const after = d.rank(id);
  const name = esc(card(id).name);
  if (after === before) return `${name} stays #${after}`;
  return `${name} #${before} → <b>#${after}</b> <span class="${after < before ? 'up' : 'down'}">${after < before ? '▲' : '▼'}${Math.abs(after - before)}</span>`;
}

// Apply a change to the log, recalculate, and report what moved.
function applyEdit(ids, change) {
  const before = ids.map((id) => d.rank(id));
  const stageBefore = d.question && d.question.stage;
  change();
  persist();
  recompute();
  ui.interstitial = null;
  render();
  const moves = ids.map((id, k) => rankChange(id, before[k])).join('<br>');
  const extra = d.question && d.question.stage !== stageBefore && d.question.stage !== 'tier'
    ? `<br><small>This needs one new comparison — it's up next (${stageLabel(d.question.stage, d.question.round)}).</small>` : '';
  return moves + extra;
}

function saveResultEdit(layer) {
  const { id, editing, choice } = layer.data;
  const e = save.events.find((x) => x.id === editing);
  if (!e || !choice || choice === outcomeFor(e, id)) return;
  const prevW = e.w;
  const mine = e.a === id ? 'a' : 'b';
  const opp = e.a === id ? e.b : e.a;
  const report = applyEdit([id, opp], () => {
    e.w = choice === 't' ? 't' : choice === 'won' ? mine : mine === 'a' ? 'b' : 'a';
    e.edited = Date.now();
  });
  const what = choice === 't' ? `${esc(card(id).name)} and ${esc(card(opp).name)} now tie`
    : choice === 'won' ? `${esc(card(id).name)} now beats ${esc(card(opp).name)}` : `${esc(card(opp).name)} now beats ${esc(card(id).name)}`;
  layer.data.editing = null;
  layer.data.choice = null;
  layer.data.notice = { at: e.id, html: `<b>✓ Saved</b> · ${what}<br>${report}`, undo: { kind: 'result', eventId: e.id, prev: prevW } };
  refreshLayers();
}

function saveTierEdit(layer) {
  const { id, tierPending } = layer.data;
  const cur = d.tier(id);
  if (!tierPending || tierPending === cur) return;
  let ev = null;
  for (const e of save.events) if (e.t === 'tier' && e.c === id) ev = e;
  let undo = null;
  const report = applyEdit([id], () => {
    if (ev) {
      undo = { kind: 'tier', eventId: ev.id, prev: ev.v };
      ev.v = tierPending;
      ev.edited = Date.now();
    } else {
      // Not drafted yet: this counts as its tier pick.
      const add = { id: save.nextId++, t: 'tier', c: id, v: tierPending, ts: Date.now() };
      save.events.push(add);
      undo = { kind: 'tier-new', eventId: add.id };
    }
  });
  layer.data.tierPending = null;
  layer.data.notice = { at: 'tier', html: `<b>✓ Saved</b> · ${esc(card(id).name)} is now ${tierPill(d.tier(id))} ${TIER_INFO[d.tier(id)].label}<br>${report}`, undo };
  refreshLayers();
}

function undoEdit(layer) {
  const u = layer.data.notice && layer.data.notice.undo;
  if (!u) return;
  const ids = [layer.data.id];
  const report = applyEdit(ids, () => {
    const idx = save.events.findIndex((x) => x.id === u.eventId);
    if (idx < 0) return;
    if (u.kind === 'tier-new') save.events.splice(idx, 1);
    else if (u.kind === 'tier') save.events[idx].v = u.prev;
    else save.events[idx].w = u.prev;
  });
  layer.data.notice = { at: layer.data.notice.at, html: `<b>↶ Change undone</b><br>${report}`, undo: null };
  refreshLayers();
}

// ---------------------------------------------------------------- rendering: main

const main = $('#main');

function render() {
  const header = $('.topbar');
  header.hidden = !save;
  if (!save) { main.innerHTML = welcomeView(); return; }
  renderHeader();
  const q = d.question;
  if (ui.interstitial) main.innerHTML = interstitialView(ui.interstitial);
  else if (!q) main.innerHTML = doneView();
  else if (q.kind === 'tier') main.innerHTML = tierView(q);
  else if (q.kind === 'review') main.innerHTML = reviewGateView();
  else main.innerHTML = matchView(q);
  sizeArena();
  preloadQuestion(q);
  setTimeout(preloadAhead, 40);
}

function renderHeader() {
  $('.save-name').textContent = save.name;
  const { done, left } = d.progress;
  const pct = left ? Math.min(99, (done / (done + left)) * 100) : 100;
  $('.progress-fill').style.width = `${pct}%`;
  $('.progress').setAttribute('aria-valuenow', Math.round(pct));
  $('.progress-stage').textContent = d.question ? stageLabel(d.question.stage, d.question.round) : 'Complete ✨';
  $('.progress-left').textContent = left ? `${done} picks · ~${left} to go` : `${done} picks · all done!`;
}

function welcomeView() {
  return `<div class="center"><div class="panel">
    <h1>✨ Card Ranker ✨</h1>
    <p>Rank all ${cards.length} of your cards, one happy little pick at a time.</p>
    <ul class="funnel">
      <li><b>1 · Tier draft</b> — sort each card into S / A / B / C</li>
      <li><b>2 · Swiss rounds</b> — ${CONFIG.swissRounds} rounds of this-or-that, plus a rescue round for underdogs</li>
      <li><b>3 · Finals</b> — the top ${CONFIG.finalists} get a full head-to-head sort</li>
      <li><b>4 · Boundary challenges</b> — cards just outside ${CONFIG.cutoffs.map((c) => `#${c}`).join(', ')} get a shot</li>
      <li><b>5 · Top 10 round robin</b> — everyone plays everyone</li>
    </ul>
    <form data-form="start">
      <input class="text-input" name="name" maxlength="40" placeholder="Name your save, e.g. Steph's Ranking" autocomplete="off" required>
      <button class="btn primary" type="submit">Start ranking ✨</button>
    </form>
    <button class="link-btn" data-action="load">or load a backup</button>
  </div></div>`;
}

function slotHtml(id, side) {
  const c = card(id);
  return `<div class="slot" data-side="${side}">
    <span class="key-hint">${side === 'a' ? '←' : '→'}</span>
    <button class="pick" data-action="pick" data-w="${side}" data-hold="${c.image}" aria-label="Pick ${esc(c.name)}">
      <img src="${c.image}" alt="${esc(c.name)}" width="733" height="1024" draggable="false">
    </button>
    <button class="zoom" data-action="zoom" data-src="${c.image}" aria-label="View ${esc(c.name)} full size">🔍</button>
  </div>`;
}

function matchNote(q) {
  if (q.stage === 'boundary') return `Boundary challenge · fighting for the Top ${q.cutoff}`;
  if (q.stage === 'rescue') return 'Rescue match · an underdog on a hot streak vs an A/S card';
  if (q.stage === 'finals') return 'Finals · which do you love more?';
  if (q.stage === 'roundrobin') return 'Top 10 round robin';
  if (q.stage === 'swiss' && q.round >= CONFIG.contenderFrom) return 'Contender round · both of these could make the finals';
  return 'Tap your favourite · hold to zoom';
}

function tierCounts() {
  return TIERS.map((t) => `<span class="tier-count" data-action="jump-tier" data-tier="${t}">${tierPill(t)} ${d.order.filter((id) => d.tier(id) === t).length}</span>`).join(' ');
}

function reviewGateView() {
  return `<div class="center"><div class="panel">
    <h2>🌸 Tier draft complete!</h2>
    <p>${tierCounts()}</p>
    <p>Before the swiss rounds start, look over your tiers and move anything that doesn't feel right. Changing your mind here is free.</p>
    <button class="btn primary" data-action="tiers">🔍 Review my tiers</button>
    <button class="btn" data-action="tiers-done">Looks good — start Swiss rounds ✨</button>
    <button class="btn" data-action="undo">↶ Undo last pick</button>
  </div></div>`;
}

function matchView(q) {
  return `<section class="play">
    <div class="stage-note">${matchNote(q)}</div>
    <div class="arena" data-mode="duel">
      ${slotHtml(q.a, 'a')}
      <div class="vs">vs</div>
      ${slotHtml(q.b, 'b')}
    </div>
    <div class="actions">
      <button class="btn" data-action="undo" ${save.events.length ? '' : 'disabled'} aria-label="Undo">↶ <span>Undo</span></button>
      <button class="btn grow" data-action="tie">Can't decide <small>(tie)</small></button>
    </div>
  </section>`;
}

function tierView(q) {
  const c = card(q.card);
  const left = d.progress.byStage.tier;
  return `<section class="play">
    <div class="stage-note">${cards.length - left + 2} of ${cards.length} · how do you feel about ${esc(c.name)}?</div>
    <div class="tier-card-wrap arena" data-mode="single">
      <div class="slot">
        <button class="pick" data-hold="${c.image}" data-action="zoom" data-src="${c.image}" aria-label="${esc(c.name)} — view full size">
          <img src="${c.image}" alt="${esc(c.name)}" width="733" height="1024" draggable="false">
        </button>
      </div>
    </div>
    <div class="tier-buttons">
      ${TIERS.map((t, k) => `<button class="tier-btn tier-${t}" data-action="tier" data-tier="${t}"><b>${t}</b><span>${TIER_INFO[t].label}</span><kbd>${k + 1}</kbd></button>`).join('')}
    </div>
    <div class="actions tier-actions">
      <button class="btn" data-action="undo" ${save.events.length ? '' : 'disabled'}>↶ Undo</button>
      <button class="btn" data-action="zoom" data-src="${c.image}">🔍 Zoom</button>
    </div>
  </section>`;
}

function miniRow(id, rank, extra = '') {
  const c = card(id);
  return `<li data-action="detail" data-card="${id}"><span class="r">${rank}</span><img src="${c.thumb}" alt="" loading="lazy"><span class="n">${esc(c.name)}</span>${extra}</li>`;
}

function roundStartIndex(stage, round) {
  return save.events.findIndex((e) => e.t === 'match' && e.s === stage && (stage !== 'swiss' || e.r === round));
}

function interstitialView(t) {
  const { from, to } = t;
  let title = '';
  let body = '';
  const nextLine = {
    swiss: to.round >= CONFIG.contenderFrom && d.contenderCount
      ? `Next up: <b>${stageLabel('swiss', to.round)}</b> — contenders only. ${d.contenderCount} cards still have a real shot at the top ${CONFIG.finalists}; the rest sit this one out (their spots are already clear).`
      : `Next up: <b>${stageLabel('swiss', to.round)}</b>. Cards are paired with similar ratings — cards near the ${CONFIG.cutoffs.map((c) => `#${c}`).join(', ')} lines get extra attention.`,
    rescue: `Next up: <b>Rescue round</b>. ${d.rescueCandidates.length} B/C cards with winning records each take on A/S cards, so a misplaced favourite can climb fast.`,
    finals: `Next up: <b>Finals</b>. The top ${CONFIG.finalists} go through a full head-to-head sort, so cards near #100 still get a shot. A few close calls — and any answer that looks like a misclick — get quietly double-checked.`,
    boundary: `Next up: <b>Boundary challenges</b>. The cards just outside ${CONFIG.cutoffs.map((c) => `#${c}`).join(', ')} challenge the ones just inside — win and they move in.`,
    roundrobin: `Next up: <b>Top 10 round robin</b>. Every top-10 card faces every other, fresh — even pairs you've already seen. Every answer counts toward the final order.`,
  }[to.stage] || '';

  if (from.stage === 'tier') {
    const counts = TIERS.map((x) => `${tierPill(x)} ${save.events.filter((e) => e.t === 'tier' && e.v === x).length}`).join(' &nbsp; ');
    title = '🌸 Tier draft complete!';
    body = `<p>${counts}</p>`;
  } else if (from.stage === 'swiss' || from.stage === 'rescue') {
    title = from.stage === 'swiss' ? `☁️ Round ${from.round} complete!` : '🦸 Rescue round complete!';
    if (to.stage === 'finals') title = '🌈 Swiss rounds complete!';
    const start = roundStartIndex(from.stage, from.round);
    const before = start > 0 ? derive({ ...save, events: save.events.slice(0, start) }, cards, index) : null;
    const delta = (id) => (before ? before.rank(id) - d.rank(id) : 0);
    const top = d.order.slice(0, 10).map((id, k) => {
      const dl = delta(id);
      return miniRow(id, k + 1, dl > 0 ? `<span class="up">▲${dl}</span>` : '');
    }).join('');
    const climbers = d.order.slice(10).filter((id) => delta(id) > 0).sort((x, y) => delta(y) - delta(x)).slice(0, 3)
      .map((id) => miniRow(id, d.rank(id), `<span class="up">▲${delta(id)}</span>`)).join('');
    body = `<div class="section-label">Standings · Top 10</div><ul class="mini-standings">${top}</ul>
      ${climbers ? `<div class="section-label">Biggest climbers</div><ul class="mini-standings">${climbers}</ul>` : ''}`;
  } else if (from.stage === 'finals') {
    title = '👑 Finals complete!';
    body = `<div class="section-label">Your Top 10 so far</div><ul class="mini-standings">${d.order.slice(0, 10).map((id, k) => miniRow(id, k + 1)).join('')}</ul>`;
  } else if (from.stage === 'boundary') {
    title = '⚔️ Boundary challenges complete!';
  } else {
    title = `✨ ${stageLabel(to.stage, to.round)}`;
  }
  return `<div class="center"><div class="panel">
    <h2>${title}</h2>
    ${body}
    <p>${nextLine}</p>
    <button class="btn primary" data-action="continue">Continue ✨</button>
    <button class="btn" data-action="undo">↶ Undo last pick</button>
  </div></div>`;
}

function doneView() {
  const top3 = d.order.slice(0, 3).map((id, k) => {
    const c = card(id);
    return `<div class="result-card" data-action="detail" data-card="${id}"><span class="badge">${k + 1}</span><img src="${c.thumb}" alt="${esc(c.name)}"><div class="cap">${esc(c.name)}</div></div>`;
  }).join('');
  return `<div class="center"><div class="panel">
    <h2>🎉 Ranking complete!</h2>
    <p>All ${save.events.length} picks are in. You can still edit any matchup from the leaderboard — everything recalculates live.</p>
    ${consistencyHtml()}
    <div class="hero-grid" style="grid-template-columns:repeat(3,1fr);margin:14px 0">${top3}</div>
    <button class="btn primary" data-action="results">See full results</button>
    <button class="btn" data-action="backup">💾 Back up</button>
  </div></div>`;
}

// Size the cards to fill the space: one card for the tier draft, two side by side for matchups.
function sizeArena() {
  const arena = $('.arena');
  if (!arena) return;
  const W = arena.clientWidth;
  const H = arena.clientHeight;
  if (!W || !H) return;
  let w;
  if (arena.dataset.mode === 'single') {
    w = Math.min(W, H / CARD_RATIO, 560);
  } else {
    const gap = W >= 900 ? 36 : 8;
    w = Math.min((W - gap) / 2, H / CARD_RATIO, 520);
  }
  arena.style.setProperty('--card-w', `${Math.floor(w)}px`);
}

// ---------------------------------------------------------------- layers (sheets)

const layersRoot = $('#layers');

function openLayer(type, data = {}) {
  const el = document.createElement('div');
  el.className = 'layer';
  const layer = { type, data, el };
  ui.layers.push(layer);
  layersRoot.appendChild(el);
  fillLayer(layer, true);
  if (type === 'board' && matchMedia('(hover: hover)').matches) $('.search', el)?.focus({ preventScroll: true });
}

function closeTopLayer() {
  const layer = ui.layers.pop();
  if (layer) layer.el.remove();
}

function closeAllLayers() {
  while (ui.layers.length) closeTopLayer();
}

function refreshLayers() {
  for (const layer of ui.layers) fillLayer(layer, false);
}

function fillLayer(layer, first) {
  const { el, type, data } = layer;
  const body = $('.sheet-body', el);
  const scroll = body ? body.scrollTop : 0;
  if (type === 'board') {
    if (first) {
      el.innerHTML = `<div class="backdrop" data-action="close"></div>
        <div class="sheet full" role="dialog" aria-label="Leaderboard">
          <div class="sheet-grip"></div>
          <div class="sheet-head"><h2>🏆 Live ranking</h2><button class="close-btn" data-action="close" aria-label="Close">✕</button></div>
          <div class="board-tools"><input class="search" type="search" placeholder="Find a Pokémon…" autocomplete="off" data-input="search"></div>
          <div class="board-meta"></div>
          <div class="sheet-body"><ul class="rows"></ul></div>
        </div>`;
    }
    $('.board-meta', el).textContent = boardMeta();
    $('.rows', el).innerHTML = boardRows($('.search', el).value);
  } else if (type === 'detail') {
    el.innerHTML = `<div class="backdrop" data-action="close"></div>
      <div class="sheet" role="dialog" aria-label="${esc(card(data.id).name)}">
        <div class="sheet-grip"></div>
        <div class="sheet-head"><h2>${esc(card(data.id).name)}</h2><button class="close-btn" data-action="close" aria-label="Close">✕</button></div>
        <div class="sheet-body">${detailBody(data.id, data)}</div>
      </div>`;
  } else if (type === 'menu') {
    el.innerHTML = `<div class="backdrop" data-action="close"></div>
      <div class="sheet" role="dialog" aria-label="Menu">
        <div class="sheet-grip"></div>
        <div class="sheet-head"><h2>${esc(save.name)}</h2><button class="close-btn" data-action="close" aria-label="Close">✕</button></div>
        <div class="sheet-body">
          <div class="menu-list">
            <button class="btn" data-action="backup">💾 Back up (download .json)</button>
            <button class="btn" data-action="load">📂 Load backup</button>
            <button class="btn" data-action="results">🌈 Results &amp; CSV export</button>
            <button class="btn" data-action="tiers">🗂️ Review tiers</button>
            ${isStandalone ? '' : '<button class="btn" data-action="install">📱 Add to Home Screen</button>'}
            <button class="btn" data-action="rename">✏️ Rename save</button>
            <button class="btn danger" data-action="reset">🗑️ Start over</button>
          </div>
          <p class="menu-note">${save.events.length} picks · ${backupStatus()}</p>
          <p class="menu-note">Keys: 1–4 tiers · ← → (or ↑ ↓) pick · Space tie · Z undo · L leaderboard · hold a card to zoom</p>
        </div>
      </div>`;
  } else if (type === 'tiers') {
    const gate = d.question && d.question.kind === 'review';
    el.innerHTML = `<div class="backdrop" data-action="close"></div>
      <div class="sheet full" role="dialog" aria-label="Review tiers">
        <div class="sheet-grip"></div>
        <div class="sheet-head"><h2>🗂️ Your tiers</h2><button class="close-btn" data-action="close" aria-label="Close">✕</button></div>
        <div class="board-meta">Tap any card to move it. Jump to: ${tierCounts()}</div>
        <div class="sheet-body">${tierReviewBody()}</div>
        ${gate ? '<div class="sheet-foot"><button class="btn primary" data-action="tiers-done">Looks good — start Swiss rounds ✨</button></div>' : ''}
      </div>`;
  } else if (type === 'retier') {
    const c = card(data.id);
    const cur = d.tier(data.id);
    el.innerHTML = `<div class="backdrop" data-action="close"></div>
      <div class="sheet" role="dialog" aria-label="Move ${esc(c.name)}">
        <div class="sheet-grip"></div>
        <div class="sheet-head"><h2>${esc(c.name)}</h2><button class="close-btn" data-action="close" aria-label="Close">✕</button></div>
        <div class="sheet-body retier">
          <img src="${c.image}" alt="${esc(c.name)}" data-action="zoom" data-src="${c.image}">
          <p>Currently ${cur ? `${tierPill(cur)} <b>${TIER_INFO[cur].label}</b>` : 'not tiered'} · move to:</p>
          <div class="tier-buttons">
            ${TIERS.map((t) => `<button class="tier-btn tier-${t} ${t === cur ? 'current' : ''}" data-action="retier-set" data-tier="${t}" data-card="${data.id}" ${t === cur ? 'disabled' : ''}><b>${t}</b><span>${t === cur ? 'current' : TIER_INFO[t].label}</span></button>`).join('')}
          </div>
        </div>
      </div>`;
  } else if (type === 'install') {
    const hasPicks = save && save.events.length > 0;
    el.innerHTML = `<div class="backdrop" data-action="close"></div>
      <div class="sheet" role="dialog" aria-label="Add to Home Screen">
        <div class="sheet-grip"></div>
        <div class="sheet-head"><h2>📱 Add to Home Screen</h2><button class="close-btn" data-action="close" aria-label="Close">✕</button></div>
        <div class="sheet-body install">
          <p>Safari can clear a website's saved data if you don't visit it for about a week. Opening Card Ranker from your Home Screen keeps your picks much safer, and it opens full screen like an app.</p>
          <ol>
            <li>In Safari, tap the <b>Share</b> button <span class="share-glyph">⬆︎</span> at the bottom of the screen.</li>
            <li>Scroll down and tap <b>Add to Home Screen</b>, then <b>Add</b>.</li>
            <li>Open <b>Card Ranker</b> from your Home Screen and rank from there.</li>
          </ol>
          ${hasPicks ? `<p class="install-warn"><b>Already have picks here?</b> The Home Screen app has its own separate storage. Tap <b>Back up</b> below first, then in the Home Screen app use <b>⋯ → Load backup</b> to bring them over.</p>
          <button class="btn primary" data-action="backup">💾 Back up now</button>` : ''}
          <button class="btn" data-action="tip-dismiss">Got it</button>
        </div>
      </div>`;
  } else if (type === 'results') {
    el.innerHTML = `<div class="backdrop" data-action="close"></div>
      <div class="sheet full" role="dialog" aria-label="Results">
        <div class="sheet-grip"></div>
        <div class="sheet-head"><h2>🌈 Results</h2><button class="pill-btn" data-action="csv">⬇ CSV</button><button class="close-btn" data-action="close" aria-label="Close">✕</button></div>
        <div class="sheet-body">${resultsBody()}</div>
      </div>`;
  }
  const nb = $('.sheet-body', el);
  if (nb && !first) nb.scrollTop = scroll;
}

function boardMeta() {
  if (d.stage === 'tier') return 'Ordered by tier while the draft is underway.';
  if (!d.swissDone) return 'Live Bradley-Terry ratings from every pick so far.';
  if (d.stage === 'done') return 'Final ranking ✨ Every answer counts toward it. Tap any card to see or edit its matchups.';
  return `Top ${CONFIG.finalists} are in the finals · ordered by a rating that combines every answer so far.`;
}

const SECTIONS = [[1, '🏆 Top 10'], [11, '⭐ Top 25'], [26, '💖 Top 50'], [51, '💫 Top 100'], [101, '☁️ Everyone else']];

function rowHtml(id, rank) {
  const c = card(id);
  const r = d.record(id);
  return `<li class="row" data-action="detail" data-card="${id}">
    <span class="rk">${rank}</span>
    <img src="${c.thumb}" alt="" loading="lazy" decoding="async" width="40" height="56">
    <div class="nm"><b>${esc(c.name)}</b><small>${esc(c.set)} · ${esc(c.number)}</small></div>
    ${tierPill(d.tier(id))}
    <div class="st"><b>${d.rating(id)}</b><small>${recordText(r)}</small></div>
  </li>`;
}

function boardRows(query) {
  const q = normalize(query || '').trim();
  let html = '';
  d.order.forEach((id, k) => {
    const rank = k + 1;
    if (q) {
      const c = card(id);
      if (!normalize(c.name).includes(q) && !normalize(`${c.set} ${c.number}`).includes(q)) return;
    } else {
      const sec = SECTIONS.find((s) => s[0] === rank);
      if (sec) html += `<li class="row-section">${sec[1]}</li>`;
    }
    html += rowHtml(id, rank);
  });
  return html || '<li class="empty">No Pokémon match that search.</li>';
}

function tierReviewBody() {
  return TIERS.map((t) => {
    const ids = d.order.filter((id) => d.tier(id) === t).sort((x, y) => card(x).name.localeCompare(card(y).name));
    return `<div class="tier-section" id="tier-sec-${t}"><div class="row-section tier-head tier-${t}">${tierPill(t)} ${TIER_INFO[t].label} · ${ids.length}</div>
      <div class="small-grid">${ids.map((id) => `<button class="result-card" data-action="retier" data-card="${id}"><img src="${card(id).thumb}" alt="" loading="lazy"><div class="cap">${esc(card(id).name)}</div></button>`).join('') || '<p class="empty">No cards here.</p>'}</div></div>`;
  }).join('');
}

// Moving a card from the tier review applies straight away (the dialog itself is
// the deliberate step) and offers an undo.
function moveTier(id, tier) {
  let ev = null;
  for (const e of save.events) if (e.t === 'tier' && e.c === id) ev = e;
  if (!ev || ev.v === tier) return;
  const prev = ev.v;
  const apply = (v) => {
    ev.v = v;
    ev.edited = Date.now();
    persist();
    recompute();
    if (!(d.question && d.question.kind === 'review')) ui.interstitial = null;
    render();
    refreshLayers();
  };
  apply(tier);
  toast(`Moved ${esc(card(id).name)}: ${prev} → <b>${tier}</b>`, { ms: 5000, action: { label: 'Undo', fn: () => apply(prev) } });
}

function noticeHtml(n) {
  return `<div class="edit-notice">${n.html}${n.undo ? '<button class="btn" data-action="edit-undo">↶ Undo</button>' : ''}</div>`;
}

function detailBody(id, data) {
  const c = card(id);
  const r = d.record(id);
  const tier = d.tier(id);
  const ms = d.matchesFor(id);
  const notice = data.notice;
  const list = ms.slice().reverse().map((e) => {
    const opp = e.a === id ? e.b : e.a;
    const oc = card(opp);
    const res = outcomeFor(e, id);
    const label = { won: 'Won', lost: 'Lost', t: 'Tie' }[res];
    const editing = data.editing === e.id;
    let html = `<li class="${editing ? 'editing' : ''}">
      <img src="${oc.thumb}" alt="" loading="lazy" data-action="detail" data-card="${opp}">
      <div class="mi"><b data-action="detail" data-card="${opp}">vs ${esc(oc.name)} <small>#${d.rank(opp)}</small></b><small>${stageOfEvent(e)}${e.edited ? ' · edited' : ''}</small></div>
      <span class="res ${res === 't' ? 'tie' : res}">${label}</span>
      ${editing ? '' : `<button class="edit-btn" data-action="edit-open" data-event="${e.id}" aria-label="Edit result vs ${esc(oc.name)}">✏️ Edit</button>`}
    </li>`;
    if (editing) {
      const choice = data.choice || res;
      const opt = (val, thumb, text) => `<button class="choice ${choice === val ? 'on' : ''}" data-action="edit-choose" data-choice="${val}">
          ${thumb ? `<img src="${thumb}" alt="">` : '<span class="tie-icon">🤝</span>'}
          <span>${text}</span>${res === val ? '<small>current</small>' : ''}
        </button>`;
      html += `<li class="editor">
        <div class="editor-q">Who should win this ${stageOfEvent(e)} matchup?</div>
        <div class="choices">
          ${opt('won', c.thumb, `${esc(c.name)} wins`)}
          ${opt('lost', oc.thumb, `${esc(oc.name)} wins`)}
          ${opt('t', null, 'Tie')}
        </div>
        <div class="editor-actions">
          <button class="btn" data-action="edit-cancel">Cancel</button>
          <button class="btn primary" data-action="edit-save" ${choice === res ? 'disabled' : ''}>Save change</button>
        </div>
      </li>`;
    }
    if (notice && notice.at === e.id) html += `<li class="notice-row">${noticeHtml(notice)}</li>`;
    return html;
  }).join('');
  const pending = data.tierPending;
  const tierConfirm = pending && pending !== tier ? `<div class="editor tier-editor">
      <div class="editor-q">Move ${esc(c.name)} from ${tier ? `${tierPill(tier)} ${TIER_INFO[tier].label}` : 'undrafted'} to ${tierPill(pending)} ${TIER_INFO[pending].label}?</div>
      <div class="editor-actions">
        <button class="btn" data-action="tier-cancel">Cancel</button>
        <button class="btn primary" data-action="tier-save">Save tier</button>
      </div>
    </div>` : '';
  return `<div class="detail-top">
      <img class="big-thumb" src="${c.thumb}" alt="${esc(c.name)}" data-action="zoom" data-src="${c.image}">
      <div class="detail-facts">
        <div class="fact-row">
          <div class="fact"><b>#${d.rank(id)}</b>rank</div>
          <div class="fact"><b>${d.rating(id)}</b>rating ±${Math.round(d.sigma(id) * 174)}</div>
          <div class="fact"><b>${recordText(r)}</b>W–L${r.t ? '–T' : ''}</div>
        </div>
        <div class="fact-row"><div class="fact">${esc(c.set)} · #${esc(c.number)}</div></div>
      </div>
    </div>
    <div class="section-label">Tier</div>
    <div class="seg">${TIERS.map((t) => `<button class="tier-${t} ${(pending || tier) === t ? 'on' : ''}" data-action="tier-choose" data-tier="${t}">${t}<small>${TIER_INFO[t].label}</small></button>`).join('')}</div>
    ${tierConfirm}
    ${notice && notice.at === 'tier' ? noticeHtml(notice) : ''}
    <div class="section-label">Matchups (${ms.length}) · tap ✏️ Edit to change a result</div>
    ${ms.length ? `<ul class="match-list">${list}</ul>` : '<p class="empty">No matchups yet.</p>'}`;
}

function consistencyHtml() {
  const { checked, agreed } = d.consistency;
  if (checked < 5) return '';
  const pct = Math.round((agreed / checked) * 100);
  const vibe = pct >= 90 ? 'Rock solid taste 💎' : pct >= 75 ? 'Very consistent ✨' : pct >= 60 ? 'Lots of close calls 🌗' : 'Tough choices all round 🌀';
  return `<div class="consistency"><b>${pct}%</b><span>consistency · ${vibe}<small>You gave the same answer on ${agreed} of the ${checked} matchups you saw more than once.</small></span></div>`;
}

function resultsBody() {
  const grid = (from, to, cls) => `<div class="${cls}">${d.order.slice(from, to).map((id, k) => {
    const c = card(id);
    return `<div class="result-card" data-action="detail" data-card="${id}"><span class="badge">${from + k + 1}</span><img src="${c.thumb}" alt="${esc(c.name)}" loading="lazy"><div class="cap">${esc(c.name)}</div></div>`;
  }).join('')}</div>`;
  const status = d.stage === 'done' ? '' : `<p class="menu-note">Still in progress (${stageLabel(d.stage, d.round)}) — this is the live ranking so far.</p>`;
  return `${status}${consistencyHtml()}
    <div class="results-title"><h3>🏆 Top 10</h3></div>${grid(0, 10, 'hero-grid')}
    <div class="results-title"><h3>⭐ 11 – 25</h3></div>${grid(10, 25, 'small-grid')}
    <div class="results-title"><h3>💖 26 – 50</h3></div>${grid(25, 50, 'small-grid')}
    <div class="results-title"><h3>💫 51 – 100</h3></div>${grid(50, 100, 'small-grid')}
    <div class="results-title"><h3>☁️ Full list</h3></div>
    <ul class="rows">${d.order.map((id, k) => rowHtml(id, k + 1)).join('')}</ul>
    <div style="padding:16px 0"><button class="btn primary" style="width:100%" data-action="csv">⬇ Export CSV</button></div>`;
}

// ---------------------------------------------------------------- zoom

function openZoom(src) {
  closeZoom();
  const el = document.createElement('div');
  el.className = 'zoom-layer';
  el.dataset.action = 'close-zoom';
  el.innerHTML = `<img src="${src}" alt="">`;
  document.body.appendChild(el);
  ui.zoom = el;
}

function closeZoom() {
  if (ui.zoom) { ui.zoom.remove(); ui.zoom = null; }
}

// ---------------------------------------------------------------- toasts

function toast(html, { ms = 2600, action } = {}) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = `<span>${html}</span>`;
  if (action) {
    const b = document.createElement('button');
    b.className = 'btn primary';
    b.textContent = action.label;
    b.onclick = () => { el.remove(); action.fn(); };
    el.appendChild(b);
  }
  const root = $('#toasts');
  root.appendChild(el);
  while (root.children.length > 3) root.firstChild.remove();
  setTimeout(() => el.remove(), ms);
}

// ---------------------------------------------------------------- events

document.addEventListener('click', (e) => {
  if (ui.hold && ui.hold.fired) {
    ui.hold = null;
    e.preventDefault();
    e.stopPropagation();
    return;
  }
  const t = e.target.closest('[data-action]');
  if (!t) return;
  const a = t.dataset.action;
  switch (a) {
    case 'pick': pickMatch(t.dataset.w); break;
    case 'tie': pickMatch('t'); break;
    case 'tier': pickTier(t.dataset.tier); break;
    case 'undo': undo(); break;
    case 'zoom': openZoom(t.dataset.src); break;
    case 'close-zoom': closeZoom(); break;
    case 'continue': ui.interstitial = null; render(); break;
    case 'board': openLayer('board'); break;
    case 'menu': openLayer('menu'); break;
    case 'results': closeAllLayers(); openLayer('results'); break;
    case 'close': closeTopLayer(); break;
    case 'detail': openLayer('detail', { id: t.dataset.card }); break;
    case 'edit-open': case 'edit-choose': case 'edit-cancel': case 'edit-save':
    case 'tier-choose': case 'tier-cancel': case 'tier-save': case 'edit-undo': {
      const layer = detailLayerOf(t);
      if (!layer) break;
      const ld = layer.data;
      if (a === 'edit-open') Object.assign(ld, { editing: Number(t.dataset.event), choice: null, notice: null, tierPending: null });
      else if (a === 'edit-choose') ld.choice = t.dataset.choice;
      else if (a === 'edit-cancel') Object.assign(ld, { editing: null, choice: null });
      else if (a === 'tier-choose') Object.assign(ld, { tierPending: t.dataset.tier === d.tier(ld.id) ? null : t.dataset.tier, notice: null, editing: null });
      else if (a === 'tier-cancel') ld.tierPending = null;
      if (a === 'edit-save') saveResultEdit(layer);
      else if (a === 'tier-save') saveTierEdit(layer);
      else if (a === 'edit-undo') undoEdit(layer);
      else fillLayer(layer, false);
      break;
    }
    case 'backup': backup(); break;
    case 'tiers': openLayer('tiers'); break;
    case 'jump-tier': {
      const sec = t.closest('.layer') && $(`#tier-sec-${t.dataset.tier}`, t.closest('.layer'));
      if (sec) sec.scrollIntoView({ behavior: reduceMotion.matches ? 'auto' : 'smooth', block: 'start' });
      break;
    }
    case 'retier': openLayer('retier', { id: t.dataset.card }); break;
    case 'retier-set': closeTopLayer(); moveTier(t.dataset.card, t.dataset.tier); break;
    case 'tiers-done':
      if (d.question && d.question.kind === 'review') {
        closeAllLayers();
        commit({ t: 'mark', m: 'tiers-reviewed' });
      }
      break;
    case 'install': closeAllLayers(); openLayer('install'); break;
    case 'tip-dismiss':
      try { localStorage.setItem(TIP_KEY, '1'); } catch { /* private mode */ }
      closeTopLayer();
      break;
    case 'csv': exportCsv(); break;
    case 'load': $('#file-input').click(); break;
    case 'rename': {
      if (!save) break;
      const name = prompt('Name this save', save.name);
      if (name && name.trim()) { save.name = name.trim().slice(0, 40); persist(); render(); refreshLayers(); }
      break;
    }
    case 'reset': {
      if (!confirm(`Start over? This erases "${save.name}" and all ${save.events.length} picks from this device.\n\nTip: Back up first if you might want it later.`)) break;
      localStorage.removeItem(STORE_KEY);
      save = null;
      d = null;
      ui.interstitial = null;
      closeAllLayers();
      render();
      break;
    }
  }
});

document.addEventListener('submit', (e) => {
  const f = e.target.closest('[data-form="start"]');
  if (!f) return;
  e.preventDefault();
  const name = new FormData(f).get('name').toString().trim() || 'My Ranking';
  save = newSave(name.slice(0, 40));
  persist();
  requestPersistence();
  recompute();
  render();
  maybeHomeTip();
});

document.addEventListener('input', (e) => {
  if (e.target.dataset.input !== 'search') return;
  const layer = ui.layers.find((l) => l.el.contains(e.target));
  if (layer) {
    $('.rows', layer.el).innerHTML = boardRows(e.target.value);
    $('.sheet-body', layer.el).scrollTop = 0;
  }
});

$('#file-input').addEventListener('change', (e) => {
  const f = e.target.files && e.target.files[0];
  if (f) loadBackupFile(f);
  e.target.value = '';
});

// Tap and hold any [data-hold] element to see the card full size.
document.addEventListener('pointerdown', (e) => {
  const el = e.target.closest('[data-hold]');
  if (!el || e.button > 0) return;
  const hold = { x: e.clientX, y: e.clientY, fired: false };
  hold.timer = setTimeout(() => {
    hold.fired = true;
    if (navigator.vibrate) navigator.vibrate(8);
    openZoom(el.dataset.hold);
  }, HOLD_MS);
  ui.hold = hold;
});
document.addEventListener('pointermove', (e) => {
  const h = ui.hold;
  if (h && !h.fired && Math.hypot(e.clientX - h.x, e.clientY - h.y) > 12) { clearTimeout(h.timer); ui.hold = null; }
});
for (const type of ['pointerup', 'pointercancel']) {
  document.addEventListener(type, () => {
    const h = ui.hold;
    if (!h) return;
    clearTimeout(h.timer);
    if (!h.fired) ui.hold = null;
    // The click that follows a long press is swallowed; clear the flag even if no click comes.
    else setTimeout(() => { if (ui.hold === h) ui.hold = null; }, 80);
  });
}
document.addEventListener('contextmenu', (e) => {
  if (e.target.closest('[data-hold], .pick, .zoom-layer')) e.preventDefault();
});

document.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.target.matches('input, textarea')) {
    if (e.key === 'Escape') { e.target.blur(); if (ui.layers.length) closeTopLayer(); }
    return;
  }
  if (ui.zoom) {
    if (['Escape', ' ', 'Enter'].includes(e.key)) { e.preventDefault(); closeZoom(); }
    return;
  }
  if (ui.layers.length) {
    if (e.key === 'Escape') closeTopLayer();
    return;
  }
  if (!save) return;
  const key = e.key.toLowerCase();
  if (key === 'l') { openLayer('board'); return; }
  if (key === 'z' || key === 'u' || e.key === 'Backspace') { e.preventDefault(); undo(); return; }
  if (ui.interstitial) {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); ui.interstitial = null; render(); }
    return;
  }
  const q = d.question;
  if (!q) return;
  if (q.kind === 'tier') {
    const k = ['1', '2', '3', '4'].indexOf(e.key);
    if (k >= 0) pickTier(TIERS[k]);
    else if (key === 's' || key === 'a' || key === 'b' || key === 'c') pickTier(key.toUpperCase());
    return;
  }
  if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); pickMatch('a'); }
  else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); pickMatch('b'); }
  else if (e.key === ' ' || key === 't' || e.key === '0') { e.preventDefault(); pickMatch('t'); }
});

let resizeRaf = 0;
window.addEventListener('resize', () => {
  cancelAnimationFrame(resizeRaf);
  resizeRaf = requestAnimationFrame(sizeArena);
});

// ---------------------------------------------------------------- sky

function buildSky() {
  const clouds = $('.clouds');
  const rnd = (a, b) => a + Math.random() * (b - a);
  for (let k = 0; k < 7; k++) {
    const c = document.createElement('div');
    c.className = 'cloud';
    const dur = rnd(90, 170);
    c.style.cssText = `top:${rnd(-4, 88)}%;--w:${rnd(140, 320)}px;--o:${rnd(0.35, 0.75)};--d:${dur}s;--delay:${-rnd(0, dur)}s;--x0:${rnd(-10, 90)}vw`;
    c.appendChild(document.createElement('span'));
    clouds.appendChild(c);
  }
  const sparkles = $('.sparkles');
  for (let k = 0; k < 26; k++) {
    const s = document.createElement('div');
    s.className = 'sparkle';
    s.style.cssText = `left:${rnd(2, 98)}%;top:${rnd(2, 98)}%;--s:${rnd(8, 18)}px;--d:${rnd(3, 7)}s;--delay:${-rnd(0, 7)}s`;
    sparkles.appendChild(s);
  }
}

// ---------------------------------------------------------------- boot

async function boot() {
  buildSky();
  try {
    const res = await fetch('cards.json');
    cards = await res.json();
  } catch {
    main.innerHTML = '<div class="center"><div class="panel"><h2>Couldn\'t load cards.json</h2><p>Open this site through a web server (see README), not by double-clicking index.html.</p></div></div>';
    return;
  }
  cards.forEach((c, i) => { byId.set(c.id, c); index.set(c.id, i); });
  save = loadStored();
  if (save) ui.lastRemindAt = save.events.length;
  recompute();
  render();
  if (save) {
    requestPersistence();
    maybeRemind();
    maybeHomeTip();
  }
}

boot();
