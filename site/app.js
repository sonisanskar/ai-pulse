'use strict';

/* AI Pulse: static single-page dashboard. Data comes from data/*.json written by the
   daily pipeline; personal state (read / saved / flashcards / streak) lives in localStorage. */

const DATA = 'data/';
const LIST_TABS = ['papers', 'news', 'models'];
const TYPE_LABEL = { paper: 'Paper', news: 'News', model: 'Model', dataset: 'Dataset', space: 'Space', repo: 'Repo' };
const TAB_LABEL = { papers: 'Papers', news: 'News', models: 'Models & Repos' };
const TABS = ['today', 'explore', 'learn', 'saved'];
const GROUPS = [['release', 'Lab releases'], ['usable', 'Use this'], ['demo', 'Built by people'], ['paper', 'Papers'], ['wildcard', 'Also notable']];
const BRIEF_SIZE = 7;
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
  filter: { type: '', source: '', kind: '', tag: '' },
  read: store.get('read', {}), muted: store.get('muted', {}), saved: store.get('saved', {}), srs: store.get('srs', {}),
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

/* "Less like this": mute an item's main topic tag (or its source when it has no tags) */
const itemTags = (it) => [...((it.summary || {}).tags || []), ...(it.tags || [])];
// HF Hub library/format tags say nothing about the topic, so muting one would hide half the feed
const GENERIC_TAGS = new Set(['transformers', 'safetensors', 'pytorch', 'gguf', 'diffusers', 'text-generation', 'image-text-to-text', 'conversational', 'gradio', 'python']);
const muteKey = (it) => { const t = itemTags(it).find((x) => !GENERIC_TAGS.has(x.toLowerCase())); return t ? 'tag:' + t.toLowerCase() : 'src:' + it.source; };
const isMuted = (it) => Boolean(state.muted['src:' + it.source] || itemTags(it).some((t) => state.muted['tag:' + t.toLowerCase()]));
const muteLabel = (k) => (k.startsWith('tag:') ? '#' + k.slice(4) : k.slice(4));

/* Today's picks: the pipeline's brief, or (older days / no brief) the best items by score */
function groupOf(it) {
  if (['rss_lab', 'anthropic'].includes(it.source_key)) return 'release';
  if (it.type === 'space' || /^show hn\b/i.test(it.title)) return 'demo';
  if (['repo', 'model'].includes(it.type)) return 'usable';
  return it.type === 'paper' ? 'paper' : 'wildcard';
}
function briefFor(day) {
  const byId = new Map(day.items.map((i) => [i.id, i]));
  let picks = (day.brief || []).map((b) => ({ item: byId.get(b.id), group: b.group })).filter((p) => p.item);
  if (!picks.length) picks = [...day.items].sort((a, b) => b.score - a.score).slice(0, BRIEF_SIZE).map((item) => ({ item, group: groupOf(item) }));
  // Muted picks give their slot to the best unmuted item not already shown, preferring the same group
  const used = new Set(picks.map((p) => p.item.id));
  const spare = [...day.items].sort((a, b) => b.score - a.score).filter((i) => !used.has(i.id) && !isMuted(i));
  return picks.map((p) => {
    if (!isMuted(p.item)) return p;
    const n = spare.findIndex((i) => groupOf(i) === p.group);
    const sub = spare.splice(n >= 0 ? n : 0, 1)[0];
    return sub ? { item: sub, group: groupOf(sub) } : null;
  }).filter(Boolean);
}

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

