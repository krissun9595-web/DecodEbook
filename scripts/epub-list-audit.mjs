// Headless regression harness for EPUB list rendering (indent + marker).
// Replicates App.tsx processEpub's lenToEm / cssBoxLeftEm / declProp / boxLeftEm /
// renderedIndentEm / list-style-type marker logic over the REAL test EPUBs, so a change
// to the shared <li> handler can be diffed old-vs-new across every book BEFORE shipping.
//
// Usage: node scripts/epub-list-audit.mjs           # dump every <li>'s depth/indent/marker
//        node scripts/epub-list-audit.mjs --changed # only items whose indent != 0 (the ones a nest-indent touches)
import { parseHTML } from 'linkedom';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const EPUBS = fs.readdirSync('/root/testfiles').filter(f => f.endsWith('.epub')).map(f => path.join('/root/testfiles', f));
const onlyChanged = process.argv.includes('--changed');

// ---- ports of the App.tsx helpers (keep byte-identical to processEpub) ----
const lenToEm = (value) => {
  const m = /(-?[\d.]+)\s*(em|rem|px)/i.exec(value || '');
  if (m) { const n = parseFloat(m[1]) || 0; return m[2].toLowerCase() === 'px' ? n / 16 : n; }
  return /^\s*0/.test(value || '') ? 0 : null;
};
const sideLeftEm = (decls, prop) => {
  const explicit = new RegExp(`${prop}-left\\s*:\\s*([^;}]+)`, 'i').exec(decls);
  if (explicit) return lenToEm(explicit[1]);
  const sh = new RegExp(`\\b${prop}\\s*:\\s*([^;}]+)`, 'i').exec(decls);
  if (sh) { const p = sh[1].trim().split(/\s+/); const left = p.length === 4 ? p[3] : p.length >= 2 ? p[1] : p[0]; return left ? lenToEm(left) : null; }
  return null;
};
const specOf = (sel) => { // rough CSS specificity (ids, classes/attrs, tags)
  const ids = (sel.match(/#[\w-]+/g) || []).length;
  const cls = (sel.match(/[.\[][\w-]+/g) || []).length;
  const tag = (sel.match(/(^|[\s>+~])[a-z][\w-]*/gi) || []).length;
  return ids * 10000 + cls * 100 + tag;
};

function buildCssModel(cssText) {
  const cssBoxLeftEm = {}; const cssListType = {}; const cssRules = []; const cssTiDeclared = new Set();
  // strip comments + @-rule bodies we don't want matching everything
  const clean = cssText.replace(/\/\*[\s\S]*?\*\//g, '');
  const ruleRe = /([^{}]+)\{([^}]*)\}/g; let m;
  while ((m = ruleRe.exec(clean))) {
    const selRaw = m[1].trim(); const decl = m[2].trim();
    if (!selRaw || selRaw.startsWith('@')) continue;
    for (const oneSel of selRaw.split(',')) {
      const sel = oneSel.trim(); if (!sel || sel === '*') continue;
      const rm = sel.split(/\s*[>+~\s]\s*/).filter(Boolean).pop() || '';
      const rmTag = (rm.match(/^[a-z][\w-]*/i) || [''])[0].toLowerCase();
      cssRules.push({ sel, decl, spec: specOf(sel), tag: rmTag });
      // class fast-path population — ONLY rightmost compound's classes (v21 over-attribution fix)
      const mE = sideLeftEm(decl, 'margin'); const pE = sideLeftEm(decl, 'padding');
      const tiM = /text-indent\s*:\s*([^;}]+)/i.exec(decl); const tiE = tiM ? lenToEm(tiM[1]) : null;
      const lstM = /list-style-type\s*:\s*([^;}]+)/i.exec(decl); const lst = lstM ? lstM[1].trim().toLowerCase() : null;
      for (const cm of rm.matchAll(/\.([A-Za-z0-9_-]+)/g)) {
        const c = cm[1];
        if (mE != null || pE != null || tiE != null) { const cur = cssBoxLeftEm[c] || { m: 0, p: 0, ti: 0 }; cssBoxLeftEm[c] = { m: mE ?? cur.m, p: pE ?? cur.p, ti: tiE ?? cur.ti }; if (tiE != null) cssTiDeclared.add(c); }
        if (lst) cssListType[c] = lst;
      }
    }
  }
  return { cssBoxLeftEm, cssListType, cssRules, cssTiDeclared };
}

function makeMatchers(model) {
  const { cssRules } = model;
  const matchSimple = (el, compound) => {
    const tagM = compound.match(/^[a-z][\w-]*/i); if (tagM && el.tagName.toLowerCase() !== tagM[0].toLowerCase()) return false;
    for (const cm of compound.matchAll(/\.([A-Za-z0-9_-]+)/g)) if (!(el.getAttribute('class') || '').split(/\s+/).includes(cm[1])) return false;
    for (const am of compound.matchAll(/\[([\w-]+)(?:([~]?=)"?([^"\]]*)"?)?\]/g)) {
      const v = el.getAttribute(am[1]); if (v == null) return false;
      if (am[2] === '=' && v !== am[3]) return false;
      if (am[2] === '~=' && !v.split(/\s+/).includes(am[3])) return false;
    }
    return true;
  };
  const selMatches = (el, sel) => {
    const parts = sel.split(/\s+/).filter(Boolean); // descendant only (good enough for our CSS)
    if (!matchSimple(el, parts[parts.length - 1])) return false;
    let anc = el.parentElement;
    for (let i = parts.length - 2; i >= 0; i--) {
      while (anc && !matchSimple(anc, parts[i])) anc = anc.parentElement;
      if (!anc) return false; anc = anc.parentElement;
    }
    return true;
  };
  const declProp = (el, prop) => {
    const hits = cssRules.filter(r => (!r.tag || r.tag === el.tagName.toLowerCase()) && selMatches(el, r.sel))
      .sort((a, b) => a.spec - b.spec);
    let val = null;
    for (const r of hits) { const dm = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`, 'i').exec(r.decl); if (dm) val = dm[1].trim(); }
    return val;
  };
  return { declProp };
}

function makeIndent(model, declProp) {
  const { cssBoxLeftEm } = model;
  const boxLeftEm = (el) => {
    const acc = { m: 0, p: 0, ti: 0 };
    for (const c of (el.getAttribute('class') || '').split(/\s+/)) { const b = cssBoxLeftEm[c]; if (b) { if (b.m) acc.m = b.m; if (b.p) acc.p = b.p; if (b.ti) acc.ti = b.ti; } }
    const leftOf = (prop) => {
      const explicit = declProp(el, `${prop}-left`); if (explicit != null) return lenToEm(explicit.replace(/!important/ig, ''));
      const sh = (declProp(el, prop) || '').replace(/!important/ig, '').trim(); if (!sh) return null;
      const q = sh.split(/\s+/); const l = q.length === 4 ? q[3] : q.length >= 2 ? q[1] : q[0]; return lenToEm(l);
    };
    if (!acc.m) { const dm = leftOf('margin'); if (dm != null) acc.m = dm; }
    if (!acc.p) { const dp = leftOf('padding'); if (dp != null) acc.p = dp; }
    if (!acc.ti) { const dti = declProp(el, 'text-indent'); if (dti != null) { const e = lenToEm(dti.replace(/!important/ig, '')); if (e != null) acc.ti = e; } }
    const s = el.style || {};
    if (s.marginLeft) { const e = lenToEm(s.marginLeft); if (e != null) acc.m = e; }
    if (s.paddingLeft) { const e = lenToEm(s.paddingLeft); if (e != null) acc.p = e; }
    if (s.textIndent) { const e = lenToEm(s.textIndent); if (e != null) acc.ti = e; }
    return acc;
  };
  const renderedIndentEm = (el) => {
    let em = 0; let node = el; let first = true;
    while (node) {
      const tag = node.tagName?.toLowerCase(); if (!tag || tag === 'body') break;
      if ((tag === 'ul' || tag === 'ol') && node.parentElement?.tagName.toLowerCase() !== 'li') break;
      const b = boxLeftEm(node); em += b.m + b.p;
      if ((tag === 'ul' || tag === 'ol') && b.p === 0) em += 2.5;
      if (first) { em += b.ti; first = false; }
      node = node.parentElement;
    }
    return Math.max(0, em);
  };
  return { renderedIndentEm };
}

const _roman = (n) => { const t = [[1000,'m'],[900,'cm'],[500,'d'],[400,'cd'],[100,'c'],[90,'xc'],[50,'l'],[40,'xl'],[10,'x'],[9,'ix'],[5,'v'],[4,'iv'],[1,'i']]; let s=''; for (const [v,sym] of t) while (n>=v){s+=sym;n-=v;} return s; };
function markerOf(el, declProp) {
  const parent = el.parentElement; if (!parent) return '';
  const tag = parent.tagName.toLowerCase();
  if (tag === 'ul') return '•';
  if (tag !== 'ol') return '';
  const items = Array.from(parent.children).filter(c => c.tagName.toLowerCase() === 'li');
  const v = el.getAttribute('value'); const st = parent.getAttribute('start');
  const n = (v && /^\d+$/.test(v)) ? parseInt(v,10) : items.indexOf(el) + (st && /^\d+$/.test(st) ? parseInt(st,10) : 1);
  const lst = (declProp(parent, 'list-style-type') || '').toLowerCase();
  if (lst.includes('lower-alpha') || lst.includes('lower-latin')) return String.fromCharCode(96 + ((n-1)%26) + 1);
  if (lst.includes('upper-alpha') || lst.includes('upper-latin')) return String.fromCharCode(64 + ((n-1)%26) + 1);
  if (lst.includes('lower-roman')) return _roman(n);
  if (lst.includes('upper-roman')) return _roman(n).toUpperCase();
  if (lst === 'none') return '';
  return `${n}`;
}

// ---- run over every EPUB ----
for (const epub of EPUBS) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'epubaudit-'));
  execSync(`cd "${dir}" && unzip -o -q "${epub}"`);
  const cssFiles = execSync(`find "${dir}" -name '*.css'`).toString().trim().split('\n').filter(Boolean);
  const cssText = cssFiles.map(f => fs.readFileSync(f, 'utf8')).join('\n');
  const model = buildCssModel(cssText);
  const { declProp } = makeMatchers(model);
  const { renderedIndentEm } = makeIndent(model, declProp);
  const htmlFiles = execSync(`find "${dir}" -name '*.html' -o -name '*.xhtml'`).toString().trim().split('\n').filter(Boolean);
  const rows = [];
  for (const hf of htmlFiles) {
    const raw = fs.readFileSync(hf, 'utf8');
    // The nav/TOC doc is parsed by the outline builder, NOT the body <li> handler — exclude it so we
    // audit only the list items the change actually reaches.
    if (/\b(nav|toc)\b/i.test(path.basename(hf)) || /epub:type=["'][^"']*\btoc\b|role=["']doc-toc["']|<nav\b/i.test(raw)) continue;
    const { document } = parseHTML(raw);
    for (const li of document.querySelectorAll('li')) {
      let depth = 0; for (let a = li.parentElement; a; a = a.parentElement) if (/^(ul|ol)$/.test(a.tagName.toLowerCase()) && a.parentElement?.tagName.toLowerCase() === 'li') depth++;
      // Replicate the real routing: an index <li> early-returns to the index handler (which ALREADY applies
      // renderedIndentEm) and an already-numbered <li> is left as-is — NEITHER reaches the ol/ul path my edit
      // touches. Only route==='ol'/'ul' items are the ones the change affects.
      const liClass = (li.getAttribute('class') || '').toLowerCase();
      let isIndex = liClass.includes('indexsub') || liClass.includes('indexmain');
      for (let a = li; a && !isIndex; a = a.parentElement) {
        const dt = (a.getAttribute('data-type') || '').toLowerCase(), cl = (a.getAttribute('class') || '').toLowerCase();
        const et = (a.getAttribute('epub:type') || a.getAttribute('type') || '').toLowerCase();
        if (dt === 'index' || et.includes('index') || /\bindex\b/.test(cl)) isIndex = true;
      }
      const trimmed = (li.textContent || '').replace(/\s+/g, ' ').trim();
      const alreadyMarked = /^\[?\s*[0-9ivxlcdm]{1,8}[.)\]]/i.test(trimmed);
      const pt = li.parentElement?.tagName.toLowerCase();
      const route = isIndex ? 'index' : alreadyMarked ? 'marked' : (pt === 'ol' || pt === 'ul') ? pt : 'block';
      const indentEm = renderedIndentEm(li);
      const nbsp = Math.round(indentEm / 0.375);
      const marker = markerOf(li, declProp);
      // A parent item that CONTAINS a nested sub-list is an EMIT-CHANGE site for the sub-list-separation fix
      // (its own text now emits as its own \n\n paragraph, sub-<li> recurse separately). Everything else is
      // byte-identical.
      const hasSub = Array.from(li.children).some(c => /^(ul|ol)$/.test(c.tagName.toLowerCase()));
      rows.push({ depth, route, hasSub, indentEm: +indentEm.toFixed(2), nbsp, marker, cls: li.getAttribute('class') || '', txt: trimmed.slice(0, 44) });
    }
  }
  // The change ONLY affects items on the ol/ul path with a non-zero indent.
  const touched = rows.filter(r => (r.route === 'ol' || r.route === 'ul') && r.nbsp > 0);
  const shown = onlyChanged ? touched : rows;
  const byRoute = {}; for (const r of rows) byRoute[r.route] = (byRoute[r.route]||0)+1;
  // Sub-list-separation emit-change sites: parents-with-sublist on the ol/ul path (NOT index, which already
  // separated). These are the ONLY items whose emitted paragraph structure changes.
  const emitChange = rows.filter(r => r.hasSub && (r.route === 'ol' || r.route === 'ul'));
  console.log(`\n===== ${path.basename(epub).slice(0, 40)} =====  (${rows.length} <li>)`);
  console.log('  route histogram:', JSON.stringify(byRoute), ' | indent-touch:', touched.length, '| sub-list-separation sites:', emitChange.length);
  for (const r of emitChange.slice(0, 12)) console.log(`  SUBLIST-PARENT ${r.route} d${r.depth} mk="${r.marker}" [${r.cls}] ${r.txt}`);
  for (const r of shown.slice(0, 40)) console.log(`  ${r.route} d${r.depth} ind=${r.indentEm}em nbsp=${r.nbsp} mk="${r.marker}" [${r.cls}] ${r.txt}`);
  if (shown.length > 40) console.log(`  … +${shown.length - 40} more`);
  fs.rmSync(dir, { recursive: true, force: true });
}
