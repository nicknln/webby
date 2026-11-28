/* The gaff editor – the post itself is the editor.
   Fixed parts are drawn for you; dashed boxes are where you type or paste.
   Uses md.js (htmlToMd / mdToHtml) and the same server API as the form view. */
'use strict';

let META = null;
let ed = null;            // edition being edited (same JSON shape the server and form view use)
let active = 'header';    // current step: a section key or 'review'
let lastRender = null;    // last /api/render result (markdown parts + warnings)
const attempted = {};     // sections where "Mark done" was pressed (show missing-field hints)
let EDIT = false;         // whether the section being drawn is editable (captured by each slot)

const STEPS = [
  { key: 'header', label: 'Header' },
  { key: 'happenings', label: 'Happenings', title: 'giffgaff Happenings', toggle: true, list: 'stories', item: 'story', about: 'giffgaff news and the threads people are talking about' },
  { key: 'say_hello', label: 'Say Hello', title: 'Say Hello!', toggle: true, list: 'members', item: 'new member', about: 'new members and their first posts' },
  { key: 'giffgaffiversary', label: 'giffgaffiversary', title: 'Happy giffgaffiversary!', toggle: true, list: 'posts', item: 'anniversary', about: 'members celebrating years with giffgaff' },
  { key: 'photo_of_the_week', label: 'Photo of the Week', title: 'Photo Of The Week', toggle: true, about: 'the best photo shared this week' },
  { key: 'extras', label: 'Extras' },
];
const STEP_BY = Object.fromEntries(STEPS.map(s => [s.key, s]));

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const $ = s => document.querySelector(s);
const SMOOTH = matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

// Every box in the editor is content, not a login: tell browsers and password
// managers (Bitwarden, 1Password, LastPass…) not to offer to fill them.
const NO_AUTOFILL = { autocomplete: 'off', 'data-bwignore': 'true', 'data-1p-ignore': 'true', 'data-lpignore': 'true', 'data-form-type': 'other' };

function el(tag, props = {}, ...kids) {
  if (tag === 'input') props = { ...NO_AUTOFILL, ...props };
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'html') n.innerHTML = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? '' : v);
  }
  n.append(...kids.flat().filter(k => k !== null && k !== undefined && k !== false));
  return n;
}

function getPath(obj, path) { return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj); }
function setPath(obj, path, value) {
  const keys = path.split('.');
  let o = obj;
  keys.slice(0, -1).forEach((k, i) => {
    if (o[k] == null) o[k] = /^\d+$/.test(keys[i + 1]) ? [] : {};
    o = o[k];
  });
  o[keys.at(-1)] = value;
}
function hasContent(v) {
  if (typeof v === 'string') return v.trim() !== '';
  if (typeof v === 'number') return false;
  if (Array.isArray(v)) return v.some(hasContent);
  if (v && typeof v === 'object') {
    return Object.entries(v).some(([k, x]) => !k.startsWith('_') && k !== 'enabled' && k !== 'author' && k !== 'avatar' && hasContent(x));
  }
  return false;
}

// 'server' when app/server.py is running (drafts and builds go to project files);
// 'browser' when it isn't, e.g. on GitHub Pages (everything stays in this browser).
let MODE = 'server';

async function detectMode() {
  try {
    const res = await fetch('/api/meta', { cache: 'no-store' });
    if (res.ok && (res.headers.get('content-type') || '').includes('application/json')) return 'server';
  } catch { /* no server */ }
  return 'browser';
}

async function api(path, body) {
  if (MODE === 'browser') return window.GaffStore.api(path, body);
  const res = await fetch(path, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ edition: body }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

let toastTimer;
function toast(msg, action) {
  const t = $('#toast');
  t.innerHTML = '';
  t.append(el('span', {}, msg));
  if (action) t.append(el('button', { type: 'button', class: 'toast-btn', onclick: () => { t.hidden = true; action.run(); } }, action.label));
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), action ? 8000 : 4000);
}

// Remove and Skip can be taken back: keep a copy from just before, and offer Undo for a few seconds.
function undoable(msg, fn) {
  const before = { ed: structuredClone(ed), active };
  fn();
  changed();
  renderAll();
  toast(msg, { label: 'Undo', run: () => { ed = before.ed; active = before.active; changed(); renderAll(); toast('Put back.'); } });
}

async function copy(text, btn, msg = 'Copied') {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    toast('Your browser didn’t allow copying. Open the Markdown strip on the right, select it all, and copy it from there.');
    return false;
  }
  if (!btn) { toast(msg); return true; }
  const old = btn.textContent;
  btn.textContent = msg;
  setTimeout(() => (btn.textContent = old), 1500);
  return true;
}

/* ------------------------------------------------------------------ */
/* Lists typed one-per-line (buzzing links, comments, photo images)    */
/* ------------------------------------------------------------------ */