/* ---------- story rendering ---------- */
const GROUP_NOUN = { release: 'Lab release', usable: 'Tool', demo: 'Community project', paper: 'Paper' };
const plural = (n, word) => `${fmtNum(n)} ${word}${n === 1 ? '' : 's'}`;
function signalsText(s = {}) {
  const parts = [];
  if (s.upvotes) parts.push(plural(s.upvotes, 'upvote'));
  if (s.points) parts.push(plural(s.points, 'point') + ' on HN');
  if (s.stars) parts.push(plural(s.stars, 'star'));
  if (s.likes) parts.push(plural(s.likes, 'like'));
  if (s.downloads) parts.push(plural(s.downloads, 'download'));
  return parts.join(', ');
}
function linksHTML(it) {
  const l = it.links || {}, out = [];
  if (l.pdf) out.push(['PDF', l.pdf]);
  if (l.arxiv) out.push(['arXiv', l.arxiv]);
  if (l.code) out.push(['Code', l.code]);
  if (l.hn) out.push(['HN thread', l.hn]);
  else if (l.discussion && l.discussion !== it.url) out.push(['Discussion', l.discussion]);
  return out.map(([t, u]) => `<a href="${esc(safeUrl(u))}" target="_blank" rel="noopener">${t}</a>`).join('');
}
// The item's own preview: what the pipeline found, or (older days) the HF render of a paper's first page
function imageOf(it) {
  if (it.image) return it.image;
  if (it.source_key === 'hf_papers' && /^arxiv:/.test(it.id)) return `https://cdn-thumbnails.huggingface.co/social-thumbnails/papers/${it.id.slice(6)}.png`;
  return '';
}
const figureHTML = (it, cls) => {
  const src = imageOf(it);
  return src ? `<figure class="${cls}" data-slot="story" data-kind="product"><img src="${esc(safeUrl(src))}" alt="" loading="lazy" width="1200" height="648" onerror="this.closest('figure').remove()"></figure>` : '';
};
function bylineHTML(it, group) {
  const noun = GROUP_NOUN[group] || TYPE_LABEL[it.type] || 'Item';
  return `<p class="byline">${noun} from ${esc(it.source)}, <time datetime="${esc(it.date)}">${ago(it.date)}</time>${isNew(it) ? ' <span class="tag tag--in" role="status">New</span>' : ''}</p>`;
}
// On the front page "Less like this" waits behind More, so each story carries three actions
const actionsHTML = (it, open, front) => {
  const read = state.read[it.id], saved = state.saved[it.id];
  const mute = `<button type="button" data-action="mute" title="Hide ${esc(muteLabel(muteKey(it)))}">Less like this</button>`;
  return `<div class="card-actions">
      <button type="button" data-action="details" aria-expanded="${open}">${open ? 'Less' : 'More'}</button>
      <button type="button" data-action="save" aria-pressed="${Boolean(saved)}">${saved ? 'Saved' : 'Save'}</button>
      <button type="button" data-action="read" aria-pressed="${Boolean(read)}">${read ? 'Read' : 'Mark read'}</button>
      ${!front || open ? mute : ''}
    </div>`;
};
function detailsHTML(it) {
  const s = it.summary, sig = signalsText(it.signals), links = linksHTML(it);
  return `<dl class="details">
    ${s && s.key_idea ? `<div><dt>Key idea</dt><dd>${esc(s.key_idea)}</dd></div>` : ''}
    ${s && s.why_it_matters ? `<div><dt>Why it matters</dt><dd>${esc(s.why_it_matters)}</dd></div>` : ''}
    ${it.abstract ? `<div><dt>${it.type === 'paper' ? 'Abstract' : 'Description'}</dt><dd>${esc(it.abstract)}</dd></div>` : ''}
    ${it.authors && it.authors.length ? `<div><dt>By</dt><dd>${esc(it.authors.join(', '))}</dd></div>` : ''}
    ${sig ? `<div><dt>Signal</dt><dd class="num">${esc(sig)}${s ? `, ${esc(s.difficulty)}` : ''}</dd></div>` : ''}
    ${links ? `<div><dt>Links</dt><dd class="links">${links}</dd></div>` : ''}
  </dl>`;
}
// One row of the Explore and Saved lists
function cardHTML(it) {
  const s = it.summary, open = state.expanded.has(it.id);
  const tags = (s && s.tags && s.tags.length ? s.tags : it.tags || []).slice(0, 3);
  const body = s ? s.tldr : truncate(it.abstract, 240);
  return `<article class="card row ${state.read[it.id] ? 'read' : ''}" data-id="${esc(it.id)}" data-type="${esc(it.type)}">
    <h3><a href="${esc(safeUrl(it.url))}" target="_blank" rel="noopener" data-action="open">${esc(it.title)}</a></h3>
    ${body ? `<p class="tldr">${esc(body)}</p>` : ''}
    ${bylineHTML(it, null)}
    ${tags.length ? `<p class="tags">${tags.map((t) => `<button type="button" class="tag-link" data-action="tag" data-tag="${esc(t)}">#${esc(t)}</button>`).join('')}</p>` : ''}
    ${open ? detailsHTML(it) : ''}
    ${actionsHTML(it, open)}
  </article>`;
}
const cardsHTML = (items) => (items.length ? `<div class="ruled">${items.map(cardHTML).join('')}</div>` : '<div class="empty">Nothing here with these filters.</div>');

