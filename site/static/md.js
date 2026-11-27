/* Shared by the editor (app.js) and the mock (mock.html):
   - htmlToMd: clipboard HTML from the community / Google Docs -> clean Markdown
   - mdToHtml: Markdown -> HTML, the subset Flarum renders, for previews */
'use strict';

const COMMUNITY = 'https://community.giffgaff.com';
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let skippedImages = 0;            // images left out of the last paste (embedded data)

const absUrl = href => { try { return new URL(href, COMMUNITY).href; } catch { return href; } };
const EMOJI_RE = /\p{Extended_Pictographic}/u;

function htmlToMd(html) {
  return nodeToMd(new DOMParser().parseFromString(html, 'text/html').body);
}

// Converted Markdown for one element, with whitespace tidied line by line.
function nodeToMd(node) {
  return convertNode(node)
    .split('\n').map(l => l.replace(/[ \t ]+/g, ' ').trim()).join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function wrapInline(text, mark) {
  // Markdown emphasis can't cross a line or paragraph break, so wrap each line on its own.
  if (/\n/.test(text.trim())) return text.split('\n').map(l => wrapInline(l, mark)).join('\n');
  const m = text.match(/^(\s*)([\s\S]*?)(\s*)$/);
  return m[2] ? `${m[1]}${mark}${m[2]}${mark}${m[3]}` : text;
}

// Google Docs (and others) wrap whole selections in <b style="font-weight:normal">,
// and express real bold/italic as <span style="font-weight:700">. Read the style, not the tag.
// Is an ancestor already making this bold? (Ignores the fake "normal weight" <b> wrapper.)
function insideBold(el) {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const t = p.tagName.toLowerCase();
    if ((t === 'b' || t === 'strong') && weightOf(p) !== 'normal') return true;
    if (/^h[1-6]$/.test(t) || (t === 'span' && weightOf(p) === 'bold')) return true;
  }
  return false;
}

function weightOf(el) {
  const w = (el.style && el.style.fontWeight) || '';
  if (w === 'normal' || w === 'lighter' || (/^\d+$/.test(w) && +w < 600)) return 'normal';
  if (w === 'bold' || w === 'bolder' || (/^\d+$/.test(w) && +w >= 600)) return 'bold';
  return '';
}

function convertNode(node) {
  let s = '';
  for (const n of node.childNodes) {
    if (n.nodeType === Node.TEXT_NODE) { s += n.nodeValue.replace(/\s+/g, ' '); continue; }
    if (n.nodeType !== Node.ELEMENT_NODE) continue;
    const tag = n.tagName.toLowerCase();
    const inner = () => convertNode(n);
    switch (tag) {
      case 'script': case 'style': case 'head': case 'meta': case 'title': case 'button': break;
      case 'br': s += '\n'; break;
      case 'p': case 'div': case 'section': case 'article': case 'header': case 'footer': case 'figure':
        s += '\n\n' + inner().trim() + '\n\n'; break;
      case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6':
        s += '\n\n' + wrapInline(inner().trim(), '**') + '\n\n'; break;
      case 'strong': case 'b': s += weightOf(n) === 'normal' ? inner() : wrapInline(inner(), '**'); break;
      case 'em': case 'i': s += n.style.fontStyle === 'normal' ? inner() : wrapInline(inner(), '*'); break;
      case 'span': {
        let t = inner();
        if (weightOf(n) === 'bold' && !insideBold(n)) t = wrapInline(t, '**');
        if (n.style.fontStyle === 'italic' && !n.closest('i, em')) t = wrapInline(t, '*');
        s += t;
        break;
      }
      case 'a': {
        const href = n.getAttribute('href') || '';
        const text = inner().trim();
        const user = href.match(/\/u\/([\w.-]+)\/?$/);
        if (n.classList.contains('UserMention') || (user && text.startsWith('@'))) s += '@' + (user ? user[1] : text.slice(1));
        else if (n.classList.contains('PostMention')) s += text;
        else if (!href || href.startsWith('#') || /^javascript:/i.test(href)) s += text;
        else {
          const url = absUrl(href);
          s += (text === url || text === href) ? url : `[${text}](${url})`;
        }
        break;
      }
      case 'img': {
        const alt = n.getAttribute('alt') || '';
        const src = (n.getAttribute('src') || '').trim();
        if (n.classList.contains('emoji') || (alt && EMOJI_RE.test(alt) && alt.length <= 8)) s += alt;
        else if (/^(data|blob):/i.test(src)) skippedImages++;
        else if (src) s += `\n\n![](${absUrl(src)})\n\n`;
        break;
      }
      case 'ul': case 'ol': {
        let i = 1;
        s += '\n\n';
        for (const li of n.children) {
          if (li.tagName.toLowerCase() !== 'li') continue;
          s += (tag === 'ol' ? `${i++}. ` : '- ') + convertNode(li).trim().replace(/\s*\n+\s*/g, ' ') + '\n';
        }
        s += '\n';
        break;
      }
      case 'blockquote': {
        const body = nodeToMd(n);
        s += '\n\n' + body.split('\n').map(l => (l ? '> ' + l : '>')).join('\n') + '\n\n';
        break;
      }
      case 'hr': s += '\n\n---\n\n'; break;
      default: s += inner();
    }
  }
  return s;
}

