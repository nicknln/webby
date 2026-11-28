/* store.js – the editor's "server", running in the browser instead.
   Used automatically when there's no Python server (e.g. on GitHub Pages).
   Answers the same /api/... requests as app/server.py, keeping drafts,
   earlier versions and built editions in this browser's storage. */
(function (root) {
  'use strict';
  const G = root.Gaff;
  const NAME = /^\d{4}-\d{2}-\d{2}$/;
  const BACKUP_NAME = /^(\d{4}-\d{2}-\d{2})\/(\d{8}-\d{6})$/;
  const BACKUPS_KEPT = 20;
  const K = {
    draft: d => `gaff.draft.${d}`,
    edition: d => `gaff.edition.${d}`,
    backups: d => `gaff.backups.${d}`,
  };

  /* ---------------- storage (falls back to memory if the browser blocks it) ---------------- */

  const memory = new Map();
  function storage() { try { return root.localStorage || null; } catch { return null; } }
  function getItem(k) {
    const s = storage();
    try { if (s) return s.getItem(k); } catch { /* blocked */ }
    return memory.has(k) ? memory.get(k) : null;
  }
  function keys(prefix) {
    const out = new Set([...memory.keys()].filter(k => k.startsWith(prefix)));
    const s = storage();
    try { if (s) for (let i = 0; i < s.length; i++) { const k = s.key(i); if (k && k.startsWith(prefix)) out.add(k); } } catch { /* blocked */ }
    return [...out];
  }
  const isQuota = e => e && (e.name === 'QuotaExceededError' || e.code === 22 || e.code === 1014);
  function setItem(k, v) {
    const s = storage();
    if (!s) { memory.set(k, v); return; }
    try { s.setItem(k, v); return; } catch (e) {
      if (!isQuota(e)) { memory.set(k, v); return; }
    }
    // Full: drop the oldest earlier versions, then try once more.
    for (const bk of keys('gaff.backups.')) {
      const list = readJSON(bk, []);
      if (list.length > 2) { try { s.setItem(bk, JSON.stringify(list.slice(-2))); } catch { /* ignore */ } }
    }
    try { s.setItem(k, v); } catch {
      throw new Error('This browser’s storage is full. Delete old drafts under “Open a draft…” → Manage drafts.');
    }
  }
  function removeItem(k) {
    memory.delete(k);
    const s = storage();
    try { if (s) s.removeItem(k); } catch { /* blocked */ }
  }
  function readJSON(k, fallback) {
    const raw = getItem(k);
    if (raw == null) return fallback;
    try { return JSON.parse(raw); } catch { return fallback; }
  }

  /* ---------------- drafts, editions, earlier versions ---------------- */

  const dates = prefix => keys(prefix).map(k => k.slice(prefix.length)).filter(d => NAME.test(d)).sort().reverse();
  const pad = n => String(n).padStart(2, '0');
  function stamp(t = new Date()) {
    return `${t.getFullYear()}${pad(t.getMonth() + 1)}${pad(t.getDate())}-${pad(t.getHours())}${pad(t.getMinutes())}${pad(t.getSeconds())}`;
  }

  function dateName(ui) {
    const name = String((ui && ui.date) || '');
    if (!NAME.test(name)) throw new G.EditionError('Set the edition date first');
    return name;
  }

  function saveDraft(ui) {
    const name = dateName(ui);
    const next = JSON.stringify(ui);
    const old = getItem(K.draft(name));
    if (old != null && old !== next) {
      const list = readJSON(K.backups(name), []);
      const last = list[list.length - 1];
      const shrank = next.length < old.length * 0.6;
      if (!last || Date.now() - last.at > 60000 || shrank) {
        list.push({ stamp: stamp(), at: Date.now(), json: old });
        setItem(K.backups(name), JSON.stringify(list.slice(-BACKUPS_KEPT)));
      }
    }
    setItem(K.draft(name), next);
    return 'this browser';
  }

  // Everything saved here, newest first; a draft wins over a built copy of the same date.
  function saved() {
    const byDate = new Map();
    for (const d of dates('gaff.edition.')) { const e = readJSON(K.edition(d), null); if (e && e.ui) byDate.set(d, e.ui); }
    for (const d of dates('gaff.draft.')) { const u = readJSON(K.draft(d), null); if (u) byDate.set(d, u); }
    return [...byDate.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1));
  }

  function scaffold(dateStr) {
    let t = dateStr ? G.parseDate(dateStr) : null;
    if (dateStr && t === null) throw new G.EditionError(`Invalid date: ${dateStr}`);
    const all = saved();
    if (t === null) t = all.length ? G.parseDate(all[0][0]) + 7 * G.DAY : G.nextFriday(G.todayUTC());
    const prev = all.find(([d]) => G.parseDate(d) < t);
    const prevUi = prev ? prev[1] : {};
    const ed = { date: G.isoDate(t), previous_edition: prevUi.posted_url || '' };
    for (const key of G.SECTION_KEYS) ed[key] = { author: (prevUi[key] && prevUi[key].author) || G.DEFAULT_AUTHORS[key] };
    return G.toUi(ed);
  }

  function listing() {
    const drafts = dates('gaff.draft.');
    const backups = {}, counts = {};
    for (const d of drafts) {
      const list = readJSON(K.backups(d), []);
      if (list.length) { backups[d] = list.map(b => b.stamp).reverse().slice(0, 15); counts[d] = list.length; }
    }
    return { drafts, editions: dates('gaff.edition.'), backups, backup_counts: counts };
  }

  // Tidy up: a draft (with its earlier versions), one draft's earlier versions, or all of them. Built editions stay.
  function deleteSaved(kind, name) {
    if (kind === 'all-backups') { keys('gaff.backups.').forEach(removeItem); return listing(); }
    if (!NAME.test(name || '')) throw new G.EditionError('bad name');
    if (kind === 'backups') removeItem(K.backups(name));
    else if (kind === 'draft') { removeItem(K.draft(name)); removeItem(K.backups(name)); }
    else throw new G.EditionError('bad kind');
    return listing();
  }

  function openSaved(kind, name) {
    if (kind === 'backup') {
      const m = BACKUP_NAME.exec(name || '');
      if (!m) throw new G.EditionError('bad name');
      const hit = readJSON(K.backups(m[1]), []).find(b => b.stamp === m[2]);
      if (!hit) throw new G.EditionError('That earlier version is no longer kept');
      return JSON.parse(hit.json);
    }
    if (!NAME.test(name || '')) throw new G.EditionError('bad name');
    if (kind === 'draft') { const u = readJSON(K.draft(name), null); if (u) return u; }
    if (kind === 'edition') { const e = readJSON(K.edition(name), null); if (e) return e.ui; }
    throw new G.EditionError(`Nothing saved for ${name}`);
  }

  // The gaff being made now: the next Friday (today, if it's a Friday) that hasn't been built yet.
  function currentFriday() {
    let t = G.nextFriday(G.todayUTC());
    while (getItem(K.edition(G.isoDate(t))) != null) t += 7 * G.DAY;
    return G.isoDate(t);
  }

  // What the editor opens on: this week's draft, or a fresh one for this week's Friday.
  function latest() {
    const d = currentFriday();
    return readJSON(K.draft(d), null) || scaffold(d);
  }

  function build(ui) {
    const name = dateName(ui);
    const ed = G.fromUi(ui);
    let md;
    try {
      md = G.render(ed);
    } catch (e) {
      if (!(e instanceof G.EditionError)) throw e;
      const { warnings } = G.renderParts(ed, false);
      return { ok: false, errors: warnings.length ? warnings : [e.message] };
    }
    setItem(K.edition(name), JSON.stringify({ ui, markdown: md, built: new Date().toISOString() }));
    saveDraft(ui);
    return { ok: true, title: G.threadTitle(ed), markdown: md, files: [], browser: true };
  }

  const meta = () => ({
    authors: G.DEFAULT_AUTHORS,
    avatars: Object.fromEntries(Object.entries(G.AVATARS).map(([k, v]) => [String(k), v])),
    images: G.IMAGES,
    defaults: { say_hello_intro: G.SAY_HELLO_INTRO, say_hello_outro: G.SAY_HELLO_OUTRO, giffgaffiversary_intro: G.GIFFGAFFIVERSARY_INTRO },
    labels: G.SECTION_LABELS,
    mode: 'browser',
  });

  /* ---------------- the same requests app/server.py answers ---------------- */

  async function api(path, body) {
    const url = new URL(path, 'http://local');
    const q = Object.fromEntries(url.searchParams.entries());
    try {
      switch (url.pathname) {
        case '/api/meta': return meta();
        case '/api/list': return listing();
        case '/api/latest': return latest();
        case '/api/new': return scaffold(q.date || null);
        case '/api/open': return openSaved(q.kind, q.name);
        case '/api/render': return G.renderUi(body || {}, false);
        case '/api/draft': return { saved: saveDraft(body || {}) };
        case '/api/build': return build(body || {});
        case '/api/delete': return deleteSaved((body || {}).kind, (body || {}).name);
        default: throw new Error('not found');
      }
    } catch (e) {
      throw new Error(e.message);
    }
  }

  root.GaffStore = { api };
})(typeof window !== 'undefined' ? window : globalThis);