/* ---------- views ---------- */
// A story on the front page: lead (the day's first pick), rail (picks two and three) or column (the rest)
function storyHTML({ item: it, group, why }, place) {
  const open = state.expanded.has(it.id);
  const head = place === 'lead' ? 'h2' : 'h3';
  const pic = place === 'rail' ? '' : figureHTML(it, `story-photo story-photo--${place}`);
  // A lead with no picture carries more of its own text instead
  const s = it.summary || {};
  const deck = place === 'lead' && !pic ? (s.key_idea || truncate(it.abstract, 640)) : '';
  return `<article class="card story story--${place} ${state.read[it.id] ? 'read' : ''}" data-id="${esc(it.id)}" data-type="${esc(it.type)}">
    ${place === 'col' ? pic : ''}
    <${head}><a href="${esc(safeUrl(it.url))}" target="_blank" rel="noopener" data-action="open">${esc(it.title)}</a></${head}>
    ${why ? `<p class="why">${esc(why)}</p>` : ''}
    ${deck && deck !== why ? `<p class="deck">${esc(deck)}</p>` : ''}
    ${bylineHTML(it, group)}
    ${place === 'lead' ? pic : ''}
    ${open ? detailsHTML(it) : ''}
    ${actionsHTML(it, open, true)}
  </article>`;
}

// The last row: stories with a picture take the wide tracks; text-only ones stack in one narrower track
function columnsHTML(cols) {
  if (!cols.length) return '';
  const pictured = cols.filter((p) => imageOf(p.item)), plain = cols.filter((p) => !imageOf(p.item));
  if (!pictured.length || !plain.length) return `<div class="columns">${cols.map((p) => storyHTML(p, 'col')).join('')}</div>`;
  return `<div class="columns columns--mixed" style="--pictured: ${pictured.length}">
    <div class="column-stack">${plain.map((p) => storyHTML(p, 'col')).join('')}</div>
    ${pictured.map((p) => storyHTML(p, 'col')).join('')}</div>`;
}