/* ------------------------------------------------------------------ */
/* Markdown → HTML for the preview (the subset Flarum uses here)       */
/* ------------------------------------------------------------------ */

function mdToHtml(md) {
  return md.replace(/\r/g, '').split(/\n[ \t]*\n/).map(renderBlock).join('\n');
}

function renderBlock(block) {
  const lines = block.replace(/^\n+|\n+$/g, '').split('\n');
  if (!lines.join('').trim()) return '';
  // Group consecutive lines of the same kind (a quote or list can follow a paragraph line directly).
  const kindOf = l => (/^\s*>/.test(l) ? 'quote' : /^\s*[-*+]\s+/.test(l) ? 'ul' : /^\s*\d+[.)]\s+/.test(l) ? 'ol' : 'p');
  const groups = [];
  for (const l of lines) {
    const k = kindOf(l);
    if (groups.length && groups.at(-1).kind === k) groups.at(-1).lines.push(l);
    else groups.push({ kind: k, lines: [l] });
  }
  return groups.map(renderGroup).join('\n');
}

function renderGroup({ kind, lines }) {
  if (kind === 'quote') return `<blockquote>${mdToHtml(lines.map(l => l.replace(/^\s*> ?/, '')).join('\n'))}</blockquote>`;
  if (kind === 'ul') return '<ul>' + lines.map(l => `<li>${inline(l.replace(/^\s*[-*+]\s+/, ''))}</li>`).join('') + '</ul>';
  if (kind === 'ol') return '<ol>' + lines.map(l => `<li>${inline(l.replace(/^\s*\d+[.)]\s+/, ''))}</li>`).join('') + '</ol>';

  let out = '';
  let para = [];
  const flush = () => { if (para.length) out += `<p>${para.map(inline).join('<br>\n')}</p>`; para = []; };
  for (const l of lines) {
    let m;
    if (/^ {0,3}(-\s*){3,}$|^ {0,3}(\*\s*){3,}$|^ {0,3}(_\s*){3,}$/.test(l)) {
      if (para.length && /^ {0,3}-+\s*$/.test(l)) {
        // Flarum (like all Markdown) turns "text\n---" into a heading – flag it.
        out += `<h2 class="setext-warning" title="A line followed by --- becomes a heading. Add a blank line before ---">${para.map(inline).join(' ')}</h2>`;
        para = [];
      } else { flush(); out += '<hr>'; }
    } else if ((m = l.match(/^(#{1,6})\s+(.*?)\s*#*$/))) {
      flush();
      out += `<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`;
    } else if (/^\s*!\[[^\]]*\]\([^)]+\)\s*$/.test(l) && !para.length) {
      out += `<p>${inline(l.trim())}</p>`;
    } else {
      para.push(l);
    }
  }
  flush();
  return out;
}

function inline(src) {
  const toks = [];
  const put = html => `\u0001${toks.push(html) - 1}\u0002`;
  const attr = s => esc(s);
  let s = src;
  s = s.replace(/`([^`]+)`/g, (_, c) => put(`<code>${esc(c)}</code>`));
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_, a, u) => put(`<img src="${attr(u)}" alt="${attr(a)}" loading="lazy" referrerpolicy="no-referrer">`));
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_, t, u) => put(`<a href="${attr(u)}" target="_blank" rel="noopener">${emphasis(esc(t))}</a>`));
  s = s.replace(/<?(https?:\/\/[^\s<>]*[^\s<>.,;:!?)"'”’])>?/g, (_, u) => put(`<a href="${attr(u)}" target="_blank" rel="noopener">${esc(u)}</a>`));
  s = esc(s);
  s = s.replace(/(^|[^\w@\/.&])@([A-Za-z0-9_.-]*[A-Za-z0-9_])/g,
    (_, pre, u) => pre + put(`<a class="mention" href="${COMMUNITY}/u/${attr(u)}" target="_blank" rel="noopener">@${esc(u)}</a>`));
  s = s.replace(/⚠ (\w+) needed/g, (_, k) => put(`<span class="placeholder">⚠ ${esc(k.replace(/_/g, ' '))} needed</span>`));
  s = emphasis(s);
  for (let i = 0; i < 3 && s.includes('\u0001'); i++) s = s.replace(/\u0001(\d+)\u0002/g, (_, i) => toks[i]);
  return s;
}

function emphasis(s) {
  return s
    .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>')
    .replace(/__(?=\S)([\s\S]*?\S)__/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*(?=\S)([^*]*?\S)\*(?![\w*])/g, '$1<em>$2</em>')
    .replace(/(^|[^_\w])_(?=\S)([^_]*?\S)_(?!\w)/g, '$1<em>$2</em>');
}