const LINES = {
  links: {
    // A bare link (or one whose text is just the address) gets a title built from the link.
    parse(line) {
      const s = line.replace(/^\s*[-*]\s+/, '').trim();
      const named = (title, link) => ({ title: !title || title.trim() === link || /^https?:\/\//.test(title.trim()) ? Gaff.titleFromLink(link) : title, link });
      let m = s.match(/^\[(.+)\]\((\S+)\)$/);
      if (m) return named(m[1], m[2]);
      m = s.match(/^(.+?)\s*\|\s*(https?:\/\/\S+)$/);
      if (m) return named(m[1], m[2]);
      if (/^https?:\/\/\S+$/.test(s)) return named('', s);
      return s ? { title: s } : null;
    },
    format: b => {
      if (!b.link) return `- ${b.title || ''}`;
      const title = b.title && b.title.trim() !== b.link && !/^https?:\/\//.test(b.title.trim()) ? b.title : Gaff.titleFromLink(b.link);
      return `- [${title}](${b.link})`;
    },
  },
  comments: {
    parse(line) {
      const s = line.replace(/^\s*[-*]\s+/, '').trim();
      let m = s.match(/^[“"]?([\s\S]*?)[”"]?\s+[—–-]+\s*@([\w.-]+)\s*$/);
      if (m) return { text: m[1].trim(), by: m[2] };
      m = s.match(/^@([\w.-]+)\s*:\s*[“"]?([\s\S]*?)[”"]?$/);
      if (m) return { text: m[2].trim(), by: m[1] };
      return undefined;
    },
    format: c => `- “${c.text || ''}” — @${c.by || ''}`,
  },
  images: {
    parse(line) {
      const s = line.trim();
      const m = s.match(/^!\[[^\]]*\]\((\S+?)(?:\s+"[^"]*")?\)$/);
      if (m) return m[1];
      return /^https?:\/\/\S+$/.test(s) ? s : undefined;
    },
    format: u => `![](${u})`,
  },
};

/* ------------------------------------------------------------------ */
/* Steps, status and checks                                            */
/* ------------------------------------------------------------------ */

const isSkipped = k => !!STEP_BY[k]?.toggle && ed[k]?.enabled === false;

function stepStatus(k) {
  if (!ed._done?.[k]) return 'todo';
  if (isSkipped(k)) return 'skipped';
  return sectionProblems(k).length ? 'warn' : 'done';
}
const finished = k => ['done', 'skipped'].includes(stepStatus(k));
const allDone = () => STEPS.every(s => finished(s.key));
const firstOpenStep = () => (STEPS.find(s => !finished(s.key)) || { key: 'review' }).key;

function warningSection(w) {
  const m = w.match(/^(\w+)[.[:]/);
  if (m && STEP_BY[m[1]]) return m[1];
  if (/^sections[.[]/.test(w)) return 'extras';
  return 'header';
}

// "happenings.stories[2]: missing `title`" -> "happenings.stories.1.title"
function warningPath(w) {
  let m = w.match(/^(\w+)\.(\w+)\[(\d+)\]: missing `(\w+)`/);
  if (m) return `${m[1]}.${m[2]}.${m[3] - 1}.${m[4]}`;
  m = w.match(/^sections\[(\d+)\]: missing `(\w+)`/);
  if (m) return `sections.${m[1] - 1}.${m[2]}`;
  m = w.match(/^(\w+): missing `(\w+)`/);
  if (m) return `${m[1]}.${m[2]}`;
  return null;
}

const FIELD = { title: 'a title', link: 'a link', by: 'a username', text: 'the comment', photo_title: 'the photo’s title' };
function friendly(w) {
  const label = k => STEP_BY[k]?.label || k;
  return w
    .replace(/^(\w+)\.(\w+)\[(\d+)\]: missing `(\w+)`/, (_, s, l, n, f) => `${label(s)}: item ${n} needs ${FIELD[f] || f}`)
    .replace(/^sections\[(\d+)\]: missing `(\w+)`/, (_, n, f) => `Extras: section ${n} needs ${FIELD[f] || f}`)
    .replace(/^photo_of_the_week: missing `by`/, 'Photo of the Week: who took the photo?')
    .replace(/^(\w+): missing `(\w+)`/, (_, s, f) => `${label(s)}: needs ${FIELD[f] || f}`)
    .replace(/^sections\.(\d+): /, 'Extras (section $1): ')
    .replace(/^(\w+): /, (m, s) => (STEP_BY[s] ? `${label(s)}: ` : m));
}

function sectionProblems(k) {
  if (k === 'review' || isSkipped(k)) return [];
  const probs = (lastRender?.warnings || []).filter(w => warningSection(w) === k).map(friendly);
  if (k === 'header') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(ed.date || '')) probs.push('Set the edition date');
    if (!(ed.previous_edition || '').trim()) probs.push('Paste the link to last week’s gaff');
  }
  const s = STEP_BY[k];
  if (s?.list && !(ed[k]?.[s.list] || []).some(hasContent)) probs.push(PART ? `Add at least one ${s.item}` : `Add at least one ${s.item}, or skip this week`);
  if (PART === 'extras' && k === 'extras' && !(ed.sections || []).some(hasContent)) probs.push('Add a section first');
  return probs;
}

function nextStepKey(k) {
  const i = STEPS.findIndex(s => s.key === k);
  return (STEPS.slice(i + 1).find(s => !finished(s.key)) || { key: firstOpenStep() }).key;
}

/* ------------------------------------------------------------------ */
/* Slots: the dashed boxes in the post                                 */
/* ------------------------------------------------------------------ */

// A username from whatever was pasted: "@name", or a profile link like
// https://community.giffgaff.com/u/name (right-click their name → Copy link address).
function pastedUsername(text, html) {
  text = (text || '').trim();
  const fromUrl = s => (/\/u\/([\w.-]+)\/?(?:[?#].*)?$/.exec(s || '') || [])[1];
  const a = html && new DOMParser().parseFromString(html, 'text/html').querySelector('a[href*="/u/"]');
  return fromUrl(text) || (a && fromUrl(a.getAttribute('href'))) || (/^@[\w.-]+$/.test(text) ? text.slice(1) : null);
}

// The web address in whatever was pasted: a bare link, or a link copied as rich text.
function linkFrom(html, text) {
  const m = (text || '').trim().match(/https?:\/\/\S+/);
  if (m) return m[0];
  const a = html && new DOMParser().parseFromString(html, 'text/html').querySelector('a[href]');
  return a ? absUrl(a.getAttribute('href')) : null;
}

const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const PASTE_KEY = IS_MAC ? '⌘V' : 'Ctrl+V';

// Read what was copied (the browser asks permission the first time). Formatting is kept where the browser allows it.
async function readClipboard() {
  if (navigator.clipboard.read) {
    for (const item of await navigator.clipboard.read()) {
      const html = item.types.includes('text/html') ? await (await item.getType('text/html')).text() : '';
      const text = item.types.includes('text/plain') ? await (await item.getType('text/plain')).text() : '';
      if (html || text) return { html, text };
    }
  }
  return { html: '', text: await navigator.clipboard.readText() };
}

// A green Paste button for anyone who doesn't use Cmd+V: pastes what was copied, tidied the same way.
function pasteButton(label, take, ariaLabel) {
  return el('button', { type: 'button', class: 'btn primary big paste-btn', 'aria-label': ariaLabel || null, onclick: async () => {
    let clip;
    try { clip = await readClipboard(); } catch { return toast(`Your browser didn’t allow that. Click in the box and press ${PASTE_KEY} instead.`); }
    if (!clip.html && !clip.text.trim()) return toast('Nothing copied yet. Copy it first, then press Paste.');
    take(clip.html, clip.text);
  } }, label);
}
const beside = (box, btn) => el('div', { class: 'paste-beside' }, box, btn);

// Single-line text (titles, names, greetings). Enter is ignored; pastes become plain text.
// With `linkable`, a link pasted or typed into a title becomes the item's thread link,
// and the title is worked out from it (like the buzzing list).
function textSlot(path, placeholder, { cls = '', tag = 'div', strip = '', linkable = false, linkPath = path.replace(/\.title$/, '.link'), userLink = false, paste = false } = {}) {
  const editable = EDIT;
  const value = String(getPath(ed, path) ?? '');
  if (!editable && !value) return null;
  const s = el(tag, { class: `slot text-slot ${cls}`, 'data-path': path, 'data-placeholder': placeholder,
    contenteditable: editable ? 'true' : null, spellcheck: 'true',
    role: editable ? 'textbox' : null, 'aria-label': editable ? placeholder : null });
  s.textContent = strip ? value.replace(new RegExp(`^${strip}`), '') : value;
  if (!editable) return s;
  const useLink = url => {
    const before = String(getPath(ed, path) ?? '').trim();
    const keepWords = before && !/^https?:\/\//.test(before);
    setPath(ed, linkPath, url);
    if (!keepWords) setPath(ed, path, Gaff.titleFromLink(url));
    changed();
    renderAll();
    // Photo of the Week: the link can't say who took the photo, so go straight to that box.
    const who = path === 'photo_of_the_week.photo_title' && document.querySelector('[data-path="photo_of_the_week.by"]');
    if (who && !who.textContent.trim()) {
      who.focus();
      return toast('Title worked out from the link. Now add who took the photo: type their username, or paste the link to their profile.');
    }
    toast(keepWords ? 'Link added to the title.' : 'Link added, and the title worked out from it. Click the title to change it.');
  };
  s.addEventListener('input', () => {
    let v = s.textContent.replace(/\s+/g, ' ').trim();
    if (strip) v = v.replace(new RegExp(`^${strip}`), '');
    setPath(ed, path, v);
    changed();
  });
  s.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); s.blur(); } });
  // A username or link is used as such; anything else comes back as plain text to put in the box.
  const take = (html, raw) => {
    const text = (raw || '').replace(/\s+/g, ' ').trim();
    if (userLink) {
      const name = pastedUsername(text, html);
      if (name) { s.textContent = name; s.dispatchEvent(new Event('input')); return null; }
    }
    if (linkable) {
      const a = html && new DOMParser().parseFromString(html, 'text/html').querySelector('a[href]');
      const url = /^https?:\/\/\S+$/.test(text) ? text : (a && a.textContent.trim() === text ? absUrl(a.getAttribute('href')) : null);
      if (url) { useLink(url); return null; }
    }
    return text;
  };
  s.addEventListener('paste', e => {
    e.preventDefault();
    const text = take(e.clipboardData.getData('text/html'), e.clipboardData.getData('text/plain'));
    if (text) document.execCommand('insertText', false, text);
  });
  // For a Paste button (here, or beside a sentence for the inline boxes).
  s.pasteInto = (html, raw) => {
    const text = take(html, raw);
    if (text) { s.textContent = strip ? text.replace(new RegExp(`^${strip}`), '') : text; s.dispatchEvent(new Event('input')); }
  };
  if (linkable) {
    // Typed a link and left the box: same as pasting one.
    s.addEventListener('blur', () => {
      const v = s.textContent.trim();
      if (/^https?:\/\/\S+$/.test(v)) { setPath(ed, path, ''); useLink(v); }
    });
  }
  if (!paste) return s;
  const btn = pasteButton('Paste', s.pasteInto, `Paste: ${placeholder}`);
  const showBtn = () => { btn.hidden = !!s.textContent.trim(); };
  showBtn();
  s.addEventListener('input', showBtn);
  return beside(s, btn);
}

// Rich text (quotes, intros, bodies). Shown rendered; typing and pasting are converted to Markdown.
function mdSlot(path, placeholder, { tag = 'div', cls = '', defaultText = '' } = {}) {
  const editable = EDIT;
  const md = String(getPath(ed, path) ?? '');
  if (!editable && !md && !defaultText) return null;
  const s = el(tag, { class: `slot md-slot ${cls}`, 'data-path': path,
    'data-placeholder': defaultText ? `${defaultText}` : placeholder,
    contenteditable: editable ? 'true' : null, role: editable ? 'textbox' : null, 'aria-multiline': editable ? 'true' : null,
    'aria-label': editable ? (defaultText ? `${defaultText} (standard text: type to change it)` : placeholder) : null });
  if (defaultText) s.classList.add('has-default');
  const show = () => {
    const v = String(getPath(ed, path) ?? '');
    if (v) s.innerHTML = mdToHtml(v);
    else if (!editable && defaultText) s.innerHTML = mdToHtml(defaultText);
    else s.innerHTML = '';
    s.classList.toggle('is-empty', !v);
  };
  show();
  if (!editable) return s;
  // Empty boxes for posts get a big "Paste it here" button, for anyone who doesn't use Cmd+V.
  const pasteRow = defaultText ? null : el('div', { class: 'paste-row' },
    pasteButton('Paste it here', (html, text) => take(html, text, false)),
    el('span', { class: 'paste-help' }, `or click in the box and press ${PASTE_KEY}`));
  const showPaste = () => { if (pasteRow) pasteRow.hidden = !!String(getPath(ed, path) ?? '').trim(); };
  showPaste();
  const take = (html, text, replaceAll) => {
    skippedImages = 0;
    const pasted = html ? htmlToMd(html) : (text || '').replace(/\r/g, '').trim();
    if (!pasted && !skippedImages) return;
    const current = String(getPath(ed, path) ?? '');
    setPath(ed, path, replaceAll || !current ? pasted : `${current}\n\n${pasted}`.trim());
    show();
    showPaste();
    report(html, pasted);
    changed();
  };
  s.addEventListener('input', () => {
    const v = s.textContent.trim() || s.querySelector('img') ? htmlToMd(s.innerHTML) : '';
    setPath(ed, path, v);
    s.classList.toggle('is-empty', !v);
    showPaste();
    changed();
  });
  s.addEventListener('blur', show);   // tidy the rendering once you leave the box
  s.addEventListener('paste', e => {
    e.preventDefault();
    const sel = window.getSelection();
    const all = !s.textContent.trim() || (sel && sel.toString().trim() && sel.toString().trim() === s.textContent.trim());
    take(e.clipboardData.getData('text/html'), e.clipboardData.getData('text/plain'), all);
  });
  return pasteRow ? el('div', { class: 'paste-wrap' }, s, pasteRow) : s;
}

// One item per line, shown rendered (links list, comments list, images).
function linesSlot(sec, k, kind, placeholder) {
  const editable = EDIT;
  const path = `${sec}.${k}`;
  const rawPath = `${sec}._raw_${k}`;
  const items = getPath(ed, path) || [];
  if (!editable && !items.length) return null;
  const s = el('div', { class: `slot lines-slot lines-${kind}`, 'data-path': path, 'data-placeholder': placeholder,
    contenteditable: editable ? 'true' : null, role: editable ? 'textbox' : null, 'aria-multiline': editable ? 'true' : null,
    'aria-label': editable ? placeholder : null });
  const note = el('p', { class: 'slot-hint', hidden: true });
  const currentText = () => {
    const raw = getPath(ed, rawPath);
    return raw && raw.trim() ? raw : (getPath(ed, path) || []).map(LINES[kind].format).join('\n');
  };
  const display = text => text.split('\n').filter(l => l.trim()).map(l => {
    if (kind === 'images') { const u = LINES.images.parse(l); return u ? `![](${u})\n` : l; }
    return /^\s*[-*]\s+/.test(l) ? l : `- ${l}`;
  }).join('\n');
  const show = () => { const t = currentText(); s.innerHTML = t ? mdToHtml(display(t)) : ''; };
  const sync = text => {
    // Keep each understood line in its tidied form (e.g. a bare link becomes "[Title](link)"),
    // and anything not understood exactly as typed, so the box shows what will be used.
    const parsed = [], bad = [], shown = [];
    for (const line of text.split('\n').map(l => l.trim()).filter(Boolean)) {
      const v = LINES[kind].parse(line);
      if (v === undefined || v === null) { bad.push(line.slice(0, 40)); shown.push(line); }
      else { parsed.push(v); shown.push(LINES[kind].format(v)); }
    }
    setPath(ed, rawPath, shown.join('\n'));
    setPath(ed, path, parsed);
    note.hidden = !bad.length;
    note.textContent = bad.length ? `Not understood: “${bad.join('”, “')}”. ${kind === 'comments' ? 'Use “comment” — @username' : kind === 'images' ? 'Paste the image address' : ''}` : '';
  };
  show();
  if (!editable) return s;
  s.addEventListener('input', () => { sync(htmlToMd(s.innerHTML)); changed(); });
  s.addEventListener('blur', show);
  const take = (html, text) => {
    skippedImages = 0;
    let pasted = html ? htmlToMd(html) : (text || '').trim();
    if (kind === 'links') pasted = pasted.split('\n').filter(l => l.trim()).join('\n');
    const existing = currentText();
    sync(existing ? `${existing}\n${pasted}` : pasted);
    show();
    report(html, pasted);
    changed();
  };
  s.addEventListener('paste', e => {
    e.preventDefault();
    take(e.clipboardData.getData('text/html'), e.clipboardData.getData('text/plain'));
  });
  return el('div', {}, beside(s, pasteButton('Paste', take, `Paste: ${placeholder}`)), note);
}

// A link attached to a title: a small chip that turns into an input when clicked.
function linkChip(path, titleEl, emptyLabel = 'Add the link to the thread') {
  const editable = EDIT;
  if (titleEl && !titleEl.matches('.slot, .missing')) titleEl = titleEl.querySelector('.slot');
  const wrap = el('div', { class: 'chip-wrap' });
  const draw = () => {
    const url = String(getPath(ed, path) ?? '');
    titleEl?.classList.toggle('linked', !!url);
    wrap.innerHTML = '';
    if (!editable) return;
    // Under a title, the title box takes the link (paste it there), so only show the link once there is one.
    if (!url && titleEl) return;
    const edit = () => {
        const inp = el('input', { class: 'link-input', type: 'url', placeholder: 'Paste the link…', 'aria-label': 'Thread link', value: url });
        const save = () => { setPath(ed, path, inp.value.trim()); draw(); changed(); };
        inp.addEventListener('blur', save);
        inp.addEventListener('keydown', e => {
          if (e.key === 'Enter') { e.preventDefault(); inp.blur(); }
          if (e.key === 'Escape') { inp.value = url; inp.blur(); }
        });
        inp.addEventListener('paste', e => {
          // A link copied as rich text: keep just its address.
          const h = e.clipboardData.getData('text/html');
          const t = e.clipboardData.getData('text/plain').trim();
          if (/^https?:\/\//.test(t) || !h) return;
          const a = new DOMParser().parseFromString(h, 'text/html').querySelector('a[href]');
          if (a) { e.preventDefault(); inp.value = absUrl(a.getAttribute('href')); }
        });
        wrap.replaceChildren(inp);
        inp.focus();
        inp.select();
    };
    // A clear button: "+ Add the link to the thread", or "Link: community… [Change link]".
    const button = el('button', { class: `link-chip ${url ? '' : 'empty'}`, type: 'button', 'data-path': path, onclick: edit },
      url ? 'Change link' : `+ ${emptyLabel}`);
    if (url) {
      wrap.append(el('span', { class: 'link-label' }, 'Link:'),
        el('a', { class: 'link-url', href: url, target: '_blank', rel: 'noopener', title: url }, url.replace(/^https?:\/\/(www\.)?/, '')),
        button);
    } else {
      wrap.append(button, pasteButton('Paste', (html, text) => {
        const link = linkFrom(html, text);
        if (!link) return toast('That isn’t a link. Copy the address first, then press Paste.');
        setPath(ed, path, link);
        changed();
        renderAll();
      }, `Paste: ${emptyLabel}`));
    }
  };
  draw();
  return wrap;
}

// The same community thread, however its link was copied (with or without a post number or query).
function threadKey(url) {
  const u = String(url || '').trim();
  const d = /community\.giffgaff\.com\/d\/(\d+)/i.exec(u);
  return d ? `d${d[1]}` : u.replace(/[?#].*$/, '').replace(/\/+$/, '').toLowerCase();
}

// Under the buzzing list: a thread that's already a story, or listed twice, with a button to take it out.
function renderDupHint() {
  const box = document.getElementById('dup-hint');
  if (!box) return;
  box.innerHTML = '';
  const h = ed.happenings || {};
  const stories = new Map((h.stories || []).map((st, i) => [threadKey(st.link), i]).filter(([key]) => key));
  const seen = new Set();
  (h.buzzing || []).forEach((b, i) => {
    const key = threadKey(b.link);
    if (!key) return;
    const name = `“${(b.title || '').slice(0, 50)}${(b.title || '').length > 50 ? '…' : ''}”`;
    const why = stories.has(key) ? `${name} is already Story ${stories.get(key) + 1} in Happenings.`
      : seen.has(key) ? `${name} is in the buzzing list twice.` : null;
    seen.add(key);
    if (!why) return;
    box.append(el('p', { class: 'slot-hint dup' }, why, ' ',
      el('button', { type: 'button', class: 'linkish', onclick: () => undoable('Taken out of the buzzing list.', () => {
        h.buzzing.splice(i, 1);
        delete h._raw_buzzing;
      }) }, 'Take it out of the buzzing list')));
  });
}

function report(html, md) {
  const links = (md.match(/\]\(|(^|\s)https?:\/\//g) || []).length;
  const mentions = (md.match(/(^|[^\w@])@\w/g) || []).length;
  const bits = [];
  if (links) bits.push(`kept ${links} link${links > 1 ? 's' : ''}`);
  if (mentions) bits.push(`${mentions} mention${mentions > 1 ? 's' : ''}`);
  if (/docs-internal-guid|font-weight:\s*normal/i.test(html || '')) bits.push('removed hidden Google Docs bold');
  if (skippedImages) bits.push(`left out ${skippedImages} embedded image${skippedImages > 1 ? 's' : ''} – paste the image address instead`);
  toast(`Pasted and tidied${bits.length ? ': ' + bits.join(', ') : ''}.`);
}

/* ------------------------------------------------------------------ */
/* Drawing the post                                                    */
/* ------------------------------------------------------------------ */

const fixed = (tag, props, ...kids) => el(tag, { ...props, class: `fixed ${props?.class || ''}`, title: 'Added for you' }, ...kids);
const profile = u => `${COMMUNITY}/u/${u}`;

function sectionState(k) {
  if (PART) return k === PART ? 'current' : 'hidden';
  if (active === 'review') return isSkipped(k) ? 'skipped' : 'done';
  if (k === active) return 'current';
  if (isSkipped(k)) return 'skipped';
  if (ed._done?.[k]) return 'done';
  return 'upcoming';
}

function renderAll({ scroll = false } = {}) {
  const y = $('#scroll').scrollTop;
  if (PART) {
    renderPartBar();
    renderPartCanvas();
    renderRail();
    applyProblems();
    if (!scroll) $('#scroll').scrollTop = y;
    return;
  }
  renderViewSwitch();
  if (PREVIEW) {
    renderPreview();
    renderRail();
    return;
  }
  renderReview();
  renderCanvas();
  renderRail();
  applyProblems();
  renderDupHint();
  renderDue();
  if (scroll) scrollToActive(); else $('#scroll').scrollTop = y;
}

// Under the title: when this gaff goes out, and how many sections are left.
function renderDue() {
  const box = $('#due-line');
  if (!box) return;
  const t = Gaff.parseDate(ed.date);
  if (t === null) { box.hidden = true; return; }
  const days = Math.round((t - Gaff.todayUTC()) / Gaff.DAY);
  const left = STEPS.filter(s => !finished(s.key)).length;
  const when = days === 0 ? 'Posts today' : days === 1 ? 'Posts tomorrow' : days > 1 ? `Posts Friday · ${days} days to go`
    : `Was due ${-days} day${days === -1 ? '' : 's'} ago`;
  box.hidden = false;
  box.className = `due-line ${left && days <= 1 ? 'soon' : ''}`;
  box.replaceChildren(el('span', { class: 'due-pill' }, when),
    el('span', { class: 'due-left' }, left ? `${left} section${left === 1 ? '' : 's'} still to do` : 'Everything’s ticked off'));
}

// "See it as members will": the post exactly as the community shows it, with no boxes or buttons.
let PREVIEW = false;
function renderViewSwitch() {
  const sw = $('#view-switch');
  if (!sw) return;
  sw.innerHTML = '';
  const opt = (on, label) => el('button', { type: 'button', class: `view-opt ${PREVIEW === on ? 'on' : ''}`, 'aria-pressed': String(PREVIEW === on),
    onclick: () => { if (PREVIEW !== on) { PREVIEW = on; renderAll(); $('#scroll').scrollTop = 0; } } }, label);
  sw.append(opt(false, 'Edit'), opt(true, 'See it as members will'));
}
function renderPreview() {
  $('#review').innerHTML = '';
  const c = $('#canvas');
  c.classList.add('as-members');
  c.innerHTML = mdToHtml(lastRender?.markdown || '');
}

// Bring the step you're on into view. The header and Review sit right under the page title,
// so for those go to the top instead, keeping the title in sight.
// A gaff just opened: start at the top, with the page title in view.
function renderFromTop() {
  renderAll();
  $('#scroll').scrollTop = 0;
}

function scrollToActive() {
  if (active === 'header' || active === 'review') return $('#scroll').scrollTo({ top: 0, behavior: SMOOTH });
  document.getElementById(`sec-${active}`)?.scrollIntoView({ behavior: SMOOTH, block: 'start' });
}

function headerParts() {
  const md = lastRender?.parts?.[0]?.markdown || '';
  const m = md.match(/\*\*(.+? \/ Issue #[^*]+)\*\*/);
  const foot = lastRender?.parts?.at(-1)?.markdown || '';
  const n = foot.match(/Next Edition \(([^)]+)\)/);
  return { dateLine: m ? m[1] : '…', next: n ? n[1] : '…' };
}

function renderCanvas() {
  const c = $('#canvas');
  c.classList.remove('as-members');
  c.innerHTML = '';
  const { dateLine, next } = headerParts();

  // Header
  EDIT = active === 'header';
  const head = el('section', { class: `sec ${sectionState('header')}`, id: 'sec-header' });
  head.append(fixed('p', {}, el('img', { src: META.images.banner, alt: 'The gaff banner' })));
  const dateP = fixed('p', { id: 'date-line' }, el('strong', {}, dateLine));
  // Everything worked out and nothing missing: one line with a tick, and "Looks right, continue".
  const compact = EDIT && !headerOpen && !sectionProblems('header').length;
  head.append(EDIT && !compact ? dateP : titleRow(dateP, compact ? null : statePill('header')));
  if (compact) {
    const prev = ed.previous_edition;
    head.append(el('div', { class: 'header-summary' },
      el('span', { class: 'fold-tick', 'aria-hidden': 'true' }, '✓'),
      el('p', {}, 'Last week’s gaff: ',
        el('a', { href: prev, target: '_blank', rel: 'noopener' }, Gaff.titleFromLink(prev).replace(/^The Gaff (.+)$/, 'The gaff - $1'), el('span', { class: 'sr-only' }, ' (opens in a new tab)'))),
      el('button', { type: 'button', class: 'item-btn', 'aria-label': 'Change the date, issue number or links',
        onclick: () => { headerOpen = true; renderAll(); } }, 'Change')));
    const bar = actionsBar('header');
    bar.querySelector('#mark-header').textContent = 'Looks right, continue →';
    head.append(bar);
  } else if (EDIT) {
    // The header step is a few plain questions, each with a short explanation.
    const autoIssue = (dateLine.match(/Issue #(\S+)/) || [])[1] || '';
    head.append(el('div', { class: 'questions' },
      el('div', { class: 'q-row' },
        question('Which Friday is this gaff for?', null,
          el('input', { type: 'date', value: ed.date || '', oninput: e => { ed.date = e.target.value; changed(); } })),
        question('Issue number', null, el('div', {},
          el('input', { type: 'text', inputmode: 'numeric', class: 'short', placeholder: autoIssue === '?' ? '' : autoIssue,
            value: ed.issue || '', oninput: e => { ed.issue = e.target.value.trim(); changed(); } }),
          el('p', { class: 'q-help after' }, 'Worked out for you. Only change it if it’s wrong.')))),
      question('Link to last week’s gaff', [gaffListLink(), ' and click last week’s. Copy the web address from the top of your browser and paste it here.'],
        linkInput('previous_edition', 'Paste the link here')),
      question('Link to this gaff, once it’s posted (you can add this later)', 'Next week’s gaff uses it for its “Previous Edition” link.',
        linkInput('posted_url', 'Paste the link here after posting'))));
    head.append(actionsBar('header'));
  }
  c.append(head);

  // Standard sections
  for (const s of STEPS.slice(1, 5)) c.append(renderSection(s));

  // Extra sections, then a placeholder to add more
  c.append(renderExtras());

  // A numbered circle outside the post beside each section: ✓ done, – skipped, ! needs a look.
  if (!PART) {
    STEPS.forEach((st, i) => {
      const sec = document.getElementById(`sec-${st.key}`);
      if (!sec) return;
      const state = sectionState(st.key) === 'current' ? 'current' : { todo: 'upcoming' }[stepStatus(st.key)] || stepStatus(st.key);
      const mark = { done: '✓', skipped: '–', warn: '!' }[state] || String(i + 1);
      sec.prepend(el('span', { class: `sec-num ${state}`, 'aria-hidden': 'true' }, mark));
    });
  }

  // Footer
  EDIT = false;
  const prev = ed.previous_edition;
  c.append(fixed('hr', {}), fixed('h2', {}, 'Thanks for reading!'),
    fixed('p', {}, prev ? el('a', { href: prev, target: '_blank', rel: 'noopener' }, 'Previous Edition') : el('span', { class: 'missing' }, 'Previous Edition (link needed)'), ` | Next Edition (${next})`));
}

// A plain question: bold label, one line of help, then the box to fill in.
let headerOpen = false;   // the Header's questions, opened with "Change"
let questionCount = 0;
function question(label, help, control) {
  const id = `q-${++questionCount}`;
  const box = control.matches?.('input, [contenteditable]') ? control : control.querySelector('input, [contenteditable]');
  const after = control.querySelector?.('.q-help.after');
  if (after) after.id = `${id}-help`;
  if (box) {
    box.setAttribute('aria-labelledby', `${id}-label`);
    box.removeAttribute('aria-label');
    if (help || after) box.setAttribute('aria-describedby', `${id}-help`);
  }
  return el('div', { class: 'q' },
    el('div', { class: 'q-label', id: `${id}-label` }, label),
    help && el('p', { class: 'q-help', id: `${id}-help` }, help),
    control);
}

// Every gaff on the community, newest first: the quickest way to find last week's.
const GAFF_LIST = `${COMMUNITY}/all?sort=newest&q=the%20gaff`;
const gaffListLink = (text = 'Open the list of gaffs on the community') =>
  el('a', { href: GAFF_LIST, target: '_blank', rel: 'noopener' }, text, el('span', { class: 'sr-only' }, ' (opens in a new tab)'));

// An always-visible box for a link (easier than a chip for one-off links like these):
// a Paste button beside it while it's empty, then "Open ↗" to check it's the right page.
function linkInput(path, placeholder) {
  const inp = el('input', { type: 'url', class: 'link-box', 'data-path': path, placeholder, value: String(getPath(ed, path) ?? '') });
  const open = el('a', { class: 'open-link', target: '_blank', rel: 'noopener' }, 'Open ↗', el('span', { class: 'sr-only' }, ' (opens in a new tab)'));
  const paste = pasteButton('Paste', (html, text) => {
    const url = linkFrom(html, text);
    if (!url) return toast('That isn’t a link. Copy the web address from the top of the browser, then press Paste.');
    inp.value = url;
    inp.dispatchEvent(new Event('input'));
  }, `Paste: ${placeholder}`);
  const showOpen = () => {
    const ok = /^https?:\/\/\S+$/.test(inp.value.trim());
    open.hidden = !ok;
    paste.hidden = !!inp.value.trim();
    if (ok) open.href = inp.value.trim();
  };
  showOpen();
  inp.addEventListener('input', () => { setPath(ed, path, inp.value.trim()); showOpen(); changed(); });
  inp.addEventListener('paste', e => {
    // A link copied as rich text: keep just its address.
    const h = e.clipboardData.getData('text/html');
    const t = e.clipboardData.getData('text/plain').trim();
    if (/^https?:\/\//.test(t) || !h) return;
    const a = new DOMParser().parseFromString(h, 'text/html').querySelector('a[href]');
    if (a) { e.preventDefault(); inp.value = absUrl(a.getAttribute('href')); inp.dispatchEvent(new Event('input')); }
  });
  return el('div', { class: 'link-row' }, inp, paste, open);
}

// Where a section stands, shown on its heading line: "✓ Done [Edit]", "Skipped this week [Include it]"…
function statePill(k) {
  if (PART || active === 'review') return null;
  const st = sectionState(k);
  const filled = k === 'header' || (k === 'extras' ? (ed.sections || []).some(hasContent) : hasContent(ed[k]));
  const cfg = {
    done: ['✓ Done', 'Edit'],
    upcoming: filled ? ['Not ticked yet', 'Open'] : ['Not started yet', 'Start it now'],
  }[st];
  if (!cfg) return null;
  return el('div', { class: `sec-status ${st}` },
    el('span', { class: 'sec-status-text' }, cfg[0]),
    el('button', { type: 'button', class: 'status-btn', 'aria-label': `${cfg[1]}: ${STEP_BY[k].label}`, onclick: () => openStep(k) }, cfg[1]));
}

const titleRow = (heading, status) => el('div', { class: 'sec-title-row' }, heading, status);

// A small text box straight after "by @", sized to the name.
function authorInput(path, value) {
  const inp = el('input', { type: 'text', class: 'author-box', 'data-path': path, value: String(value || '').replace(/^@/, ''),
    placeholder: 'name', 'aria-label': 'Written by', spellcheck: 'false' });
  const fit = () => { inp.size = Math.max(9, inp.value.length + 1); };
  fit();
  const put = name => { inp.value = name; inp.dispatchEvent(new Event('input')); inp.dispatchEvent(new Event('change')); };
  const btn = pasteButton('Paste', (html, text) => put(pastedUsername(text, html) || text.trim().replace(/^@/, '')), 'Paste who wrote it');
  btn.hidden = !!inp.value.trim();
  inp.addEventListener('input', () => { setPath(ed, path, inp.value.replace(/^@/, '').trim()); fit(); btn.hidden = !!inp.value.trim(); changed(); });
  inp.addEventListener('paste', e => {
    const name = pastedUsername(e.clipboardData.getData('text/plain'), e.clipboardData.getData('text/html'));
    if (name) { e.preventDefault(); put(name); }
  });
  inp.addEventListener('change', () => renderAll());   // e.g. the giffgaffiversary closing line names the author
  return [inp, btn];
}

function byLine(k) {
  const author = ed[k]?.author || META.authors[k] || '';
  if (EDIT) return el('p', { class: 'byline by-line' }, el('em', {}, 'by @'), authorInput(`${k}.author`, author));
  return fixed('p', { class: 'byline' }, el('em', {}, 'by ', el('a', { href: profile(author), target: '_blank', rel: 'noopener' }, '@' + author)));
}

function renderSection(s) {
  const k = s.key;
  ed[k] = ed[k] || {};
  const d = ed[k];
  const st = sectionState(k);
  EDIT = st === 'current';
  if (st === 'upcoming' && !hasContent(d)) return todoCard(s);
  if (st === 'skipped') return skippedCard(s);
  // An open section always shows at least one empty item, so its placeholders are visible straight away.
  if (EDIT && s.list && !(d[s.list] || []).length) d[s.list] = [{}];
  const box = el('section', { class: `sec ${st}`, id: `sec-${k}` }, fixed('hr', {}),
    titleRow(fixed('h2', {}, d.title || s.title), statePill(k)), byLine(k), EDIT && findLink(k), fromNote(k));

  if (k === 'happenings') {
    (d.stories ||= []).forEach((it, i) => {
      if (hideItem(k, 'stories', i)) return;
      const t = textSlot(`happenings.stories.${i}.title`, 'Story title (or paste the link to the thread)', { cls: 'title-slot bold', linkable: true, paste: true });
      box.append(itemCard(k, 'stories', i, t, linkChip(`happenings.stories.${i}.link`, t),
        mdSlot(`happenings.stories.${i}.quote`, 'Paste the post here, straight from the community or Google Docs', { tag: 'blockquote' })));
    });
    if (EDIT) box.append(addButton(k, 'stories', '+ Add another story', {}));
    if (EDIT || (d.buzzing || []).length) {
      box.append(fixed('p', {}, el('strong', {}, 'See what’s been buzzing on our Community this week:')),
                 linesSlot(k, 'buzzing', 'links', 'Paste links to this week’s busy threads, one per line. Each title is worked out from its link, and you can click it to edit.'),
                 EDIT && el('div', { id: 'dup-hint' }));
    }
  }

  if (k === 'say_hello') {
    box.append(fixed('p', {}, el('img', { src: META.images.say_hello, alt: 'Say Hello picture' })),
               mdSlot('say_hello.intro', '', { defaultText: META.defaults.say_hello_intro }));
    let picked = false;
    (d.members ||= []).forEach((it, i) => {
      if (hideItem(k, 'members', i)) return;
      if (EDIT && !it.avatar) { it.avatar = randomAvatar(d.members[i - 1]?.avatar); picked = true; }
      const t = textSlot(`say_hello.members.${i}.title`, 'Their intro thread title (or paste the link to it)', { cls: 'title-slot', linkable: true, paste: true });
      box.append(itemCard(k, 'members', i, avatarView(it.avatar), t,
        linkChip(`say_hello.members.${i}.link`, t),
        textSlot(`say_hello.members.${i}.greeting`, 'Greeting, e.g. Hiya and welcome to the community @username', { cls: 'greeting' }),
        mdSlot(`say_hello.members.${i}.quote`, 'Paste their post here', { tag: 'blockquote' })));
    });
    if (picked) changed();   // keep the randomly picked avatars with the draft
    if (EDIT) box.append(addButton(k, 'members', '+ Add another new member', {}));
    box.append(mdSlot('say_hello.outro', '', { defaultText: META.defaults.say_hello_outro }));
  }

  if (k === 'giffgaffiversary') {
    box.append(fixed('p', {}, el('img', { src: META.images.giffgaffiversary, alt: 'giffgaffiversary picture' })),
               mdSlot('giffgaffiversary.intro', '', { defaultText: META.defaults.giffgaffiversary_intro }));
    (d.posts ||= []).forEach((it, i) => {
      if (hideItem(k, 'posts', i)) return;
      const t = textSlot(`giffgaffiversary.posts.${i}.title`, 'Their anniversary thread title (or paste the link to it)', { cls: 'title-slot', linkable: true, paste: true });
      box.append(itemCard(k, 'posts', i, t, linkChip(`giffgaffiversary.posts.${i}.link`, t),
        textSlot(`giffgaffiversary.posts.${i}.greeting`, 'Greeting, e.g. Congratulations @username!', { cls: 'greeting' }),
        mdSlot(`giffgaffiversary.posts.${i}.quote`, 'Paste their post here', { tag: 'blockquote' })));
    });
    if (EDIT) box.append(addButton(k, 'posts', '+ Add another anniversary', {}));
    const author = d.author || META.authors.giffgaffiversary;
    box.append(fixed('p', {}, el('strong', {}, `If it’s YOUR giffgaffiversary, please let the team know by sending a private message to `,
      el('a', { class: 'mention', href: profile(author), target: '_blank', rel: 'noopener' }, '@' + author))));
  }

  if (k === 'photo_of_the_week') {
    box.append(fixed('p', {}, el('img', { src: META.images.photo_of_the_week, alt: 'Photo of the Week banner' })));
    const title = textSlot('photo_of_the_week.photo_title', 'paste the photo thread link', {
      cls: 'inline-slot bold', tag: 'span', linkable: true, linkPath: 'photo_of_the_week.link' })
      || el('span', { class: 'missing' }, 'photo title');
    const byName = String(d.by || '').replace(/^@/, '');
    const whoSlot = EDIT && textSlot('photo_of_the_week.by', 'who took it', { cls: 'inline-slot', tag: 'span', strip: '@', userLink: true });
    const by = EDIT
      ? [el('span', { class: 'fixed' }, ' by @'), whoSlot]
      : [' by ', byName ? el('a', { class: 'mention', href: profile(byName), target: '_blank', rel: 'noopener' }, '@' + byName) : el('span', { class: 'missing' }, '@username')];
    box.append(el('p', {}, el('span', { class: 'fixed' }, 'This week’s featured photo is '), title, ...by));
    if (EDIT && (!d.photo_title || !byName)) {
      box.append(el('div', { class: 'paste-row' },
        !d.photo_title && pasteButton('Paste the photo link', title.pasteInto),
        !byName && pasteButton('Paste who took it', whoSlot.pasteInto)));
    }
    box.append(linkChip('photo_of_the_week.link', title, 'Add the photo thread link'));
    if (EDIT || (d.comments || []).length) {
      box.append(fixed('p', {}, el('strong', {}, 'See what fellow members are saying:')),
                 linesSlot(k, 'comments', 'comments', 'Paste comments, one per line:  “comment” — @username'));
    }
    const imgs = linesSlot(k, 'images', 'images', 'Right-click the photo on the community, choose “Copy image address”, and paste it here');
    if (imgs) box.append(EDIT ? el('p', { class: 'slot-label' }, 'The photo') : null, imgs);
    const outro = mdSlot('photo_of_the_week.outro', 'A few words to finish the section');
    if (outro) box.append(EDIT ? el('p', { class: 'slot-label' }, 'Closing words (optional)') : null, outro);
  }

  if (EDIT) box.append(actionsBar(k));
  return box;
}

// Where to find this section's posts on the community, newest first, in a new tab.
const FIND = {
  say_hello: { url: `${COMMUNITY}/t/welcome-and-join?sort=newest`, text: 'Find new members’ intro posts on the community' },
};
function findLink(k) {
  const f = FIND[k];
  return f && el('p', { class: 'find-link' },
    el('a', { href: f.url, target: '_blank', rel: 'noopener' }, f.text, ' ↗', el('span', { class: 'sr-only' }, ' (opens in a new tab)')));
}

// A section nobody has started yet: what it's for, who writes it, and one obvious button.
function todoCard(s) {
  const k = s.key;
  const author = ed[k]?.author || META.authors[k] || '';
  return el('section', { class: 'sec upcoming todo', id: `sec-${k}` },
    el('div', { class: 'todo-card' },
      el('h2', {}, ed[k]?.title || s.title),
      el('p', { class: 'todo-about' }, author && ['by ', el('a', { href: profile(author), target: '_blank', rel: 'noopener' }, '@' + author), ' · '], s.about),
      el('div', { class: 'todo-actions' },
        el('button', { class: 'btn primary big', type: 'button', 'aria-label': `Start ${s.label}`, onclick: () => openStep(k) }, `Start ${s.label} →`),
        s.toggle && el('button', { class: 'btn big', type: 'button', 'aria-label': `Skip ${s.label} this week`, onclick: () => skip(k) }, 'Skip this week'))));
}

// A skipped section: grey stripes, a "Skipped this week" badge and the title crossed out, so it's
// obvious at a glance that it won't be in the gaff.
function skippedCard(s) {
  const k = s.key;
  return el('section', { class: 'sec skipped skipped-card', id: `sec-${k}` },
    el('div', { class: 'skip-card' },
      el('div', { class: 'skip-text' },
        el('span', { class: 'skip-badge' }, el('span', { 'aria-hidden': 'true' }, '⊘ '), 'Skipped this week'),
        el('h2', {}, el('s', {}, ed[k]?.title || s.title)),
        el('p', { class: 'skip-note' }, 'Won’t be in this week’s gaff.')),
      el('button', { class: 'btn big', type: 'button', 'aria-label': `Include ${s.label} after all`, onclick: () => openStep(k) }, 'Include it after all')));
}

function renderExtras() {
  const st = sectionState('extras');
  EDIT = st === 'current';
  const wrap = el('div', { class: `sec extras-wrap ${st}`, id: 'sec-extras' });
  const list = (ed.sections ||= []);
  if (!EDIT && list.some(hasContent) && active !== 'review') {
    wrap.append(titleRow(el('span', { class: 'extras-label' }, 'Extra sections'), statePill('extras')));
  }
  const note = fromNote('extras');
  if (note) wrap.append(note);
  list.forEach((sec, i) => {
    if (!EDIT && !hasContent(sec)) return;
    const box = el('div', { class: 'item extra' });
    if (EDIT) box.append(itemTools('sections', i, list));
    const title = textSlot(`sections.${i}.title`, 'Section title, e.g. Tech News', { cls: 'inline-slot', tag: 'span' });
    box.append(fixed('hr', {}), el('h2', {}, title || '(untitled section)'));
    if (EDIT) box.append(el('p', { class: 'byline by-line' }, el('em', {}, 'by @'), authorInput(`sections.${i}.author`, sec.author)));
    else if (sec.author) box.append(fixed('p', { class: 'byline' }, el('em', {}, 'by ', el('a', { href: profile(String(sec.author).replace(/^@/, '')), target: '_blank', rel: 'noopener' }, '@' + String(sec.author).replace(/^@/, '')))));
    if (EDIT) box.append(linkChip(`sections.${i}.image`, null, 'Add a picture at the top (optional)'));
    if (sec.image) box.append(fixed('p', {}, el('img', { src: sec.image, alt: 'Section picture' })));
    const body = mdSlot(`sections.${i}.body`, 'Paste or write the section here');
    if (body) box.append(body);
    wrap.append(box);
  });
  if (EDIT) {
    wrap.append(addSectionPlaceholder(list.length ? 'Add another section' : 'Add a section here (e.g. Tech News)'));
    wrap.append(actionsBar('extras'));
  } else if (active !== 'review') {
    // Placeholder visible from any step: jump to Extras and add one.
    wrap.append(addSectionPlaceholder(list.length ? 'Add another section' : 'Add a section here (e.g. Tech News)', true));
  }
  return wrap;
}

function addSectionPlaceholder(label, jump = false) {
  return el('button', { class: 'add-section', type: 'button', onclick: () => {
    (ed.sections ||= []).push({ title: '', author: '', body: '' });
    if (!PART && (jump || active !== 'extras')) { delete (ed._done ||= {}).extras; active = 'extras'; }
    changed();
    renderAll();
    const i = ed.sections.length - 1;
    const t = document.querySelector(`[data-path="sections.${i}.title"]`);
    t?.scrollIntoView({ behavior: SMOOTH, block: 'center' });
    t?.focus();
  } }, el('span', { class: 'plus' }, '+'), el('span', {}, label), el('small', {}, 'Goes after Photo of the Week, with its own title, author and body'));
}

// An empty item is only shown when it's the only one, or you've just added it.
function hideItem(k, listKey, i) {
  const list = ed[k][listKey];
  if (hasContent(list[i])) return false;
  return !EDIT || (list.some(hasContent) && !openItems.has(`${k}.${listKey}.${i}`));
}

const ITEM_LABELS = { stories: 'Story', members: 'New member', posts: 'Anniversary', sections: 'Section' };

// Finished items fold to one line so a long story doesn't fill the page; Edit opens one again.
// An item you've clicked into stays open while you're on that step.
const openItems = new Set();
const BODY = { stories: 'quote', members: 'quote', posts: 'quote' };

function foldable(k, listKey, i) {
  const it = ed[k][listKey][i] || {};
  const body = String(it[BODY[listKey]] || '');
  if (!String(it.title || '').trim() || !body.trim() || openItems.has(`${k}.${listKey}.${i}`)) return false;
  const prefix = `${k}.${listKey}.${i}.`;
  if ((lastRender?.warnings || []).some(w => (warningPath(w) || '').startsWith(prefix))) return false;
  return !Gaff.unclosedBold(body).length && !/!\[[^\]]*\]\(\s*(data|blob):/.test(body);
}

function itemCard(k, listKey, i, ...kids) {
  if (EDIT && foldable(k, listKey, i)) return foldedItem(k, listKey, i);
  const card = el('div', { class: 'item' });
  if (EDIT) {
    card.append(itemTools(listKey, i, ed[k][listKey]));
    card.addEventListener('focusin', () => openItems.add(`${k}.${listKey}.${i}`));
  }
  card.append(...kids.filter(Boolean));
  return card;
}

function foldedItem(k, listKey, i) {
  const list = ed[k][listKey];
  const it = list[i];
  const name = `${ITEM_LABELS[listKey]} ${i + 1}`;
  const paras = String(it[BODY[listKey]]).split(/\n\s*\n/).filter(x => x.trim()).length;
  const facts = [`${paras} paragraph${paras === 1 ? '' : 's'}`, it.link ? 'link added' : 'no link'];
  const edit = () => {
    openItems.add(`${k}.${listKey}.${i}`);
    renderAll();
    document.querySelector(`[data-path="${k}.${listKey}.${i}.title"]`)?.focus();
  };
  return el('div', { class: 'item folded' },
    el('span', { class: 'fold-tick', 'aria-hidden': 'true' }, '✓'),
    el('div', { class: 'fold-text' },
      el('h3', { class: 'fold-title' }, el('span', { class: 'sr-only' }, `${name}: `), it.title),
      el('span', { class: 'fold-facts' }, facts.join(' · '))),
    el('div', { class: 'item-tools' },
      el('button', { type: 'button', class: 'item-btn', 'aria-label': `Edit ${name.toLowerCase()}`, onclick: edit }, 'Edit'),
      el('button', { type: 'button', class: 'item-btn', 'aria-label': `Remove ${name.toLowerCase()}`,
        onclick: () => undoable(`${name} removed.`, () => list.splice(i, 1)) }, 'Remove')));
}

// "Story 2" heading with plain Move up / Move down / Remove buttons.
function itemTools(listKey, i, list) {
  const name = ITEM_LABELS[listKey] || 'Item';
  const btn = (label, fn, disabled) => el('button', { type: 'button', class: 'item-btn', disabled,
    'aria-label': `${label} ${name.toLowerCase()} ${i + 1}`, onclick: () => { fn(); changed(); renderAll(); } }, label);
  const tools = el('div', { class: 'item-tools' });
  if (list.length > 1) {
    tools.append(btn('Move up', () => list.splice(i - 1, 0, list.splice(i, 1)[0]), i === 0),
                 btn('Move down', () => list.splice(i + 1, 0, list.splice(i, 1)[0]), i === list.length - 1));
  }
  tools.append(el('button', { type: 'button', class: 'item-btn', 'aria-label': `Remove ${name.toLowerCase()} ${i + 1}`,
    onclick: () => (hasContent(list[i]) ? undoable(`${name} ${i + 1} removed.`, () => list.splice(i, 1)) : (list.splice(i, 1), changed(), renderAll())) }, 'Remove'));
  return el('div', { class: 'item-head' }, el('h3', { class: 'item-name' }, `${name} ${i + 1}`), tools);
}

function addButton(k, listKey, label, blank) {
  return el('button', { class: 'add-btn', type: 'button', onclick: () => {
    (ed[k][listKey] ||= []).push({ ...blank });
    const i = ed[k][listKey].length - 1;
    openItems.add(`${k}.${listKey}.${i}`);
    changed();
    renderAll();
    const first = document.querySelector(`[data-path^="${k}.${listKey}.${i}."].text-slot`);
    first?.focus();
  } }, label);
}

// Each new member gets a stock avatar at random, different from the member above where possible.
function randomAvatar(avoid) {
  const ids = Object.keys(META.avatars).map(Number);
  const pool = ids.filter(n => n !== Number(avoid));
  const from = pool.length ? pool : ids;
  return from[Math.floor(Math.random() * from.length)];
}

// The member's avatar, shown as it will appear in the post (decorative, so no alt text).
function avatarView(value) {
  const src = META.avatars[String(value)] || (/^https?:\/\//.test(String(value || '')) ? String(value) : null);
  return src ? el('div', { class: 'avatar-pick' }, el('span', { class: 'avatar-pic' }, el('img', { src, alt: '' }))) : null;
}

function actionsBar(k) {
  const s = STEP_BY[k];
  const problems = el('div', { class: 'problems', id: `problems-${k}` });
  if (PART) {
    return el('div', { class: 'sec-actions' }, problems,
      el('button', { class: 'btn primary', type: 'button', onclick: sendPart }, 'Send my part →'));
  }
  return el('div', { class: 'sec-actions' }, problems,
    el('button', { class: 'btn primary big', type: 'button', id: `mark-${k}`, onclick: () => markDone(k) }, markLabel(k)),
    s.toggle && el('button', { class: 'btn big', type: 'button', onclick: () => skip(k) }, 'Skip this week'));
}

function markLabel(k) {
  if (k === 'extras' && !(ed.sections || []).some(hasContent)) return 'No extras – continue →';
  return `Mark ${STEP_BY[k].label} done & continue →`;
}

/* ------------------------------------------------------------------ */
/* Sending parts: a contributor writes one section and sends it to the */
/* editor as a small file or link; the editor adds it to the edition.  */
/* ------------------------------------------------------------------ */

let PART = null;   // contributor mode: the one section being written (from ?part=...)
const PART_KEYS = ['happenings', 'say_hello', 'giffgaffiversary', 'photo_of_the_week', 'extras'];
const partStoreKey = k => `gaff.part.${k}`;
const siteUrl = () => `${location.origin}${location.pathname}`;

function fromNote(k) {
  const f = ed._from?.[k];
  if (!f || PART) return null;
  const when = f.at ? new Date(f.at).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
  return el('p', { class: 'from-note' }, `Sent by @${f.from || 'someone'}${when ? ` · ${when}` : ''}. Check it, then tick it off.`);
}

function loadPart() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(partStoreKey(PART)) || 'null'); } catch { /* storage unavailable */ }
  if (saved && /^\d{4}-\d{2}-\d{2}$/.test(saved.date || '')) {
    ed = saved;
  } else {
    ed = { date: Gaff.isoDate(Gaff.nextFriday(Gaff.todayUTC())) };
    if (PART === 'extras') ed.sections = [];
    else ed[PART] = { author: META.authors[PART] || '' };
  }
  active = PART;
}

function savePartLocally() {
  try {
    localStorage.setItem(partStoreKey(PART), JSON.stringify(ed));
    markSaved();
  } catch {
    saveStatus('error', 'Not saved (browser storage unavailable)');
  }
}

function renderPartBar() {
  const nav = $('#tabs');
  nav.innerHTML = '';
  const pick = el('select', { 'aria-label': 'Which part', onchange: e => switchPart(e.target.value) },
    PART_KEYS.map(k => el('option', { value: k, selected: k === PART }, STEP_BY[k].label)));
  const date = el('input', { type: 'date', value: ed.date || '', 'aria-label': 'Edition date',
    oninput: e => { ed.date = e.target.value; changed(); } });
  nav.append(el('div', { class: 'part-bar' },
    el('span', {}, 'You’re writing '), pick, el('span', {}, ' for the gaff on '), date,
    el('span', { class: 'muted' }, ' When it’s ready, click Send my part and send the file or link to the editor.'),
    el('a', { href: siteUrl() }, 'Open the full editor')));
}

function renderPartCanvas() {
  const c = $('#canvas');
  c.innerHTML = '';
  EDIT = false;
  c.append(fixed('p', {}, el('img', { src: META.images.banner, alt: 'The gaff banner' })),
           fixed('p', { id: 'date-line' }, el('strong', {}, headerParts().dateLine)));
  c.append(PART === 'extras' ? renderExtras() : renderSection(STEP_BY[PART]));
}

async function switchPart(k) {
  PART = k;
  history.replaceState(null, '', `${siteUrl()}?part=${k}`);
  loadPart();
  await refresh();
  renderFromTop();
}

function partAuthor() {
  if (PART === 'extras') return (ed.sections || []).find(s => s.author)?.author || 'someone';
  return ed[PART]?.author || META.authors[PART] || 'someone';
}

function partPayload() {
  const data = PART === 'extras' ? { sections: (ed.sections || []).filter(hasContent) } : { ...ed[PART] };
  delete data.enabled;
  if (STEP_BY[PART]?.list) data[STEP_BY[PART].list] = (data[STEP_BY[PART].list] || []).filter(hasContent);
  return { type: 'gaff-part', version: 1, section: PART, date: ed.date, from: String(partAuthor()).replace(/^@/, ''), created: new Date().toISOString(), data };
}

// Part links carry the part itself after #part=, compressed where the browser can.
function b64url(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function unb64url(s) {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
  return Uint8Array.from(bin, c => c.charCodeAt(0));
}
async function encodePart(obj) {
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  if (typeof CompressionStream === 'undefined') return 'p' + b64url(bytes);
  const out = await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer();
  return 'z' + b64url(new Uint8Array(out));
}
async function decodePart(code) {
  const bytes = unb64url(code.slice(1));
  let data = bytes;
  if (code[0] === 'z') data = new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer());
  else if (code[0] !== 'p') throw new Error('That isn’t a gaff part link');
  return JSON.parse(new TextDecoder().decode(data));
}

async function sendPart() {
  attempted[PART] = true;
  await refresh();
  const probs = sectionProblems(PART);
  if (probs.length) return showBlocked(PART, probs, 'Not sent yet');
  const payload = partPayload();
  const link = `${siteUrl()}#part=${await encodePart(payload)}`;
  const label = STEP_BY[PART].label;
  const dlg = $('#done-dialog');
  const body = $('#done-body');
  body.innerHTML = `<h3 id="dialog-title">Your ${esc(label)} is ready to send</h3>
    <p>Copy the link and send it to the editor on Telegram or by email. When they open it, your part is added.
      Your work stays saved in this browser, so you can change it and send it again.</p>
    ${link.length > 4000 ? `<p class="part-error">This link is long (${link.length.toLocaleString()} characters). Some chat apps cut long messages, so email is safer.</p>` : ''}
    <div class="dialog-actions">
      <button class="btn">Close</button>
      <button type="button" class="btn primary" id="part-copy">Copy link</button>
    </div>`;
  $('#part-copy').onclick = e => copy(link, e.target, 'Link copied');
  dlg.showModal();
}

/* ---- editor side ---- */

function partSummary(p) {
  const label = STEP_BY[p.section]?.label || p.section;
  const list = STEP_BY[p.section]?.list;
  let what = '';
  if (p.section === 'extras') what = `${(p.data.sections || []).length} section(s)`;
  else if (list) { const n = (p.data[list] || []).length; what = `${n} ${STEP_BY[p.section].item}${n === 1 ? '' : 's'}`; }
  else if (p.section === 'photo_of_the_week') what = p.data.photo_title ? `“${p.data.photo_title}”` : 'photo';
  return { label, what };
}

function validPart(p) {
  return p && p.type === 'gaff-part' && PART_KEYS.includes(p.section) && p.data && typeof p.data === 'object';
}

// Opened from a part link: "Add @kathleen414's Say Hello?"
function confirmPart(p) {
  if (!$('#done-dialog').open) $('#done-dialog').showModal();
  const body = $('#done-body');
  const { label, what } = partSummary(p);
  const k = p.section;
  const existing = k === 'extras' ? (ed.sections || []).some(hasContent) : hasContent(ed[k]);
  const otherDate = p.date && ed.date && p.date !== ed.date;
  const fmt = d => { const t = Gaff.parseDate(d); return t === null ? d : Gaff.ordinalDate(t); };
  body.innerHTML = `<h3 id="dialog-title">Add @${esc(p.from || 'someone')}’s ${esc(label)}?</h3>
    <p>${esc(what)}, written for the gaff on ${esc(fmt(p.date) || 'an unknown date')}.</p>
    ${otherDate ? `<p class="part-error">Your edition is for ${esc(fmt(ed.date))}, not ${esc(fmt(p.date))}. Check this is the right week.</p>` : ''}
    ${existing ? `<p>You already have content in ${esc(label)}. Add theirs after what’s there, or replace it?</p>` : ''}
    <div class="dialog-actions">
      <button class="btn">Cancel</button>
      ${existing ? '<button type="button" class="btn" id="part-replace">Replace</button><button type="button" class="btn primary" id="part-append">Add to what’s there</button>'
                 : '<button type="button" class="btn primary" id="part-append">Add to this edition</button>'}
    </div>`;
  $('#part-append').onclick = () => { $('#done-dialog').close(); mergePart(p, 'append'); };
  if (existing) $('#part-replace').onclick = () => { $('#done-dialog').close(); mergePart(p, 'replace'); };
}

function mergePart(p, how) {
  const k = p.section;
  const data = JSON.parse(JSON.stringify(p.data));
  delete data.enabled;
  if (k === 'extras') {
    const incoming = (data.sections || []).filter(hasContent);
    ed.sections = how === 'replace' ? incoming : [...(ed.sections || []).filter(hasContent), ...incoming];
  } else {
    const cur = ed[k] || {};
    if (how === 'replace' || !hasContent(cur)) {
      ed[k] = { ...data, author: data.author || cur.author };
    } else {
      const merged = { ...cur };
      for (const [f, v] of Object.entries(data)) {
        if (f.startsWith('_')) continue;
        if (Array.isArray(v)) merged[f] = [...(cur[f] || []).filter(x => (typeof x === 'string' ? x.trim() : hasContent(x))), ...v];
        else if (!merged[f] || (typeof merged[f] === 'string' && !merged[f].trim())) merged[f] = v;
      }
      // One-per-line lists redraw from their items.
      Object.keys(merged).filter(f => f.startsWith('_raw_')).forEach(f => delete merged[f]);
      ed[k] = merged;
    }
    ed[k].enabled = true;
  }
  ed._from = { ...(ed._from || {}), [k]: { from: p.from, at: p.created, date: p.date } };
  if (ed._done) delete ed._done[k];
  attempted[k] = false;
  active = k;
  changed();
  refresh().then(() => renderAll({ scroll: true }));
  toast(`Added @${p.from || 'someone'}’s ${STEP_BY[k].label}. Check it, then tick it off.`);
}

/* ------------------------------------------------------------------ */
/* Problems shown on the slots themselves                              */
/* ------------------------------------------------------------------ */

const CONTENT_ERROR = /isn’t closed|embedded data/;

function applyProblems() {
  document.querySelectorAll('.problem').forEach(n => {
    n.classList.remove('problem');
    n.removeAttribute('aria-invalid');
    n.removeAttribute('aria-describedby');
  });
  document.querySelectorAll('.slot-hint.auto').forEach(n => n.remove());
  if (!lastRender) return;
  for (const w of lastRender.warnings) {
    const sec = warningSection(w);
    const contentError = CONTENT_ERROR.test(w);
    if (!contentError && !attempted[sec] && stepStatus(sec) !== 'warn') continue;
    if (contentError) { markContentErrors(sec, w); continue; }
    const path = warningPath(w);
    let target = path && document.querySelector(`[data-path="${path}"]`);
    if (!target && path) target = document.querySelector(`[data-path="${path.split('.').slice(0, 2).join('.')}"]`);
    if (target) hint(target, friendly(w).replace(/^[^:]+: /, ''));
  }
  for (const s of STEPS) {
    const box = document.getElementById(`problems-${s.key}`);
    if (!box) continue;
    const probs = attempted[s.key] ? sectionProblems(s.key) : [];
    box.innerHTML = probs.length ? `<p class="slot-hint">${PART ? 'Before you send this' : 'Before you tick this off'}: ${probs.map(esc).join(' · ')}</p>` : '';
  }
}

function markContentErrors(sec, w) {
  const scope = document.getElementById(`sec-${sec}`) || document;
  let found = false;
  scope.querySelectorAll('.md-slot').forEach(slot => {
    const md = String(getPath(ed, slot.dataset.path) ?? '');
    const bad = /isn’t closed/.test(w) ? Gaff.unclosedBold(md).length : /!\[[^\]]*\]\(\s*(data|blob):/.test(md);
    if (bad) { found = true; hint(slot, /isn’t closed/.test(w) ? 'A ** (bold) isn’t closed, so it would show as stars. Remove it, or close it on the same line.' : 'This has an embedded image. Replace it with the image’s web address.'); }
  });
  if (!found) {
    const box = document.getElementById(`problems-${sec}`);
    if (box) box.append(el('p', { class: 'slot-hint auto' }, friendly(w)));
  }
}

let hintCount = 0;
function hint(target, msg) {
  if (target.classList.contains('problem')) return;
  target.classList.add('problem');
  const id = `hint-${++hintCount}`;
  target.setAttribute('aria-invalid', 'true');
  target.setAttribute('aria-describedby', id);
  const anchor = target.closest('.chip-wrap, .link-row, .paste-beside') || target.closest('h2, h3, .byline, p:not(.slot)') || target;
  anchor.after(el('p', { class: 'slot-hint auto', id }, msg));
}

/* ------------------------------------------------------------------ */
/* Journey                                                             */
/* ------------------------------------------------------------------ */

function goTo(k) {
  if (k === 'review') { active = 'review'; renderAll({ scroll: true }); return; }
  openStep(k, { untick: false });
}

function openStep(k, { untick = true } = {}) {
  if (k !== active) { openItems.clear(); headerOpen = false; }
  if (untick && ed._done?.[k]) delete ed._done[k];
  if (isSkipped(k)) ed[k].enabled = true;
  active = k;
  changed();
  renderAll({ scroll: true });
}

// Something's missing: say so where the person is looking (a toast), mark the
// first box that needs filling in, and take them to it.
function showBlocked(k, probs, lead) {
  applyProblems();
  toast(`${lead}: ${probs.join(' · ')}`);
  let target = document.querySelector(`#sec-${k} .slot.problem, #sec-${k} .link-chip.problem`);
  if (!target && k === 'header' && !(ed.previous_edition || '').trim()) {
    target = document.querySelector('[data-path="previous_edition"]');
    if (target) hint(target, 'Paste last week’s link here');
  }
  if (!target) {
    // e.g. "Add at least one story": point at the first empty title box.
    const empty = sel => [...document.querySelectorAll(sel)].find(s => !s.textContent.trim());
    target = empty(`#sec-${k} .item .title-slot[contenteditable], #sec-${k} .item .inline-slot[contenteditable]`)
      || empty(`#sec-${k} .item [contenteditable]`)
      || empty(`#sec-${k} [contenteditable]:not(.has-default)`);
    if (target) hint(target, 'Fill this in first');
  }
  const box = target || document.getElementById(`problems-${k}`);
  box?.scrollIntoView({ behavior: SMOOTH, block: 'center' });
  if (target && (target.isContentEditable || target.tagName === 'INPUT')) setTimeout(() => target.focus(), 350);
}

async function markDone(k) {
  attempted[k] = true;
  await refresh();
  const probs = sectionProblems(k);
  if (probs.length) return showBlocked(k, probs, 'Not ticked yet');
  ed._done = { ...(ed._done || {}), [k]: true };
  const next = nextStepKey(k);
  active = next;
  openItems.clear();
  changed();
  renderAll({ scroll: true });
  toast(next === 'review' ? 'Everything’s ticked off. Have a last look, then build.' : `${STEP_BY[k].label} ticked off. On to ${STEP_BY[next]?.label}.`);
}

function skip(k) {
  const here = active === k;
  undoable(`${STEP_BY[k].label} skipped this week.`, () => {
    ed[k] = { ...(ed[k] || {}), enabled: false };
    ed._done = { ...(ed._done || {}), [k]: true };
    if (here) active = nextStepKey(k);
  });
  if (here) scrollToActive();
}

let built = null;   // the last successful build, so "Copy the post" shows as done until the post changes
const copiedTitle = { done: false };

// Everything still to do before posting, each one a link to the box that needs it.
function missingList() {
  const items = [];
  for (const st of STEPS) {
    const k = st.key;
    if (finished(k)) continue;
    const probs = sectionProblems(k);
    if (probs.length) probs.forEach(p => items.push({ k, text: /^[^:]+: /.test(p) ? p : `${st.label}: ${p}` }));
    else items.push({ k, text: `${st.label}: not ticked off yet` });
  }
  return items;
}

function goFix(k) {
  attempted[k] = true;
  goTo(k);
  const probs = sectionProblems(k);
  if (probs.length) showBlocked(k, probs, 'Still needed');
}

function renderReview() {
  const box = $('#review');
  if (active !== 'review') { box.innerHTML = ''; return; }
  if (box.contains(document.activeElement) && document.activeElement.tagName === 'INPUT') return;   // don't redraw while typing the link
  box.innerHTML = '';
  const ready = allDone();
  const missing = missingList();
  const pstep = (n, done, title, help, ...kids) => el('li', { class: `pstep ${done ? 'done' : ''}` },
    el('span', { class: 'pnum', 'aria-hidden': 'true' }, done ? '✓' : String(n)),
    el('div', { class: 'pbody' }, el('h3', {}, title, done ? el('span', { class: 'sr-only' }, ' (done)') : null), help && el('p', { class: 'phelp' }, help), ...kids));

  const parts = el('ul', { class: 'review-list' });
  STEPS.forEach((st, i) => {
    const s = stepStatus(st.key);
    const label = { done: 'Done', skipped: 'Skipped this week', warn: 'Ticked, but needs a look', todo: 'Not done yet' }[s];
    parts.append(el('li', { class: s },
      el('span', { class: 'num', 'aria-hidden': 'true' }, { done: '✓', skipped: '–', warn: '!' }[s] || String(i + 1)),
      el('span', { class: 'review-name' }, st.label, el('small', {}, label)),
      el('button', { class: 'btn small', type: 'button', 'aria-label': `${s === 'todo' ? 'Go to' : 'Edit'} ${st.label}`,
        onclick: () => openStep(st.key, { untick: s === 'todo' }) }, s === 'todo' ? 'Go' : 'Edit')));
  });
  const fixBox = missing.length ? el('div', { class: 'missing-box', id: 'missing-box' },
    el('p', { class: 'missing-head' }, `⚠ ${missing.length} thing${missing.length === 1 ? '' : 's'} to do before you post`),
    el('ul', {}, ...missing.map(m => el('li', {}, el('button', { type: 'button', class: 'linkish', onclick: () => goFix(m.k) }, m.text))))) : null;

  const notYet = () => { toast('Tick off every part first.'); $('#missing-box')?.scrollIntoView({ behavior: SMOOTH, block: 'center' }); };
  const isBuilt = built && built.markdown === lastRender?.markdown;
  const posted = !!(ed.posted_url || '').trim();
  const where = !isBuilt ? null : built.browser
    ? el('p', { class: 'phelp' }, 'Saved in this browser. ', el('button', { type: 'button', class: 'linkish', onclick: () => download(`the-gaff-${ed.date}.md`, built.markdown, 'text/markdown') }, 'Download a copy'))
    : el('p', { class: 'phelp' }, 'Saved as ', el('code', {}, built.files[0]), ' and ', el('code', {}, built.files[1]), '.');

  box.append(el('div', { class: 'review-card' },
    el('h2', { class: 'step-title' }, 'Review & post'),
    el('ol', { class: 'post-steps' },
      pstep(1, ready, 'Check everything’s in', ready ? 'Every part is ticked off. The post below is exactly what will go on the community.' : null, fixBox || parts),
      pstep(2, copiedTitle.done, 'Copy the title', 'Then paste it into the title box on the community.',
        el('button', { class: 'btn primary big', type: 'button', onclick: e => (ready ? copyTitle(e.target) : notYet()) }, 'Copy title')),
      pstep(3, isBuilt, 'Copy the post', 'Saves this week’s gaff, then copies it. Paste it into the big box under the title, and post it.',
        el('button', { class: 'btn primary big', type: 'button', onclick: e => (ready ? copyPost(e.target) : notYet()) }, 'Copy post'), where),
      pstep(4, posted, 'Paste the link to your new post', ['Open your post on the community (', gaffListLink('it’s at the top of this list'), '), copy the address from the top of the browser, and paste it here. Next week’s gaff uses it for “Previous Edition”.'],
        linkInput('posted_url', 'Paste the link to your post')))));
}

async function copyTitle(btn) {
  if (!(await copy(lastRender.title, btn, '✓ Title copied'))) return;
  copiedTitle.done = true;
  setTimeout(renderReview, 1600);
}

// Copy straight away (browsers only allow copying right after a click), then save the build.
async function copyPost(btn) {
  const copied = await copy(lastRender.markdown, btn, '✓ Copied');
  let res;
  try {
    res = await api('/api/build', ed);
  } catch (err) {
    return toast(`${copied ? 'Copied, but it' : 'It'} couldn’t be saved: ${err.message}`);
  }
  if (!res.ok) {
    toast('Not saved: a few things still need filling in.');
    res.errors.forEach(e => { attempted[warningSection(e)] = true; });
    return renderReview();
  }
  built = res;
  if (copied) toast(`Copied. Paste it into the community. ${res.browser ? 'Saved in this browser.' : 'Saved.'}`);
  loadList();
  setTimeout(renderReview, 1600);
}

/* ------------------------------------------------------------------ */
/* Markdown rail, refresh, autosave                                    */
/* ------------------------------------------------------------------ */

function partMatches(key) {
  if (active === 'review') return false;
  if (active === 'header') return key === 'header' || key === 'footer';
  if (active === 'extras') return key.startsWith('sections.');
  return key === active;
}

// The Markdown strip only shows sections once they're ticked off (a contributor sees their part as they write).
const partStep = key => (key === 'footer' ? 'header' : key.startsWith('sections.') ? 'extras' : key);
const ticked = k => !!ed._done?.[k] && !isSkipped(k);
const railParts = () => (lastRender?.parts || []).filter(p => PART || ticked(partStep(p.key)));
const railMarkdown = () => { const parts = railParts(); return parts.length ? Gaff.joinParts(parts) : ''; };

function renderRail() {
  const out = $('#rail-md');
  out.innerHTML = '';
  for (const part of railParts()) {
    out.append(el('div', { class: `md-part ${partMatches(part.key) ? 'active' : ''}`, 'data-key': part.key }, el('pre', {}, part.markdown)));
  }
  const waiting = PART ? [] : STEPS.filter(s => !ed._done?.[s.key]).map(s => s.label);
  if (waiting.length) {
    out.append(el('p', { class: 'md-waiting' }, `Shows here once ticked off: ${waiting.join(', ')}.`));
  }
  if ($('#studio').classList.contains('rail-open')) out.querySelector('.md-part.active')?.scrollIntoView({ block: 'nearest' });
}

async function refresh() {
  // The "anything to say under the date" line was removed; drop any left in older drafts
  // so it can't end up in the gaff unseen.
  if ('headline' in ed) { delete ed.headline; changed(); }
  try {
    lastRender = await api('/api/render', ed);
  } catch (err) {
    saveStatus('error', 'Preview failed: ' + err.message);
    return;
  }
  $('#thread-title').textContent = lastRender.title;
  document.title = `${lastRender.title} – editor`;
  const { dateLine } = headerParts();
  const dl = $('#date-line strong');
  if (dl) dl.textContent = dateLine;
  const mark = $('#mark-extras');
  if (mark) mark.textContent = markLabel('extras');
  renderRail();
  if (PREVIEW) return renderPreview();
  applyProblems();
  renderDupHint();
  renderDue();
  if (active === 'review') renderReview();
}

// Top bar: "Saving…" while you type, then "✓ Saved just now" (updated every half minute), or why it wasn't saved.
let savedAt = null;
function saveStatus(state, text) {
  const s = $('#save-status');
  s.className = `save-status ${state}`;
  s.textContent = text;
}
function showSaved() {
  if (!savedAt || !$('#save-status').classList.contains('saved')) return;
  const mins = Math.floor((Date.now() - savedAt) / 60000);
  const when = mins < 1 ? 'just now' : mins === 1 ? '1 min ago' : mins < 60 ? `${mins} mins ago`
    : `at ${new Date(savedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  saveStatus('saved', `✓ Saved ${when}`);
  $('#save-status').title = MODE === 'browser' || PART ? 'Saved in this browser' : 'Saved to drafts/ on this computer';
}
function markSaved() { savedAt = Date.now(); saveStatus('saved', ''); showSaved(); }

const scheduleRefresh = debounce(refresh, 300);
const scheduleSave = debounce(async () => {
  if (PART) return savePartLocally();   // a contributor's part stays in their browser until they send it
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ed.date || '')) return saveStatus('error', 'Not saved: set the date first');
  try {
    await api('/api/draft', ed);
    markSaved();
    loadList();
  } catch (err) {
    saveStatus('error', 'Not saved: ' + err.message);
  }
}, 1200);

function changed() {
  saveStatus('saving', 'Saving…');
  scheduleRefresh();
  scheduleSave();
}

function setRail(open) {
  $('#studio').classList.toggle('rail-open', open);
  document.body.classList.toggle('rail-open', open);   // the top bar follows the same columns
  const t = $('#rail-toggle');
  t.textContent = open ? '»' : '«';
  t.title = open ? 'Collapse the Markdown' : 'Show the Markdown';
  t.setAttribute('aria-label', t.title);
  t.setAttribute('aria-expanded', String(open));
  try { localStorage.setItem('gaff.railOpen', open ? '1' : '0'); } catch { /* storage unavailable */ }
  if (open) renderRail();
}

/* ------------------------------------------------------------------ */
/* Open / new / build                                                  */
/* ------------------------------------------------------------------ */

async function loadList() {
  const { drafts, editions, backups = {} } = await api('/api/list');
  const stamp = s => `${s.slice(6, 8)}/${s.slice(4, 6)} ${s.slice(9, 11)}:${s.slice(11, 13)}:${s.slice(13, 15)}`;
  $('#open-select').innerHTML = '<option value="">Open a draft…</option>' +
    (drafts.length ? `<optgroup label="Drafts">${drafts.map(n => `<option value="draft:${n}">${n}</option>`).join('')}</optgroup>` : '') +
    (editions.length ? `<optgroup label="Built editions">${editions.map(n => `<option value="edition:${n}">${n}</option>`).join('')}</optgroup>` : '') +
    Object.entries(backups).map(([d, list]) => list.length
      ? `<optgroup label="Earlier versions of ${d}">${list.map(s => `<option value="backup:${d}/${s}">${d} as at ${stamp(s)}</option>`).join('')}</optgroup>` : '').join('');
}

async function openSaved(value) {
  const [kind, name] = value.split(':');
  if (kind === 'backup' && !confirm('Open this earlier version? It becomes the current draft as soon as you edit it (the version you have now is kept as a backup).')) return;
  ed = await api(`/api/open?kind=${kind}&name=${encodeURIComponent(name)}`);
  ed._done = ed._done || {};
  Object.keys(attempted).forEach(k => delete attempted[k]);
  await refresh();
  active = firstOpenStep();
  renderFromTop();
  saveStatus('saved', `Opened ${kind === 'backup' ? 'an earlier version' : kind} ${kind === 'backup' ? '' : name}`.trim());
}

// Start this week's gaff again from a blank page (same date; last week's link and the usual authors filled in).
// Undo puts it straight back, and the old version is kept under Open a draft… → Earlier versions.
async function clearPage() {
  const name = lastRender?.title || 'this gaff';
  if (!confirm(`Clear everything on this page and start ${name} again?\n\nYou can press Undo straight after. The old version is also kept under “Open a draft…” → Earlier versions.`)) return;
  const fresh = await api(/^\d{4}-\d{2}-\d{2}$/.test(ed.date || '') ? `/api/new?date=${encodeURIComponent(ed.date)}` : '/api/new');
  undoable('Page cleared.', () => {
    ed = { ...fresh, _done: {} };
    active = 'header';
    openItems.clear();
    Object.keys(attempted).forEach(k => delete attempted[k]);
  });
  $('#scroll').scrollTop = 0;
}

async function newEdition() {
  const next = await api('/api/new');
  const date = prompt('Date for the new edition (YYYY-MM-DD):', next.date);
  if (!date) return;
  const { drafts } = await api('/api/list');
  if (drafts.includes(date)) {
    const fresh = confirm(`There’s already a draft for ${date}.\n\nOK = start ${date} again from scratch (the current draft is kept under Open… → Earlier versions)\nCancel = open the existing draft`);
    if (!fresh) return openSaved(`draft:${date}`);
  }
  ed = date === next.date ? next : await api(`/api/new?date=${encodeURIComponent(date)}`);
  ed._done = {};
  Object.keys(attempted).forEach(k => delete attempted[k]);
  active = 'header';
  await refresh();
  renderFromTop();
  changed();
}

/* Files: keep a copy of a draft outside the browser, or move it to another computer. */
function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type: `${type};charset=utf-8` }));
  const a = el('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* Pictures from community.giffgaff.com don't always load here (the community often refuses
   pictures shown on other sites). Show a tidy labelled box instead of a broken image; the
   picture itself still shows on the community. */
document.addEventListener('error', e => {
  const img = e.target;
  if (!(img instanceof HTMLImageElement) || img.dataset.failed) return;
  img.dataset.failed = '1';
  if (img.closest('.avatar-pic')) { img.closest('.avatar-pic').classList.add('missing'); img.remove(); return; }
  img.replaceWith(el('span', { class: 'img-missing' }, `${img.alt || 'Picture'} – shows on the community`));
}, true);

/* ------------------------------------------------------------------ */
/* Start                                                               */
/* ------------------------------------------------------------------ */

async function init() {
  MODE = await detectMode();
  META = await api('/api/meta');

  // ?part=say_hello → contributor mode: write just that section and send it.
  const wanted = new URLSearchParams(location.search).get('part');
  if (PART_KEYS.includes(wanted)) {
    PART = wanted;
    document.body.dataset.part = PART;
    loadPart();
    await refresh();
    renderFromTop();
    $('#send-part').onclick = sendPart;
  } else {
    ed = await api('/api/latest');
    ed._done = ed._done || {};
    saveStatus('saved', '✓ Saved');
    await refresh();
    active = firstOpenStep();
    renderFromTop();
    await loadList();
    // #part=… → someone's part, opened from the link they sent.
    const sent = /^#part=([A-Za-z0-9_-]+)/.exec(location.hash);
    if (sent) {
      history.replaceState(null, '', siteUrl() + location.search);
      try {
        const p = await decodePart(sent[1]);
        if (!validPart(p)) throw new Error();
        confirmPart(p);
      } catch {
        toast('That part link couldn’t be read. It may have been cut short. Ask them to send it again, by email if it’s long.');
      }
    }
  }

  $('#open-select').onchange = e => { if (e.target.value) openSaved(e.target.value); e.target.value = ''; };
  $('#new-btn').onclick = newEdition;
  $('#clear-btn').onclick = clearPage;
  $('#review-btn').onclick = () => goTo('review');
  setInterval(showSaved, 30000);
  $('#rail-toggle').onclick = () => setRail(!$('#studio').classList.contains('rail-open'));
  $('#rail-heading').onclick = () => { if (!$('#studio').classList.contains('rail-open')) setRail(true); };
  $('#rail-copy').onclick = e => (railMarkdown() ? copy(railMarkdown(), e.target, '✓') : toast('Nothing ticked off yet. Sections show in the Markdown once they’re ticked off.'));
  let open = false;
  try { open = localStorage.getItem('gaff.railOpen') === '1'; } catch { /* storage unavailable */ }
  setRail(open);
}

init().catch(err => {
  document.body.innerHTML = `<p style="padding:20px">Couldn’t start the editor: ${esc(err.message)}.</p>`;
});