function renderToday() {
  const day = state.days.get(state.viewDate) || { items: [] };
  const items = day.items, digest = day.digest;
  const concept = state.concepts.find((c) => c.slug === day.concept_slug) || state.concepts[0];
  const due = dueCards().length;
  const whyFor = Object.fromEntries(((digest && digest.top) || []).map((t) => [t.id, t.why]));
  const brief = briefFor(day), lead0 = brief[0];
  const picks = brief.map((p) => {
    const s = p.item.summary || {};
    return { ...p, why: whyFor[p.item.id] || s.why_it_matters || s.tldr || (p === lead0 ? '' : truncate(p.item.abstract, 200)) };
  });
  const [lead, ...rest] = picks;
  const rail = rest.slice(0, 2), cols = rest.slice(2);
  const days = state.index.days.map((d) => d.date), at = days.indexOf(state.viewDate);
  const step = (dir, label, to) => `<button type="button" class="step" data-action="view-date" data-date="${to || ''}" ${to ? '' : 'disabled'} aria-label="${label}">${dir}</button>`;
  const others = items.length - picks.length;

  $('#app').innerHTML = `
    <section class="edition" aria-label="Edition">
      <div class="edition-head">
        <p class="dateline"><time datetime="${esc(state.viewDate)}">${prettyDate(state.viewDate)}</time>${day.generated_at ? `, updated ${agoTime(day.generated_at)}` : ''}</p>
        <h1>${esc(digest && digest.headline ? digest.headline : `Today’s ${picks.length} picks`)}</h1>
      </div>
      <div class="edition-meta">
        <p>${picks.length} picked from ${items.length} new${digest && digest.themes && digest.themes.length ? `, on ${esc(digest.themes.join(', '))}` : ''}</p>
        <div class="stepper">${step('‹', 'Previous day', days[at + 1])}<span>${at === 0 ? 'Latest' : esc(state.viewDate)}</span>${step('›', 'Next day', days[at - 1])}</div>
      </div>
    </section>
    ${lead ? `<div class="front ${imageOf(lead.item) ? '' : 'front--text'}">
      ${storyHTML(lead, 'lead')}
      ${rail.length ? `<div class="rail">${rail.map((p) => storyHTML(p, 'rail')).join('')}</div>` : ''}
    </div>
    ${columnsHTML(cols)}`
    : '<div class="empty">Nothing was picked for this day.</div>'}
    <section class="learn-band" aria-labelledby="concept-head">
      <div class="concept">
        ${concept ? `<p class="byline">Concept of the day, ${esc(concept.category)}</p>
          <h2 id="concept-head">${esc(concept.name)}</h2>
          <p class="lead">${esc(concept.one_liner)}</p>
          <a class="btn btn--primary" href="#learn/${esc(concept.slug)}">Open the lesson</a>`
        : `<h2 id="concept-head">Concept of the day</h2>
          <p class="lead">Lessons appear once an LLM provider is configured for the daily build (see README).</p>`}
      </div>
      <dl class="figures">
        <div><dt>Cards due</dt><dd class="num">${due}</dd></div>
        <div><dt>Day streak</dt><dd class="num">${streak()}</dd></div>
        <div><dt>Learned</dt><dd class="num">${Object.keys(state.learned).length}</dd></div>
        ${due ? '<div class="figures-action"><button type="button" class="btn" data-action="go-review">Review cards</button></div>' : ''}
      </dl>
    </section>
    ${others > 0 ? `<p class="more-link"><a href="#explore">See the other ${others} in Explore</a></p>` : ''}`;
}

