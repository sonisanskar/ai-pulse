'use strict';

/* AI Pulse: static single-page dashboard. Data comes from data/*.json written by the
   daily pipeline; personal state (read / saved / flashcards / streak) lives in localStorage. */

const DATA = 'data/';
const LIST_TABS = ['papers', 'news', 'models'];
const TYPE_LABEL = { paper: 'Paper', news: 'News', model: 'Model', dataset: 'Dataset', space: 'Space', repo: 'Repo' };
const TAB_LABEL = { papers: 'Papers', news: 'News', models: 'Models & Repos' };
const RANGES = [[1, 'Latest day'], [3, 'Last 3 days'], [7, 'Last 7 days'], [30, 'Last 30 days']];

/* ---------- storage (every access guarded: private mode / blocked storage) ---------- */
const store = {
  get(k, d) { try { const v = localStorage.getItem('aipulse.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('aipulse.' + k, JSON.stringify(v)); } catch (e) { /* ignore */ } },
};

const state = {
  index: { days: [] }, status: null, concepts: [], days: new Map(),
  tab: 'today', viewDate: null, query: '',
  prefs: Object.assign({ range: 7, sort: 'score', unread: false, newOnly: false }, store.get('prefs', {})),
  filter: { papers: {}, news: {}, models: {} },
  read: store.get('read', {}), saved: store.get('saved', {}), srs: store.get('srs', {}),
  learned: store.get('learned', {}), activity: store.get('activity', []),
  prevVisit: null, expanded: new Set(),
  learnView: 'lesson', learnSlug: null, review: null, savedFilter: 'all',
};

/* ---------- helpers ---------- */
const $ = (sel, el = document) => el.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const safeUrl = (u) => (/^https?:\/\//i.test(u || '') ? u : '#');
const todayStr = () => new Date().toISOString().slice(0, 10);
const addDays = (iso, n) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const fmtNum = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + 'k' : String(Math.round(n)));
const truncate = (s, n) => (s && s.length > n ? s.slice(0, n).replace(/\s+\S*$/, '') + '…' : s || '');

function ago(iso) {
  if (!iso) return '';
  const days = Math.round((Date.parse(todayStr()) - Date.parse(iso.slice(0, 10))) / 864e5);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return days + 'd ago';
  return iso.slice(0, 10);
}
function agoTime(iso) {
  const mins = Math.round((Date.now() - Date.parse(iso)) / 6e4);
  if (mins < 60) return mins + ' min ago';
  if (mins < 60 * 36) return Math.round(mins / 60) + 'h ago';
  return Math.round(mins / 1440) + 'd ago';
}
function prettyDate(iso) {
  return new Date(iso + 'T12:00:00Z').toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
}

async function getJSON(path) {
  const r = await fetch(DATA + path, { cache: 'no-cache' });
  if (!r.ok) throw new Error(path + ': HTTP ' + r.status);
  return r.json();
}

/* Markdown + LaTeX. Code and math are pulled out before marked runs so neither gets mangled. */
function renderMarkdown(md) {
  if (!md) return '';
  if (!window.marked || !window.DOMPurify) return '<p>' + esc(md).replace(/\n\n+/g, '</p><p>').replace(/\n/g, '<br>') + '</p>';
  const code = [], math = [];
  let src = md.replace(/```[\s\S]*?```|`[^`\n]+`/g, (m) => `@@CODE${code.push(m) - 1}@@`);
  const keep = (tex, display) => `@@MATH${math.push({ tex, display }) - 1}@@`;
  src = src
    .replace(/\$\$([\s\S]+?)\$\$/g, (_, t) => keep(t, true))
    .replace(/\\\[([\s\S]+?)\\\]/g, (_, t) => keep(t, true))
    .replace(/\\\(([\s\S]+?)\\\)/g, (_, t) => keep(t, false))
    .replace(/\$([^\s$](?:[^$\n]*?[^\s$])?)\$/g, (_, t) => keep(t, false));
  src = src.replace(/@@CODE(\d+)@@/g, (_, i) => code[i]);
  let html = DOMPurify.sanitize(marked.parse(src));
  html = html.replace(/@@MATH(\d+)@@/g, (_, i) => {
    const { tex, display } = math[i];
    if (!window.katex) return esc(display ? `$$${tex}$$` : `$${tex}$`);
    try { return katex.renderToString(tex, { displayMode: display, throwOnError: false }); } catch (e) { return esc(tex); }
  });
  return html;
}

/* ---------- data access ---------- */
async function loadDay(date) {
  if (!state.days.has(date)) {
    try { state.days.set(date, await getJSON(`days/${date}.json`)); } catch (e) { state.days.set(date, { date, items: [] }); }
  }
  return state.days.get(date);
}
async function loadRange(n) {
  await Promise.all(state.index.days.slice(0, n).map((d) => loadDay(d.date)));
}
function rangeItems(n = state.prefs.range) {
  const seen = new Set(), out = [];
  for (const d of state.index.days.slice(0, n)) {
    for (const it of (state.days.get(d.date) || { items: [] }).items) {
      if (!seen.has(it.id)) { seen.add(it.id); out.push(it); }
    }
  }
  return out;
}
const isNew = (it) => Boolean(state.prevVisit && it.first_seen && it.first_seen > state.prevVisit);
const findItem = (id) => {
  for (const d of state.days.values()) { const it = d.items.find((x) => x.id === id); if (it) return it; }
  return state.saved[id] || null;
};
const matchesQuery = (it, q) => {
  if (!q) return true;
  const s = it.summary || {};
  return [it.title, it.abstract, it.source, s.tldr, s.key_idea, (s.tags || []).join(' '), (it.tags || []).join(' '), (it.authors || []).join(' ')]
    .join(' ').toLowerCase().includes(q);
};

/* ---------- flashcards: SM-2 spaced repetition ---------- */
function allCards() {
  return state.concepts.flatMap((c) => (c.flashcards || []).map((f, i) => ({ id: `${c.slug}#${i}`, concept: c, q: f.q, a: f.a })));
}
function dueCards() {
  const t = todayStr();
  return allCards().filter((c) => { const s = state.srs[c.id]; return !s || s.due <= t; });
}
function gradeCard(id, q) { // q: 0 again, 3 hard, 4 good, 5 easy
  const s = Object.assign({ ef: 2.5, interval: 0, reps: 0 }, state.srs[id]);
  if (q < 3) { s.reps = 0; s.interval = 1; }
  else {
    s.reps += 1;
    s.interval = s.reps === 1 ? 1 : s.reps === 2 ? 3 : Math.round(s.interval * s.ef);
    if (q === 5) s.interval = Math.round(s.interval * 1.3);
  }
  s.ef = Math.max(1.3, s.ef + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02)));
  s.due = addDays(todayStr(), q < 3 ? 0 : s.interval);
  state.srs[id] = s;
  store.set('srs', state.srs);
  logActivity();
}
function logActivity() {
  const t = todayStr();
  if (!state.activity.includes(t)) { state.activity.push(t); state.activity = state.activity.slice(-400); store.set('activity', state.activity); }
}
function streak() {
  const days = new Set(state.activity);
  let d = todayStr(), n = 0;
  if (!days.has(d)) d = addDays(d, -1);
  while (days.has(d)) { n += 1; d = addDays(d, -1); }
  return n;
}

/* ---------- card rendering ---------- */
function signalsHTML(s = {}) {
  const parts = [];
  if (s.upvotes) parts.push(`<span title="HF upvotes">▲ ${fmtNum(s.upvotes)}</span>`);
  if (s.points) parts.push(`<span title="Hacker News points">▲ ${fmtNum(s.points)} pts</span>`);
  if (s.stars) parts.push(`<span title="GitHub stars">★ ${fmtNum(s.stars)}</span>`);
  if (s.likes) parts.push(`<span title="Likes">♥ ${fmtNum(s.likes)}</span>`);
  if (s.downloads) parts.push(`<span title="Downloads">↓ ${fmtNum(s.downloads)}</span>`);
  if (s.trending) parts.push(`<span title="HF trending score">↗ ${fmtNum(s.trending)}</span>`);
  return parts.join('');
}
function linksHTML(it) {
  const l = it.links || {}, out = [];
  if (l.pdf) out.push(['PDF', l.pdf]);
  if (l.arxiv) out.push(['arXiv', l.arxiv]);
  if (l.code) out.push(['Code', l.code]);
  if (l.hn) out.push(['HN thread', l.hn]);
  else if (l.discussion && l.discussion !== it.url) out.push(['Discussion', l.discussion]);
  return out.map(([t, u]) => `<a href="${esc(safeUrl(u))}" target="_blank" rel="noopener">${t} ↗</a>`).join('');
}
function cardHTML(it) {
  const s = it.summary, read = state.read[it.id], saved = state.saved[it.id], open = state.expanded.has(it.id);
  const tags = (s && s.tags && s.tags.length ? s.tags : it.tags || []).slice(0, 5);
  const body = s ? s.tldr : truncate(it.abstract, 280);
  return `<article class="card ${read ? 'read' : ''}" data-id="${esc(it.id)}">
    <div class="card-head">
      ${isNew(it) ? '<span class="chip new">NEW</span>' : ''}
      <span class="chip ${it.type}">${TYPE_LABEL[it.type] || it.type}</span>
      <span>${esc(it.source)}</span><span>·</span><span title="${esc(it.date)}">${ago(it.date)}</span>
      ${s ? `<span class="diff-${esc(s.difficulty)}" title="Difficulty">● ${esc(s.difficulty)}</span>` : ''}
      <span class="signals">${signalsHTML(it.signals)}</span>
    </div>
    <h3><a href="${esc(safeUrl(it.url))}" target="_blank" rel="noopener" data-action="open">${esc(it.title)}</a></h3>
    ${body ? `<p class="tldr">${esc(body)}</p>` : ''}
    ${tags.length ? `<div class="tags">${tags.map((t) => `<button class="chip" data-action="tag" data-tag="${esc(t)}">#${esc(t)}</button>`).join('')}</div>` : ''}
    ${open ? detailsHTML(it) : ''}
    <div class="card-actions">
      <button data-action="details">${open ? 'Hide details' : 'Details'}</button>
      <button data-action="save" class="${saved ? 'on' : ''}">${saved ? '★ Saved' : '☆ Save'}</button>
      <button data-action="read" class="${read ? 'on' : ''}">${read ? '✓ Read' : 'Mark read'}</button>
      <span class="sep"></span>${linksHTML(it)}
    </div>
  </article>`;
}
function detailsHTML(it) {
  const s = it.summary;
  return `<div class="details">
    ${s && s.key_idea ? `<div><b>Key idea.</b> <p>${esc(s.key_idea)}</p></div>` : ''}
    ${s && s.why_it_matters ? `<div><b>Why it matters.</b> <p>${esc(s.why_it_matters)}</p></div>` : ''}
    ${it.abstract ? `<div><b>${it.type === 'paper' ? 'Abstract' : 'Description'}.</b> <p>${esc(it.abstract)}</p></div>` : ''}
    ${it.authors && it.authors.length ? `<div class="faint">${esc(it.authors.join(', '))}</div>` : ''}
  </div>`;
}
const cardsHTML = (items) => (items.length ? `<div class="cards">${items.map(cardHTML).join('')}</div>` : '<div class="empty">Nothing here with these filters.</div>');

/* ---------- views ---------- */
function renderToday() {
  const day = state.days.get(state.viewDate) || { items: [] };
  const items = day.items, digest = day.digest;
  const concept = state.concepts.find((c) => c.slug === day.concept_slug) || state.concepts[0];
  const byTab = (t) => items.filter((i) => i.tab === t);
  const newCount = rangeItems().filter(isNew).length;
  const due = dueCards().length;

  let top = [];
  if (digest && digest.top && digest.top.length) {
    top = digest.top.map((t) => ({ item: items.find((i) => i.id === t.id), why: t.why })).filter((t) => t.item);
  }
  if (!top.length) { // no LLM digest: best two per section
    top = LIST_TABS.flatMap((t) => byTab(t).slice(0, 2)).map((item) => ({ item, why: item.summary ? item.summary.why_it_matters : '' }));
  }

  const dayOptions = state.index.days.map((d) => `<option value="${d.date}" ${d.date === state.viewDate ? 'selected' : ''}>${d.date}${d.headline ? ' · ' + esc(truncate(d.headline, 50)) : ''}</option>`).join('');

  $('#app').innerHTML = `
    <section class="hero">
      <div>
        <div class="faint">${prettyDate(state.viewDate)}${day.generated_at ? ' · updated ' + agoTime(day.generated_at) : ''}</div>
        <h1>${esc(digest && digest.headline ? digest.headline : `${items.length} new things in AI today`)}</h1>
        <div class="meta">${(digest && digest.themes || []).map((t) => `<span class="chip active">${esc(t)}</span>`).join('')}</div>
      </div>
      <label class="faint" style="font-size:13px">Archive&nbsp; <select data-action="view-date">${dayOptions}</select></label>
    </section>
    ${newCount ? `<div class="new-banner"><span>✦ ${newCount} new item${newCount > 1 ? 's' : ''} since your last visit</span><button class="btn" data-action="show-new">Show only new</button></div>` : ''}
    <div class="today-grid">
      <div class="stack">
        <section class="panel">
          <h2 class="section-title">${digest ? "Today's top 5" : 'Top picks'}</h2>
          ${top.map((t, n) => `<div class="top-item"><div class="rank">${n + 1}</div><div>
              <div class="faint" style="font-size:12.5px"><span class="chip ${t.item.type}">${TYPE_LABEL[t.item.type]}</span> ${esc(t.item.source)}</div>
              <a class="title" href="${esc(safeUrl(t.item.url))}" target="_blank" rel="noopener">${esc(t.item.title)}</a>
              ${t.why ? `<div class="why">${esc(t.why)}</div>` : ''}</div></div>`).join('') || '<div class="empty">No items for this day.</div>'}
        </section>
        ${digest && digest.overview ? `<section class="panel lesson"><h2 class="section-title">The big picture</h2>${renderMarkdown(digest.overview)}</section>` : ''}
        ${LIST_TABS.map((t) => byTab(t).length ? `<section>
            <h2 class="section-title" style="display:flex;justify-content:space-between">${TAB_LABEL[t]} <a href="#${t}" style="text-transform:none;letter-spacing:0">See all ${byTab(t).length} →</a></h2>
            ${cardsHTML(byTab(t).slice(0, 3))}</section>` : '').join('')}
      </div>
      <aside class="stack">
        <section class="panel concept-card">
          <h2 class="section-title">Concept of the day</h2>
          ${concept ? `<span class="chip active">${esc(concept.category)}</span>
            <h3>${esc(concept.name)}</h3>
            <p class="muted" style="margin:0 0 12px">${esc(concept.one_liner)}</p>
            <a class="btn primary" href="#learn/${esc(concept.slug)}">Open lesson →</a>`
          : '<p class="muted">Lessons appear here once an LLM provider is configured for the daily build (see README).</p>'}
        </section>
        <section class="panel">
          <h2 class="section-title">This day</h2>
          <div class="stat-row">${LIST_TABS.map((t) => `<a class="stat" href="#${t}"><b>${byTab(t).length}</b><span>${TAB_LABEL[t]}</span></a>`).join('')}</div>
        </section>
        <section class="panel">
          <h2 class="section-title">Your learning</h2>
          <div class="stat-row">
            <div class="stat" data-action="go-review"><b>${due}</b><span>cards due</span></div>
            <div class="stat"><b>${streak()}🔥</b><span>day streak</span></div>
            <div class="stat"><b>${Object.keys(state.learned).length}</b><span>learned</span></div>
          </div>
          ${due ? '<button class="btn" style="margin-top:12px;width:100%" data-action="go-review">Review flashcards</button>' : ''}
        </section>
      </aside>
    </div>`;
}

function renderList(tab) {
  const f = state.filter[tab], p = state.prefs, q = state.query.trim().toLowerCase();
  let items = rangeItems().filter((i) => i.tab === tab);
  const sources = [...new Set(items.map((i) => i.source))].sort();
  const kinds = tab === 'models' ? [...new Set(items.map((i) => i.type))] : [];
  items = items.filter((i) =>
    (!f.source || i.source === f.source) &&
    (!f.kind || i.type === f.kind) &&
    (!f.tag || [...(i.tags || []), ...((i.summary || {}).tags || [])].includes(f.tag)) &&
    (!p.unread || !state.read[i.id]) &&
    (!p.newOnly || isNew(i)) &&
    matchesQuery(i, q));
  items.sort(p.sort === 'newest'
    ? (a, b) => (b.first_seen || '').localeCompare(a.first_seen || '') || b.score - a.score
    : (a, b) => b.score - a.score);

  $('#app').innerHTML = `
    <div class="toolbar">
      <select data-action="range">${RANGES.map(([n, l]) => `<option value="${n}" ${n === p.range ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <select data-action="source"><option value="">All sources</option>${sources.map((s) => `<option ${s === f.source ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select>
      <select data-action="sort"><option value="score" ${p.sort === 'score' ? 'selected' : ''}>Top ranked</option><option value="newest" ${p.sort === 'newest' ? 'selected' : ''}>Newest</option></select>
      ${kinds.length > 1 ? `<span>${['', ...kinds].map((k) => `<button class="chip ${f.kind === k || (!k && !f.kind) ? 'active' : ''}" data-action="kind" data-kind="${k}">${k ? TYPE_LABEL[k] + 's' : 'All'}</button>`).join(' ')}</span>` : ''}
      <span class="spacer"></span>
      <label><input type="checkbox" data-action="unread" ${p.unread ? 'checked' : ''}> Unread</label>
      <label><input type="checkbox" data-action="new-only" ${p.newOnly ? 'checked' : ''}> New only</label>
    </div>
    <div class="list-meta">${items.length} item${items.length === 1 ? '' : 's'}${q ? ` matching “${esc(q)}”` : ''}
      ${f.tag ? ` · tag <button class="chip active" data-action="clear-tag">#${esc(f.tag)} ✕</button>` : ''}</div>
    ${cardsHTML(items)}`;
}

function renderSearch() {
  const q = state.query.trim().toLowerCase();
  const items = rangeItems(30).filter((i) => matchesQuery(i, q)).sort((a, b) => b.score - a.score);
  const concepts = state.concepts.filter((c) => (c.name + ' ' + c.one_liner + ' ' + c.body).toLowerCase().includes(q));
  $('#app').innerHTML = `
    <div class="list-meta">${items.length} items and ${concepts.length} lessons matching “${esc(q)}” (last 30 days loaded)</div>
    ${concepts.length ? `<div class="toolbar">${concepts.map((c) => `<a class="chip active" href="#learn/${esc(c.slug)}">📘 ${esc(c.name)}</a>`).join('')}</div>` : ''}
    ${cardsHTML(items.slice(0, 100))}`;
}

function renderLearn() {
  const due = dueCards();
  const seg = `<div class="segmented">
      <button class="${state.learnView === 'lesson' ? 'active' : ''}" data-action="learn-view" data-view="lesson">Lessons</button>
      <button class="${state.learnView === 'review' ? 'active' : ''}" data-action="learn-view" data-view="review">Review (${due.length} due)</button>
    </div>`;
  if (!state.concepts.length) {
    $('#app').innerHTML = seg + '<div class="panel empty">No lessons yet. A new Concept of the Day is generated in each daily build once a free LLM provider key is set (see README).</div>';
    return;
  }
  if (state.learnView === 'review') { $('#app').innerHTML = seg + reviewHTML(); return; }

  const c = state.concepts.find((x) => x.slug === state.learnSlug) || state.concepts[0];
  if (c.date && !state.days.has(c.date) && state.index.days.some((d) => d.date === c.date)) {
    loadDay(c.date).then(() => state.tab === 'learn' && renderLearn());
  }
  const related = (c.related_item_ids || []).map(findItem).filter(Boolean);
  const prereq = (c.prerequisites || []).map((p) => {
    const hit = state.concepts.find((x) => x.name.toLowerCase().includes(p.toLowerCase()) || p.toLowerCase().includes(x.name.toLowerCase()));
    return hit ? `<a class="chip active" href="#learn/${esc(hit.slug)}">${esc(p)}</a>` : `<span class="chip">${esc(p)}</span>`;
  }).join(' ');
  const learned = state.learned[c.slug];

  $('#app').innerHTML = seg + `
    <div class="learn-grid">
      <aside class="panel" style="padding:10px">
        <div style="padding:4px 10px 10px" class="faint">${state.concepts.length} lesson${state.concepts.length === 1 ? '' : 's'} · ${Object.keys(state.learned).length} learned · ${streak()}🔥 streak</div>
        <div class="concept-list">${state.concepts.map((x) => `
          <button class="${x.slug === c.slug ? 'active' : ''}" data-action="concept" data-slug="${esc(x.slug)}">
            <span class="n">${state.learned[x.slug] ? '✓ ' : ''}${esc(x.name)}</span>
            <span class="d">${esc(x.date)} · ${esc(x.category)}</span></button>`).join('')}
        </div>
      </aside>
      <article class="panel lesson">
        <div class="faint" style="font-size:13px">${esc(prettyDate(c.date))} · <span class="chip active">${esc(c.category)}</span></div>
        <h1>${esc(c.name)}</h1>
        <p class="one-liner">${esc(c.one_liner)}</p>
        ${prereq ? `<div style="margin-bottom:8px"><span class="faint" style="font-size:13px">Prerequisites:</span> ${prereq}</div>` : ''}
        ${renderMarkdown(c.body)}
        ${related.length ? `<h2>Papers from that day</h2>${cardsHTML(related)}` : ''}
        ${(c.flashcards || []).length ? `<h2>Flashcards</h2><p class="muted">${c.flashcards.length} cards from this lesson are in your review queue.</p>` : ''}
        <div style="display:flex;gap:8px;margin-top:20px;flex-wrap:wrap">
          <button class="btn ${learned ? '' : 'primary'}" data-action="learned" data-slug="${esc(c.slug)}">${learned ? '✓ Learned on ' + learned : 'Mark as learned'}</button>
          ${due.length ? `<button class="btn" data-action="learn-view" data-view="review">Review ${due.length} cards</button>` : ''}
        </div>
      </article>
    </div>`;
  if (window.innerWidth < 860) $('.lesson').scrollIntoView({ block: 'start' });
}

function reviewHTML() {
  if (!state.review) state.review = { queue: dueCards().map((c) => c.id), revealed: false, done: 0 };
  const r = state.review;
  const cards = Object.fromEntries(allCards().map((c) => [c.id, c]));
  r.queue = r.queue.filter((id) => cards[id]);
  if (!r.queue.length) {
    return `<div class="panel empty">🎉 All caught up${r.done ? `: ${r.done} reviews done` : ''}. New cards arrive with each day's lesson.<br><br>
      <span class="faint">${streak()}🔥 day streak</span></div>`;
  }
  const card = cards[r.queue[0]];
  return `<div style="max-width:640px;margin:0 auto">
    <div class="faint" style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:8px">
      <span>From: <a href="#learn/${esc(card.concept.slug)}">${esc(card.concept.name)}</a></span><span>${r.queue.length} left · ${r.done} done</span></div>
    <div class="flashcard">
      <div class="q">${esc(card.q)}</div>
      ${r.revealed ? `<div class="a">${esc(card.a)}</div>` : ''}
    </div>
    <div class="grade-row">${r.revealed
      ? `<button class="btn again" data-action="grade" data-q="0">Again</button>
         <button class="btn hard" data-action="grade" data-q="3">Hard</button>
         <button class="btn good" data-action="grade" data-q="4">Good</button>
         <button class="btn" data-action="grade" data-q="5">Easy</button>`
      : '<button class="btn primary" data-action="reveal">Show answer <span class="faint" style="color:inherit;opacity:.7">(space)</span></button>'}
    </div></div>`;
}

function renderSaved() {
  const all = Object.values(state.saved).sort((a, b) => (b.saved_at || '').localeCompare(a.saved_at || ''));
  const readN = all.filter((i) => state.read[i.id]).length;
  const q = state.query.trim().toLowerCase();
  const items = all.filter((i) =>
    (state.savedFilter === 'all' || (state.savedFilter === 'read') === Boolean(state.read[i.id])) && matchesQuery(i, q));
  $('#app').innerHTML = `
    <div class="toolbar">
      <div class="segmented" style="margin:0">${['all', 'unread', 'read'].map((k) => `<button class="${state.savedFilter === k ? 'active' : ''}" data-action="saved-filter" data-f="${k}">${k[0].toUpperCase() + k.slice(1)}</button>`).join('')}</div>
      <span class="spacer"></span>
      <button class="btn" data-action="export">Export progress</button>
      <label class="btn" style="cursor:pointer">Import<input type="file" accept="application/json" data-action="import" hidden></label>
    </div>
    ${all.length ? `<div style="margin-bottom:14px"><div class="list-meta">${readN} of ${all.length} saved items read</div>
      <div class="progress"><div style="width:${(100 * readN / all.length).toFixed(1)}%"></div></div></div>` : ''}
    ${all.length ? cardsHTML(items) : '<div class="empty">Nothing saved yet. Hit ☆ Save on anything you want to read later.</div>'}
    <p class="faint" style="font-size:12.5px;margin-top:20px">Saved items, read marks and flashcard progress are stored in this browser only. Use Export / Import to move them between devices.</p>`;
}

function renderFooter() {
  const s = state.status;
  if (!s) { $('#footer').innerHTML = ''; return; }
  const src = Object.entries(s.sources || {});
  const bad = src.filter(([, v]) => !v.ok).length;
  const partial = src.filter(([, v]) => v.ok && v.partial_errors).length;
  const llm = s.llm || {};
  const llmLabel = llm.skipped ? 'LLM skipped' : llm.ok ? 'LLM ok (' + Object.keys(llm.calls || {}).join(', ') + ')' : 'LLM unavailable';
  $('#footer').innerHTML = `<details>
    <summary>
      <span><span class="dot ${bad ? 'bad' : partial ? 'warn' : ''}"></span>${src.length - bad}/${src.length} sources healthy</span>
      <span><span class="dot ${llm.ok ? '' : 'warn'}"></span>${esc(llmLabel)}</span>
      <span>Data updated ${agoTime(s.generated_at)}</span>
      <span style="margin-left:auto">Details ▾</span>
    </summary>
    <table class="status-table">
      ${src.map(([k, v]) => `<tr><td><span class="dot ${v.ok ? (v.partial_errors ? 'warn' : '') : 'bad'}"></span>${esc(k)}</td><td>${v.count} items</td><td>${v.ms} ms</td>
        <td>${esc(v.error || (v.partial_errors ? Object.entries(v.partial_errors).map(([a, b]) => a + ': ' + b).join(' · ') : ''))}</td></tr>`).join('')}
      <tr><td><span class="dot ${llm.ok ? '' : 'warn'}"></span>llm</td><td colspan="2">${Object.values(llm.calls || {}).reduce((a, b) => a + b, 0)} calls</td>
        <td>${esc(llm.error || (llm.errors || []).slice(-3).join(' · '))}</td></tr>
    </table></details>`;
}

function renderTabCounts() {
  const items = rangeItems(1);
  for (const a of document.querySelectorAll('#tabs a')) {
    const t = a.dataset.tab, el = $('.count', a);
    a.classList.toggle('active', t === state.tab);
    if (!el) continue;
    let text = '', isNewCount = false;
    if (LIST_TABS.includes(t)) {
      const n = rangeItems().filter((i) => i.tab === t && isNew(i)).length;
      isNewCount = n > 0;
      text = n ? '+' + n : String(items.filter((i) => i.tab === t).length || '');
    } else if (t === 'learn') { const d = dueCards().length; text = d ? String(d) : ''; isNewCount = d > 0; }
    else if (t === 'saved') { const n = Object.keys(state.saved).filter((id) => !state.read[id]).length; text = n ? String(n) : ''; }
    el.textContent = text;
    el.classList.toggle('new', isNewCount);
  }
}

function render() {
  renderTabCounts();
  const q = state.query.trim();
  if (q && !LIST_TABS.includes(state.tab) && state.tab !== 'saved') { loadRange(30).then(renderSearch); return; }
  if (state.tab === 'today') renderToday();
  else if (LIST_TABS.includes(state.tab)) renderList(state.tab);
  else if (state.tab === 'learn') renderLearn();
  else if (state.tab === 'saved') renderSaved();
}

/* ---------- routing & events ---------- */
async function route() {
  const [tab, arg] = (location.hash.slice(1) || 'today').split('/');
  state.tab = ['today', 'papers', 'news', 'models', 'learn', 'saved'].includes(tab) ? tab : 'today';
  if (state.tab === 'learn') {
    if (arg) { state.learnSlug = decodeURIComponent(arg); state.learnView = 'lesson'; }
    if (state.learnView === 'review') state.review = null;
  }
  if (LIST_TABS.includes(state.tab)) await loadRange(state.prefs.range);
  render();
  window.scrollTo({ top: 0 });
}

function savePrefs() { store.set('prefs', state.prefs); }

function toggleRead(id, force) {
  const on = force ?? !state.read[id];
  if (on) state.read[id] = new Date().toISOString(); else delete state.read[id];
  store.set('read', state.read);
}

function rerenderCard(id) {
  const el = document.querySelector(`.card[data-id="${CSS.escape(id)}"]`);
  const it = findItem(id);
  if (el && it) el.outerHTML = cardHTML(it);
  renderTabCounts();
}

document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-action]');
  if (!t || t.tagName === 'SELECT' || t.type === 'checkbox' || t.type === 'file') return;
  const card = t.closest('.card');
  const id = card && card.dataset.id;
  const a = t.dataset.action;

  if (a === 'open') { toggleRead(id, true); setTimeout(() => rerenderCard(id), 50); return; }
  if (a === 'details') { state.expanded.has(id) ? state.expanded.delete(id) : state.expanded.add(id); rerenderCard(id); }
  else if (a === 'read') { toggleRead(id); rerenderCard(id); }
  else if (a === 'save') {
    if (state.saved[id]) delete state.saved[id];
    else { const it = findItem(id); if (it) state.saved[id] = Object.assign({}, it, { saved_at: new Date().toISOString() }); }
    store.set('saved', state.saved);
    state.tab === 'saved' ? render() : rerenderCard(id);
  }
  else if (a === 'tag') {
    const tab = LIST_TABS.includes(state.tab) ? state.tab : (findItem(id) || {}).tab || 'papers';
    state.filter[tab].tag = t.dataset.tag;
    if (state.tab !== tab) location.hash = tab; else render();
  }
  else if (a === 'clear-tag') { state.filter[state.tab].tag = ''; render(); }
  else if (a === 'kind') { state.filter.models.kind = t.dataset.kind; render(); }
  else if (a === 'show-new') { state.prefs.newOnly = true; savePrefs(); const n = rangeItems().filter(isNew); location.hash = (n.find((i) => i.tab === 'papers') || n[0] || { tab: 'papers' }).tab; }
  else if (a === 'go-review') { state.learnView = 'review'; state.review = null; location.hash === '#learn' ? render() : (location.hash = 'learn'); }
  else if (a === 'learn-view') { state.learnView = t.dataset.view; state.review = null; render(); }
  else if (a === 'concept') { location.hash = 'learn/' + encodeURIComponent(t.dataset.slug); }
  else if (a === 'learned') {
    const s = t.dataset.slug;
    if (state.learned[s]) delete state.learned[s]; else { state.learned[s] = todayStr(); logActivity(); }
    store.set('learned', state.learned); render();
  }
  else if (a === 'reveal') { state.review.revealed = true; render(); }
  else if (a === 'grade') { grade(Number(t.dataset.q)); }
  else if (a === 'saved-filter') { state.savedFilter = t.dataset.f; render(); }
  else if (a === 'export') { exportProgress(); }
});

function grade(q) {
  const r = state.review, id = r.queue.shift();
  gradeCard(id, q);
  if (q === 0) r.queue.push(id); // see it again this session
  r.done += 1; r.revealed = false;
  render();
}

document.addEventListener('change', async (e) => {
  const t = e.target, a = t.dataset.action;
  if (a === 'range') { state.prefs.range = Number(t.value); savePrefs(); await loadRange(state.prefs.range); render(); }
  else if (a === 'source') { state.filter[state.tab].source = t.value; render(); }
  else if (a === 'sort') { state.prefs.sort = t.value; savePrefs(); render(); }
  else if (a === 'unread') { state.prefs.unread = t.checked; savePrefs(); render(); }
  else if (a === 'new-only') { state.prefs.newOnly = t.checked; savePrefs(); render(); }
  else if (a === 'view-date') { state.viewDate = t.value; await loadDay(t.value); render(); }
  else if (a === 'import' && t.files[0]) { importProgress(t.files[0]); }
});

let searchTimer;
$('#search').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { state.query = e.target.value; render(); }, 150);
});

document.addEventListener('keydown', (e) => {
  const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName);
  if (e.key === '/' && !typing) { e.preventDefault(); $('#search').focus(); return; }
  if (e.key === 'Escape' && document.activeElement === $('#search')) { $('#search').value = ''; state.query = ''; $('#search').blur(); render(); return; }
  if (typing || state.tab !== 'learn' || state.learnView !== 'review' || !state.review || !state.review.queue.length) return;
  if (e.key === ' ' && !state.review.revealed) { e.preventDefault(); state.review.revealed = true; render(); }
  else if (state.review.revealed && ['1', '2', '3', '4'].includes(e.key)) grade([0, 3, 4, 5][Number(e.key) - 1]);
});

$('#theme-toggle').addEventListener('click', () => {
  const root = document.documentElement;
  const dark = root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  root.dataset.theme = dark ? 'light' : 'dark';
  try { localStorage.setItem('aipulse.theme', root.dataset.theme); } catch (err) { /* ignore */ }
});

function exportProgress() {
  const keys = ['read', 'saved', 'srs', 'learned', 'activity', 'prefs'];
  const blob = new Blob([JSON.stringify(Object.fromEntries(keys.map((k) => [k, store.get(k, null)])), null, 1)], { type: 'application/json' });
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `ai-pulse-progress-${todayStr()}.json` });
  a.click();
  URL.revokeObjectURL(a.href);
}
function importProgress(file) {
  file.text().then((txt) => {
    const data = JSON.parse(txt);
    for (const k of ['read', 'saved', 'srs', 'learned']) if (data[k]) { state[k] = Object.assign({}, state[k], data[k]); store.set(k, state[k]); }
    if (Array.isArray(data.activity)) { state.activity = [...new Set([...state.activity, ...data.activity])].sort(); store.set('activity', state.activity); }
    render();
  }).catch(() => alert('That file is not a valid AI Pulse export.'));
}

/* ---------- boot ---------- */
async function init() {
  // "New since last visit": keep the previous visit fixed for the whole browser session
  try {
    state.prevVisit = sessionStorage.getItem('aipulse.prevVisit');
    if (state.prevVisit === null) {
      state.prevVisit = store.get('lastVisit', '');
      sessionStorage.setItem('aipulse.prevVisit', state.prevVisit);
    }
  } catch (e) { state.prevVisit = store.get('lastVisit', ''); }
  store.set('lastVisit', new Date().toISOString());

  try {
    const [index, status, concepts] = await Promise.all([
      getJSON('index.json'),
      getJSON('status.json').catch(() => null),
      getJSON('concepts.json').catch(() => []),
    ]);
    Object.assign(state, { index, status, concepts });
  } catch (e) {
    $('#app').innerHTML = `<div class="empty">No data yet. Run <code>python -m pipeline.build</code> to generate it.<br><span class="faint">${esc(e.message)}</span></div>`;
    return;
  }
  if (!state.index.days.length) { $('#app').innerHTML = '<div class="empty">No days built yet.</div>'; return; }
  state.viewDate = state.index.days[0].date;
  await loadRange(Math.max(state.prefs.range, 1));
  renderFooter();
  window.addEventListener('hashchange', route);
  await route();
}

// marked / DOMPurify / KaTeX load with `defer` before this script runs; boot either way.
init();
