/* gaff.js – a JavaScript port of gaff.py's renderer, so the editor can run
   with no server (e.g. on GitHub Pages). Same Markdown, same checks, same
   warning messages; tests/test_js_parity.py keeps the two in step.

   Works in the browser (window.Gaff) and in Node (require). */
(function (root) {
  'use strict';

  const COMMUNITY = 'https://community.giffgaff.com';
  const ASSETS = `${COMMUNITY}/assets/files`;

  // Issue #709 went out on 27 Nov 2026; the gaff is weekly, every Friday.
  const ANCHOR = Date.UTC(2026, 10, 27);
  const ANCHOR_ISSUE = 709;
  const DAY = 86400000;

  const IMAGES = {
    banner: `${ASSETS}/2026-01-16/1768584983-316669-the-gaff-banner-2026.png`,
    say_hello: `${ASSETS}/2020-09-18/1600444273-668106-kath-welcome.jpeg`,
    giffgaffiversary: `${ASSETS}/2021-03-26/1616777859-632889-happy-giffgaffiversary-300px.png`,
    photo_of_the_week: `${ASSETS}/2019-12-13/1576258237-104660-potw-banner-brulaw-v2.png`,
  };
  const AVATARS = {
    6: `${ASSETS}/2019-12-06/1575650122-835850-giffgaff-avatar-6-100px.jpeg`,
    8: `${ASSETS}/2019-12-06/1575650122-966610-giffgaff-avatar-8-100px.jpeg`,
    14: `${ASSETS}/2019-12-06/1575650123-442016-giffgaff-avatar-14-100px.jpeg`,
  };
  const AVATAR_IDS = [6, 8, 14];
  const DEFAULT_AUTHORS = {
    happenings: 'bluemoonbaz',
    say_hello: 'kathleen414',
    giffgaffiversary: 'ijustcantdoit',
    photo_of_the_week: 'brulaw',
  };
  const SAY_HELLO_INTRO =
    'More fab new members are joining giffgaff and our awesome community. ' +
    'Please welcome them to giffgaff and show them around the community! ' +
    'Introduce yourself, ask our existing members what giffgaff is really like, ' +
    'or just share your impressions about giffgaff.';
  const SAY_HELLO_OUTRO = 'A big warm giffgaff community welcome to our giffgaffers!';
  const SECTION_LABELS = {
    happenings: 'giffgaff Happenings',
    say_hello: 'Say Hello!',
    giffgaffiversary: 'Happy giffgaffiversary!',
    photo_of_the_week: 'Photo Of The Week',
  };
  const SECTION_KEYS = ['happenings', 'say_hello', 'giffgaffiversary', 'photo_of_the_week'];
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
    'August', 'September', 'October', 'November', 'December'];

  class EditionError extends Error {}

  /* ---------------- Python-compatible string helpers ---------------- */

  // Characters Python's str.strip()/isspace() treat as whitespace.
  const PY_WS = '\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
  const RSTRIP = new RegExp(`[${PY_WS}]+$`, 'u');
  const LSTRIP = new RegExp(`^[${PY_WS}]+`, 'u');
  const pyStrip = s => s.replace(LSTRIP, '').replace(RSTRIP, '');
  const pyRstrip = s => s.replace(RSTRIP, '');
  const stripNewlines = s => s.replace(/^\n+|\n+$/g, '');           // str.strip("\n")
  const LINE_BREAK = /\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/;
  function splitlines(s) {                                          // str.splitlines()
    if (s === '') return [];
    const parts = s.split(LINE_BREAK);
    if (LINE_BREAK.test(s.slice(-1))) parts.pop();
    return parts;
  }
  const codepoints = (s, n) => Array.from(s).slice(0, n).join('');  // s[:n] in Python
  const has = (o, k) => o != null && Object.prototype.hasOwnProperty.call(o, k);
  const get = (o, k, d) => (has(o, k) ? o[k] : d);                  // dict.get(k, d)
  const str = v => (v === null || v === undefined ? 'None' : String(v));

  /* ---------------- dates ---------------- */

  function parseDate(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(typeof s === 'string' ? s : '');
    if (!m) return null;
    const t = Date.UTC(+m[1], +m[2] - 1, +m[3]);
    return new Date(t).getUTCMonth() === +m[2] - 1 ? t : null;
  }
  const isoDate = t => new Date(t).toISOString().slice(0, 10);
  function todayUTC() { const d = new Date(); return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()); }

  function ordinalDate(t) {
    const d = new Date(t);
    const n = d.getUTCDate();
    const suffix = (n % 100 >= 11 && n % 100 <= 13) ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th');
    return `${n}${suffix} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  }

  function issueNumber(t) {
    const days = Math.round((t - ANCHOR) / DAY);
    const weeks = Math.floor(days / 7);
    if (days - weeks * 7) throw new EditionError(`${isoDate(t)} is not a gaff Friday; set \`issue\` explicitly`);
    return ANCHOR_ISSUE + weeks;
  }

  // Next Friday on or after a date (for a brand-new edition with nothing to go on).
  function nextFriday(t) { const dow = new Date(t).getUTCDay(); return t + ((5 - dow + 7) % 7) * DAY; }

  /* ---------------- Markdown helpers (Flarum flavour) ---------------- */

  const profile = user => `${COMMUNITY}/u/${str(user).replace(/^@+/, '')}`;
  const image = url => `![](${str(url)})`;
  const link = (text, url) => (url ? `[${str(text)}](${str(url)})` : str(text));
  const bold = text => `**${text}**`;
  const mention = user => '@' + str(user).replace(/^@+/, '');
  const quote = text => splitlines(stripNewlines(str(text)))
    .map(ln => (pyStrip(ln) ? `> ${pyRstrip(ln)}` : '>')).join('\n');
  const paragraphs = text => stripNewlines(str(text));
  const EMBEDDED_IMAGE = /!\[[^\]]*\]\(\s*(?:data|blob):[^)]*\)/;

  // Words that keep a particular case when a title is built from a link (same as gaff.py).
  const LINK_WORDS = {
    giffgaff: 'giffgaff', esim: 'eSIM', esims: 'eSIMs', sim: 'SIM', sims: 'SIMs',
    uk: 'UK', ai: 'AI', faq: 'FAQ', faqs: 'FAQs', ee: 'EE', o2: 'O2', bt: 'BT',
    '4g': '4G', '5g': '5G', tv: 'TV', iphone: 'iPhone', ios: 'iOS', pac: 'PAC',
    stac: 'STAC', vpn: 'VPN', nhs: 'NHS', dvla: 'DVLA', hmrc: 'HMRC', gb: 'GB',
  };
  // Kept lower case in the middle of a title built from a link (same as gaff.py).
  const SMALL_WORDS = new Set(['a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'in', 'nor', 'of', 'on', 'or', 'per', 'the', 'to', 'vs', 'via']);

  // A readable title from a thread link, for when only the link was given.
  function titleFromLink(url) {
    const m = /^https?:\/\/([^/?#]+)([^?#]*)/.exec(pyStrip(String(url)));
    if (!m) return String(url);
    const host = m[1].startsWith('www.') ? m[1].slice(4) : m[1];
    const parts = m[2].split('/').filter(Boolean);
    if (!parts.length) return host;
    let last = parts[parts.length - 1];
    if (/^\d+$/.test(last) && parts.length >= 2) last = parts[parts.length - 2];   // /d/<id>-<slug>/<post number>
    last = last.replace(/^\d+-/, '');                                               // drop the discussion number
    let decoded = last;
    try { decoded = decodeURIComponent(last); } catch { /* leave as-is */ }
    let words = decoded.split(/[-_+]+/).filter(Boolean);
    if (!words.length || (words.length === 1 && /\d/.test(words[0]) && /[A-Za-z]/.test(words[0]) && !has(LINK_WORDS, words[0].toLowerCase()))) return host;
    // Links are all lower case, so guess the capitals: thread titles are nearly always in
    // title case ("October 2026 Payback Calculations"), with small words lower case in the middle.
    const end = words.length - 1;
    return words.map((w, i) => {
      w = w.toLowerCase();
      if (has(LINK_WORDS, w)) return LINK_WORDS[w];
      if (i > 0 && i < end && SMALL_WORDS.has(w)) return w;
      const chars = Array.from(w);
      return (chars[0] || '').toUpperCase() + chars.slice(1).join('');
    }).join(' ');
  }

  // The item's title, or one built from its link if it has none (or it's just the link).
  function linkTitle(item) {
    const title = item ? item.title : undefined;
    const url = item ? item.link : undefined;
    if (url && (!title || pyStrip(String(title)) === pyStrip(String(url)))) return titleFromLink(String(url));
    return title;
  }

  function unclosedBold(md) {
    const found = [];
    for (const line of splitlines(md)) {
      let text = line.replace(/^\s*(>\s?)+/, '');
      text = text.replace(/`[^`]*`|https?:\/\/[^\s)*]+/g, '');
      if ((text.match(/\*\*/g) || []).length % 2) found.push(pyStrip(text));
    }
    return found;
  }

  /* ---------------- rendering ---------------- */

  function renderParts(ed, strict = true) {
    const warnings = strict ? null : [];
    const problem = (msg, fallback) => {
      if (!warnings) throw new EditionError(msg);
      warnings.push(msg);
      return fallback;
    };
    const need = (item, key, where) => {
      const val = item ? item[key] : undefined;
      if (!val) return problem(`${where}: missing \`${key}\``, `⚠ ${key} needed`);
      return val;
    };
    const sectionHeader = (title, author) => {
      const blocks = ['---', `### ${str(title)}`];
      if (author) blocks.push(`#### *by ${link(mention(author), profile(author))}*`);
      return blocks;
    };
    const avatarUrl = value => {
      if (typeof value === 'string' && /^\d+$/.test(value.trim())) value = parseInt(value.trim(), 10);
      if (Number.isInteger(value)) {
        if (!AVATAR_IDS.includes(value)) return problem(`unknown avatar ${value}; known: [6, 8, 14] (or use a URL)`, AVATARS[14]);
        return AVATARS[value];
      }
      return str(value);
    };
    const featuredPost = (item, where, boldTitle = false) => {
      const title = link(need(item, 'title', where), item.link);
      const blocks = [boldTitle ? bold(title) : title];
      if (item.greeting) blocks.push(paragraphs(item.greeting));
      if (item.quote) blocks.push(quote(item.quote));
      return blocks;
    };

    const RENDERERS = {
      happenings(s) {
        const blocks = sectionHeader(get(s, 'title', 'giffgaff Happenings'), get(s, 'author', DEFAULT_AUTHORS.happenings));
        get(s, 'stories', []).forEach((story, i) => blocks.push(...featuredPost(story, `happenings.stories[${i + 1}]`, true)));
        const buzzing = get(s, 'buzzing', []);
        if (buzzing.length) {
          blocks.push(bold('See what’s been buzzing on our Community this week:'));
          blocks.push(buzzing.map((b, i) => `- ${link(need({ ...b, title: linkTitle(b) }, 'title', `happenings.buzzing[${i + 1}]`), b.link)}`).join('\n'));
        }
        return blocks;
      },
      say_hello(s) {
        const blocks = sectionHeader(get(s, 'title', 'Say Hello!'), get(s, 'author', DEFAULT_AUTHORS.say_hello));
        blocks.push(image(get(s, 'image', IMAGES.say_hello)));
        blocks.push(paragraphs(get(s, 'intro', SAY_HELLO_INTRO)));
        get(s, 'members', []).forEach((m, i) => {
          blocks.push(image(avatarUrl(get(m, 'avatar', AVATAR_IDS[i % AVATAR_IDS.length]))));
          blocks.push(...featuredPost(m, `say_hello.members[${i + 1}]`));
        });
        blocks.push(paragraphs(get(s, 'outro', SAY_HELLO_OUTRO)));
        return blocks;
      },
      giffgaffiversary(s) {
        const author = get(s, 'author', DEFAULT_AUTHORS.giffgaffiversary);
        const blocks = sectionHeader(get(s, 'title', 'Happy giffgaffiversary!'), author);
        blocks.push(image(get(s, 'image', IMAGES.giffgaffiversary)));
        if (s.intro) blocks.push(paragraphs(s.intro));
        get(s, 'posts', []).forEach((p, i) => blocks.push(...featuredPost(p, `giffgaffiversary.posts[${i + 1}]`)));
        blocks.push(bold('If it’s YOUR giffgaffiversary, please let the team know by sending a ' +
          `private message to ${mention(author)}`));
        return blocks;
      },
      photo_of_the_week(s) {
        const where = 'photo_of_the_week';
        const blocks = sectionHeader(get(s, 'title', 'Photo Of The Week'), get(s, 'author', DEFAULT_AUTHORS.photo_of_the_week));
        blocks.push(image(get(s, 'banner', IMAGES.photo_of_the_week)));
        const photoTitle = link(need(s, 'photo_title', where), s.link);
        blocks.push(`This week’s featured photo is ${photoTitle} by ${mention(need(s, 'by', where))}`);
        const comments = get(s, 'comments', []);
        if (comments.length) {
          blocks.push(bold('See what fellow members are saying:'));
          blocks.push(comments.map((c, i) =>
            `- “${str(need(c, 'text', `${where}.comments[${i + 1}]`))}” — ${mention(need(c, 'by', `${where}.comments[${i + 1}]`))}`).join('\n'));
        }
        for (const url of get(s, 'images', [])) blocks.push(image(url));
        if (s.outro) blocks.push(paragraphs(s.outro));
        return blocks;
      },
    };
    const renderCustom = (s, i) => {
      const blocks = sectionHeader(need(s, 'title', `sections[${i}]`), s.author);
      if (s.image) blocks.push(image(s.image));
      if (s.body) blocks.push(paragraphs(s.body));
      return blocks;
    };

    let date = parseDate(ed.date);
    if (date === null) date = problem('`date` must be a TOML date, e.g. date = 2026-12-04', todayUTC());
    let issue = ed.issue;
    if (!issue) {
      try { issue = issueNumber(date); } catch (e) { if (!(e instanceof EditionError)) throw e; issue = problem(e.message, '?'); }
    }

    const header = [image(get(ed, 'banner', IMAGES.banner)), bold(`${ordinalDate(date)} / Issue #${issue}`)];
    if (ed.headline) header.push(paragraphs(ed.headline));
    const parts = [['header', 'Header', header]];
    for (const key of SECTION_KEYS) {
      if (has(ed, key)) parts.push([key, get(ed[key], 'title', SECTION_LABELS[key]), RENDERERS[key](ed[key])]);
    }
    get(ed, 'sections', []).forEach((s, i) => parts.push([`sections.${i + 1}`, s.title || `Extra section ${i + 1}`, renderCustom(s, i + 1)]));
    const prev = ed.previous_edition;
    parts.push(['footer', 'Footer', ['---', '### Thanks for reading!',
      `${link('Previous Edition', prev)} | Next Edition (${ordinalDate(date + 7 * DAY)})`]]);

    const out = parts.map(([key, label, blocks]) => {
      let md = blocks.join('\n\n');
      if (EMBEDDED_IMAGE.test(md)) {
        problem(`${key}: an image was pasted as embedded data rather than a link. On the community, ` +
          'right-click the image, choose Copy image address and paste that instead', null);
        md = md.replace(new RegExp(EMBEDDED_IMAGE.source, 'g'), '⚠ image_link needed');
      }
      for (const para of unclosedBold(md)) {
        problem(`${key}: a ** (bold) isn’t closed in “${codepoints(para, 60)}…”. Bold can’t run across paragraphs or ` +
          'lines, so the ** shows up as stars. Remove it, or put ** at both ends of the same line', null);
      }
      return { key, label: str(label), markdown: md };
    });
    return { parts: out, warnings: warnings || [] };
  }

  const joinParts = parts => parts.map(p => p.markdown).join('\n\n') + '\n';
  const render = ed => joinParts(renderParts(ed, true).parts);
  const threadTitle = ed => `The gaff - ${ordinalDate(parseDate(ed.date))}`;

  /* ---------------- editor JSON <-> edition (mirrors app/server.py) ---------------- */

  function clean(v) {
    if (typeof v === 'string') { const s = pyStrip(v.replace(/\r\n/g, '\n')); return s || null; }
    if (Array.isArray(v)) { const items = v.map(clean).filter(c => c !== null); return items.length ? items : null; }
    if (v && typeof v === 'object') {
      const d = {};
      for (const [k, x] of Object.entries(v)) {
        if (k.startsWith('_')) continue;
        const c = clean(x);
        if (c !== null) d[k] = c;
      }
      return Object.keys(d).length ? d : null;
    }
    return v === undefined ? null : v;
  }

  function fromUi(input) {
    const ui = { ...input };
    for (const key of SECTION_KEYS) {
      const sec = ui[key];
      if (sec && typeof sec === 'object' && !Array.isArray(sec)) {
        if (!get(sec, 'enabled', true)) delete ui[key];
        else { const { enabled, ...rest } = sec; ui[key] = rest; }
      }
    }
    const ed = clean(ui) || {};
    for (const key of SECTION_KEYS) {
      if (ui[key] && typeof ui[key] === 'object' && !has(ed, key)) ed[key] = {};
    }
    const issue = ed.issue;
    delete ed.issue;
    if (Number.isInteger(issue) || (typeof issue === 'string' && /^\d+$/.test(issue))) ed.issue = parseInt(issue, 10);
    for (const m of get(ed.say_hello || {}, 'members', [])) {
      if (typeof m.avatar === 'string' && /^\d+$/.test(m.avatar)) m.avatar = parseInt(m.avatar, 10);
    }
    return ed;
  }

  function toUi(ed) {
    const ui = JSON.parse(JSON.stringify(ed));
    for (const key of SECTION_KEYS) {
      if (!has(ui, key)) ui[key] = { enabled: false };
      if (!has(ui[key], 'enabled')) ui[key].enabled = true;
    }
    return ui;
  }

  // What the server's /api/render returns, computed in the browser.
  function renderUi(ui, strict = false) {
    const ed = fromUi(ui);
    const { parts, warnings } = renderParts(ed, strict);
    return { parts, markdown: joinParts(parts), warnings, title: parseDate(ed.date) !== null ? threadTitle(ed) : 'The gaff' };
  }

  const api = {
    COMMUNITY, IMAGES, AVATARS, DEFAULT_AUTHORS, SAY_HELLO_INTRO, SAY_HELLO_OUTRO, SECTION_LABELS, SECTION_KEYS,
    EditionError, ordinalDate, issueNumber, parseDate, isoDate, todayUTC, nextFriday, DAY,
    renderParts, joinParts, render, threadTitle, unclosedBold, fromUi, toUi, renderUi, titleFromLink, linkTitle,
  };
  root.Gaff = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