function renderList() {
  const f = state.filter, p = state.prefs, q = state.query.trim().toLowerCase();
  const inRange = rangeItems();
  const visible = inRange.filter((i) => !isMuted(i));
  let items = visible.filter((i) => !f.type || i.tab === f.type);
  const sources = [...new Set(items.map((i) => i.source))].sort();
  const kinds = f.type === 'models' ? [...new Set(items.map((i) => i.type))] : [];
  items = items.filter((i) =>
    (!f.source || i.source === f.source) &&
    (!f.kind || i.type === f.kind) &&
    (!f.tag || itemTags(i).includes(f.tag)) &&
    (!p.unread || !state.read[i.id]) &&
    (!p.newOnly || isNew(i)) &&
    matchesQuery(i, q));
  items.sort(p.sort === 'newest'
    ? (a, b) => (b.first_seen || '').localeCompare(a.first_seen || '') || b.score - a.score
    : (a, b) => b.score - a.score);
  const mutedKeys = Object.keys(state.muted);
  const typeBtn = (t, label) => `<button type="button" aria-pressed="${f.type === t}" class="${f.type === t ? 'active' : ''}" data-action="type" data-type="${t}">${label} <span class="num">${visible.filter((i) => !t || i.tab === t).length}</span></button>`;

  $('#app').innerHTML = `
    <div class="list-head">
      <h1>Everything we fetched</h1>
      <div class="segmented" role="group" aria-label="Type">${typeBtn('', 'All')}${LIST_TABS.map((t) => typeBtn(t, TAB_LABEL[t])).join('')}</div>
    </div>
    <div class="toolbar">
      <label>Range <select data-action="range">${RANGES.map(([n, l]) => `<option value="${n}" ${n === p.range ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <label>Source <select data-action="source"><option value="">All sources</option>${sources.map((s) => `<option ${s === f.source ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select></label>
      <label>Sort <select data-action="sort"><option value="score" ${p.sort === 'score' ? 'selected' : ''}>Top ranked</option><option value="newest" ${p.sort === 'newest' ? 'selected' : ''}>Newest</option></select></label>
      ${kinds.length > 1 ? `<span class="kinds">${['', ...kinds].map((k) => `<button type="button" class="tag ${f.kind === k || (!k && !f.kind) ? 'tag--on' : ''}" data-action="kind" data-kind="${k}">${k ? TYPE_LABEL[k] + 's' : 'All'}</button>`).join('')}</span>` : ''}
      <span class="spacer"></span>
      <label class="check"><input type="checkbox" data-action="unread" ${p.unread ? 'checked' : ''}> Unread</label>
      <label class="check"><input type="checkbox" data-action="new-only" ${p.newOnly ? 'checked' : ''}> New only</label>
    </div>
    <div class="list-meta"><p>${items.length} item${items.length === 1 ? '' : 's'}${q ? ` matching “${esc(q)}”` : ''}</p>
      ${f.tag ? `<p>Tag <button type="button" class="tag tag--on" data-action="clear-tag" aria-label="Clear tag ${esc(f.tag)}">#${esc(f.tag)} ✕</button></p>` : ''}
      ${mutedKeys.length ? `<p>${inRange.length - visible.length} hidden by “less like this”: ${mutedKeys.map((k) => `<button type="button" class="tag tag--out" data-action="unmute" data-key="${esc(k)}" title="Show again">${esc(muteLabel(k))} ✕</button>`).join(' ')}</p>` : ''}</div>
    ${cardsHTML(items)}`;
}

function renderSearch() {
  const q = state.query.trim().toLowerCase();
  const items = rangeItems(30).filter((i) => matchesQuery(i, q)).sort((a, b) => b.score - a.score);
  const concepts = state.concepts.filter((c) => (c.name + ' ' + c.one_liner + ' ' + c.body).toLowerCase().includes(q));
  $('#app').innerHTML = `
    <div class="list-head"><h1>Search</h1></div><div class="list-meta"><p>${items.length} items and ${concepts.length} lessons matching “${esc(q)}” (last 30 days loaded)</p></div>
    ${concepts.length ? `<div class="toolbar">${concepts.map((c) => `<a class="tag" href="#learn/${esc(c.slug)}">${esc(c.name)}</a>`).join('')}</div>` : ''}
    ${cardsHTML(items.slice(0, 100))}`;
}

function renderLearn() {
  const due = dueCards();
  const seg = `<div class="segmented">
      <button type="button" aria-pressed="${state.learnView === 'lesson'}" class="${state.learnView === 'lesson' ? 'active' : ''}" data-action="learn-view" data-view="lesson">Lessons</button>
      <button type="button" aria-pressed="${state.learnView === 'review'}" class="${state.learnView === 'review' ? 'active' : ''}" data-action="learn-view" data-view="review">Review, ${due.length} due</button>
    </div>`;
  if (!state.concepts.length) {
    $('#app').innerHTML = seg + '<div class="empty">No lessons yet. A new Concept of the Day is generated in each daily build once a free LLM provider key is set (see README).</div>';
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
    return hit ? `<a class="tag" href="#learn/${esc(hit.slug)}">${esc(p)}</a>` : `<span class="tag tag--out">${esc(p)}</span>`;
  }).join(' ');
  const learned = state.learned[c.slug];

  $('#app').innerHTML = seg + `
    <div class="learn-grid">
      <aside class="lesson-index">
        <p class="concept-count">${state.concepts.length} lesson${state.concepts.length === 1 ? '' : 's'}, ${Object.keys(state.learned).length} learned, ${streak()} day streak</p>
        <div class="concept-list">${state.concepts.map((x) => `
          <button class="${x.slug === c.slug ? 'active' : ''}" data-action="concept" data-slug="${esc(x.slug)}">
            <span class="n">${state.learned[x.slug] ? '✓ ' : ''}${esc(x.name)}</span>
            <span class="d">${esc(x.date)}, ${esc(x.category)}</span></button>`).join('')}
        </div>
      </aside>
      <article class="lesson">
        <p class="byline">${esc(prettyDate(c.date))}, ${esc(c.category)}</p>
        <h1>${esc(c.name)}</h1>
        <p class="one-liner">${esc(c.one_liner)}</p>
        ${prereq ? `<p class="prereq">Prerequisites: ${prereq}</p>` : ''}
        ${renderMarkdown(c.body)}
        ${related.length ? `<h2>Papers from that day</h2>${cardsHTML(related)}` : ''}
        ${(c.flashcards || []).length ? `<h2>Flashcards</h2><p class="muted">${c.flashcards.length} cards from this lesson are in your review queue.</p>` : ''}
        <div class="lesson-actions">
          <button type="button" class="btn ${learned ? '' : 'btn--primary'}" data-action="learned" data-slug="${esc(c.slug)}">${learned ? 'Learned on ' + learned : 'Mark as learned'}</button>
          ${due.length ? `<button type="button" class="btn" data-action="learn-view" data-view="review">Review ${due.length} cards</button>` : ''}
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
    return `<div class="empty"><p>All caught up${r.done ? `: ${r.done} reviews done` : ''}. New cards arrive with each day’s lesson.</p>
      <p>${streak()} day streak</p></div>`;
  }
  const card = cards[r.queue[0]];
  return `<div class="review">
    <div class="review-meta">
      <span>From <a href="#learn/${esc(card.concept.slug)}">${esc(card.concept.name)}</a></span><span class="num">${r.queue.length} left, ${r.done} done</span></div>
    <div class="flashcard">
      <div class="q">${esc(card.q)}</div>
      ${r.revealed ? `<div class="a">${esc(card.a)}</div>` : ''}
    </div>
    <div class="grade-row">${r.revealed
      ? `<button type="button" class="btn" data-action="grade" data-q="0">Again <kbd>1</kbd></button>
         <button type="button" class="btn" data-action="grade" data-q="3">Hard <kbd>2</kbd></button>
         <button type="button" class="btn" data-action="grade" data-q="4">Good <kbd>3</kbd></button>
         <button type="button" class="btn" data-action="grade" data-q="5">Easy <kbd>4</kbd></button>`
      : '<button type="button" class="btn btn--primary" data-action="reveal">Show answer <kbd>space</kbd></button>'}
    </div></div>`;
}

function renderSaved() {
  const all = Object.values(state.saved).sort((a, b) => (b.saved_at || '').localeCompare(a.saved_at || ''));
  const readN = all.filter((i) => state.read[i.id]).length;
  const q = state.query.trim().toLowerCase();
  const items = all.filter((i) =>
    (state.savedFilter === 'all' || (state.savedFilter === 'read') === Boolean(state.read[i.id])) && matchesQuery(i, q));
  $('#app').innerHTML = `
    <div class="list-head"><h1>Saved for later</h1></div>
    <div class="toolbar">
      <div class="segmented" role="group" aria-label="Show">${['all', 'unread', 'read'].map((k) => `<button type="button" aria-pressed="${state.savedFilter === k}" class="${state.savedFilter === k ? 'active' : ''}" data-action="saved-filter" data-f="${k}">${k[0].toUpperCase() + k.slice(1)}</button>`).join('')}</div>
      <span class="spacer"></span>
      <button type="button" class="btn" data-action="export">Export progress</button>
      <label class="btn btn--file">Import<input type="file" accept="application/json" data-action="import" hidden></label>
    </div>
    ${all.length ? `<div class="saved-progress"><p class="list-meta">${readN} of ${all.length} saved items read</p>
      <progress max="${all.length}" value="${readN}">${readN} of ${all.length}</progress></div>` : ''}
    ${all.length ? cardsHTML(items) : '<div class="empty">Nothing saved yet. Use Save on anything you want to read later.</div>'}
    <p class="note">Saved items, read marks and flashcard progress are stored in this browser only. Use Export / Import to move them between devices.</p>`;
}

function renderFooter() {
  const s = state.status;
  if (!s) { $('#footer').innerHTML = ''; return; }
  const src = Object.entries(s.sources || {});
  const bad = src.filter(([, v]) => !v.ok).length;
  const llm = s.llm || {};
  const llmLabel = llm.skipped ? 'LLM skipped' : llm.ok ? 'LLM ok (' + Object.keys(llm.calls || {}).join(', ') + ')' : 'LLM unavailable';
  const pill = (ok, partial) => `<span class="tag ${ok ? (partial ? 'tag--out' : 'tag--in') : 'tag--on'}">${ok ? (partial ? 'partial' : 'ok') : 'failed'}</span>`;
  $('#footer').innerHTML = `<details>
    <summary>
      <span>${src.length - bad} of ${src.length} sources healthy${bad ? ` <span class="tag tag--out">${bad} failed</span>` : ''}</span>
      <span>${esc(llmLabel)}</span>
      <span>Data updated ${agoTime(s.generated_at)}</span>
      <span class="summary-more">Source health</span>
    </summary>
    <table class="status-table">
      <thead><tr><th scope="col">Source</th><th scope="col">State</th><th scope="col" class="num">Items</th><th scope="col" class="num">Time</th><th scope="col">Notes</th></tr></thead>
      <tbody>
      ${src.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${pill(v.ok, v.partial_errors)}</td><td class="num">${v.count}</td><td class="num">${v.ms} ms</td>
        <td>${esc(v.error || (v.partial_errors ? Object.entries(v.partial_errors).map(([a, b]) => a + ': ' + b).join(', ') : ''))}</td></tr>`).join('')}
      <tr><td>llm</td><td>${pill(llm.ok, false)}</td><td class="num">${Object.values(llm.calls || {}).reduce((a, b) => a + b, 0)} calls</td><td></td>
        <td>${esc(llm.error || (llm.errors || []).slice(-3).join(', '))}</td></tr>
      </tbody>
    </table></details>`;
}

function renderTabCounts() {
  const items = rangeItems(1);
  for (const a of document.querySelectorAll('#tabs a')) {
    const t = a.dataset.tab, el = $('.count', a);
    a.classList.toggle('active', t === state.tab);
    if (!el) continue;
    let text = '', isNewCount = false;
    if (t === 'explore') {
      const n = rangeItems().filter((i) => isNew(i) && !isMuted(i)).length;
      isNewCount = n > 0;
      text = n ? '+' + n : String(items.length || '');
    } else if (t === 'learn') { const d = dueCards().length; text = d ? String(d) : ''; isNewCount = d > 0; }
    else if (t === 'saved') { const n = Object.keys(state.saved).filter((id) => !state.read[id]).length; text = n ? String(n) : ''; }
    el.textContent = text;
    el.classList.toggle('new', isNewCount);
  }
}

function render() {
  renderTabCounts();
  const q = state.query.trim();
  if (q && state.tab !== 'explore' && state.tab !== 'saved') { loadRange(30).then(renderSearch); return; }
  if (state.tab === 'today') renderToday();
  else if (state.tab === 'explore') renderList();
  else if (state.tab === 'learn') renderLearn();
  else if (state.tab === 'saved') renderSaved();
}

/* ---------- routing & events ---------- */
async function route() {
  const [tab, arg] = (location.hash.slice(1) || 'today').split('/');
  if (LIST_TABS.includes(tab)) { location.replace('#explore/' + tab); return; } // old per-type tabs
  state.tab = TABS.includes(tab) ? tab : 'today';
  if (state.tab === 'explore' && arg !== undefined) state.filter.type = LIST_TABS.includes(arg) ? arg : '';
  if (state.tab === 'learn') {
    if (arg) { state.learnSlug = decodeURIComponent(arg); state.learnView = 'lesson'; }
    if (state.learnView === 'review') state.review = null;
  }
  if (state.tab === 'explore') await loadRange(state.prefs.range);
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
  if (state.tab === 'today') { render(); return; } // brief rows carry per-day copy; re-render the view
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
  else if (a === 'mute') {
    const key = muteKey(findItem(id));
    state.muted[key] = new Date().toISOString();
    store.set('muted', state.muted); render();
    toast(`Hiding ${muteLabel(key)}`, `<button data-action="unmute" data-key="${esc(key)}">Undo</button>`);
  }
  else if (a === 'unmute') { delete state.muted[t.dataset.key]; store.set('muted', state.muted); $('#toast')?.remove(); render(); }
  else if (a === 'tag') {
    Object.assign(state.filter, { tag: t.dataset.tag, type: '', kind: '', source: '' });
    if (state.tab !== 'explore') location.hash = 'explore'; else { history.replaceState(null, '', '#explore'); render(); }
  }
  else if (a === 'clear-tag') { state.filter.tag = ''; render(); }
  else if (a === 'type') { Object.assign(state.filter, { type: t.dataset.type, kind: '', source: '' }); history.replaceState(null, '', '#explore' + (t.dataset.type ? '/' + t.dataset.type : '')); render(); }
  else if (a === 'kind') { state.filter.kind = t.dataset.kind; render(); }
  else if (a === 'view-date') { state.viewDate = t.dataset.date; loadDay(t.dataset.date).then(render); }
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

function toast(text, actionHTML) {
  $('#toast')?.remove();
  const el = Object.assign(document.createElement('div'), { id: 'toast', className: 'toast', role: 'status' });
  el.innerHTML = `<span>${esc(text)}</span>${actionHTML || ''}`;
  document.body.append(el);
  setTimeout(() => el.remove(), 6000);
}

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
  else if (a === 'source') { state.filter.source = t.value; render(); }
  else if (a === 'sort') { state.prefs.sort = t.value; savePrefs(); render(); }
  else if (a === 'unread') { state.prefs.unread = t.checked; savePrefs(); render(); }
  else if (a === 'new-only') { state.prefs.newOnly = t.checked; savePrefs(); render(); }
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
  const keys = ['read', 'saved', 'srs', 'learned', 'muted', 'activity', 'prefs'];
  const blob = new Blob([JSON.stringify(Object.fromEntries(keys.map((k) => [k, store.get(k, null)])), null, 1)], { type: 'application/json' });
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `ai-pulse-progress-${todayStr()}.json` });
  a.click();
  URL.revokeObjectURL(a.href);
}
function importProgress(file) {
  file.text().then((txt) => {
    const data = JSON.parse(txt);
    for (const k of ['read', 'saved', 'srs', 'learned', 'muted']) if (data[k]) { state[k] = Object.assign({}, state[k], data[k]); store.set(k, state[k]); }
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
    $('#app').innerHTML = `<div class="empty">No data yet. Run <code>python -m pipeline.build</code> to generate it.<br><span class="note">${esc(e.message)}</span></div>`;
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
