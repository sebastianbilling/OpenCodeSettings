#!/usr/bin/env node
// find.mjs - fast lookups in the code index of all repos (built by tools/refresh.mjs).
//
//   node tools/find.mjs OrderService                classes, interfaces, enums, records by name
//   node tools/find.mjs OrdSerImpl                  ...also by the capitals of the name
//   node tools/find.mjs se.acme.order.OrderService  ...or by full name
//   node tools/find.mjs users OrderService          which files use it, per repo (other repos first)
//   node tools/find.mjs subtypes OrderService       what extends or implements it (--deep for all levels)
//   node tools/find.mjs method placeOrder           methods by name; place* for a prefix; add a class to narrow: method place* OrderService
//   node tools/find.mjs annotated Path /orders      classes and methods with an annotation (write it without @), optionally with text in its argument
//
// Options, after the rest: --repo <name> (only results in that repo), --limit <n> (default 25), --tests (include test code; off by default)
// For plain text search (strings, SQL, config keys) use the Grep tool instead.
import fs from 'node:fs';
import path from 'node:path';
import { GENERATED, parseArgs, readJson } from './lib/common.mjs';

const INDEX = path.join(GENERATED, 'index');
const { flags, positional } = parseArgs();
const limit = Number(flags.limit || 25);
const repoFilter = typeof flags.repo === 'string' ? flags.repo : null;
const withTests = !!flags.tests;

function help() {
  const lines = fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1);
  const end = lines.findIndex(l => !l.startsWith('//'));
  console.log(lines.slice(0, end).map(l => l.replace(/^\/\/ ?/, '')).join('\n'));
}

if (!positional.length || positional[0] === 'help') { help(); process.exit(0); }
if (!fs.existsSync(path.join(INDEX, 'types.tsv'))) {
  console.log('No code index yet. Run: node tools/refresh.mjs');
  process.exit(1);
}
const meta = readJson(path.join(INDEX, 'meta.json'), {});
const ageDays = meta.indexedAt ? (Date.now() - Date.parse(meta.indexedAt)) / 864e5 : 0;

// ------------------------------------------------------------------ loading
function* lines(file) {
  const text = fs.readFileSync(path.join(INDEX, file), 'utf8');
  let start = text.indexOf('\n') + 1;
  while (start < text.length) {
    let end = text.indexOf('\n', start);
    if (end < 0) end = text.length;
    if (end > start) yield text.slice(start, end);
    start = end + 1;
  }
}

const TYPE_COLS = ['fqn', 'name', 'kind', 'repo', 'file', 'line', 'mods', 'extends', 'implements', 'annotations', 'usedByFiles', 'usedByRepos', 'doc'];
const MEMBER_COLS = ['type', 'name', 'kind', 'repo', 'file', 'line', 'mods', 'signature', 'annotations'];
const toObj = (cols, line) => { const v = line.split('\t'); const o = {}; cols.forEach((c, i) => { o[c] = v[i] ?? ''; }); return o; };
const isTest = f => /(^|\/)(src\/test|src\/integrationTest|src\/testFixtures|test|tests)\//i.test(f) && !/src\/main\//.test(f);
const keep = o => (!repoFilter || o.repo === repoFilter) && (withTests || !isTest(o.file));

let typesCache = null;
function types() {
  if (!typesCache) typesCache = [...lines('types.tsv')].map(l => toObj(TYPE_COLS, l));
  return typesCache;
}

const where = o => `repos/${o.repo}/${o.file}:${o.line}`;
const simple = s => String(s).split('.').pop();

function showType(t) {
  const used = Number(t.usedByFiles);
  const others = t.usedByRepos ? t.usedByRepos.split(',').filter(Boolean) : [];
  let s = `${t.name}  ${t.kind}  ${where(t)}  used in ${used} file${used === 1 ? '' : 's'}`;
  if (others.length) s += ` (also in ${others.length} other repo${others.length === 1 ? '' : 's'}: ${others.slice(0, 6).join(', ')}${others.length > 6 ? ', ...' : ''})`;
  if (t.extends) s += `  extends ${t.extends}`;
  if (t.implements) s += `  implements ${t.implements.split(',').join(', ')}`;
  if (t.annotations) s += `  ${t.annotations.split(';').join(' ')}`;
  if (t.doc) s += `\n    "${t.doc}"`;
  return s;
}

function printList(items, fmt, what) {
  if (!items.length) return false;
  items.slice(0, limit).forEach(i => console.log(fmt(i)));
  if (items.length > limit) console.log(`... ${items.length - limit} more ${what}. Narrow it with --repo <name>, or raise --limit.`);
  return true;
}

const byUse = (a, b) => Number(b.usedByFiles) - Number(a.usedByFiles) || a.fqn.localeCompare(b.fqn);

function humpRegex(q) {
  const parts = q.match(/[A-Z][a-z0-9_]*|[a-z0-9_]+/g) || [q];
  const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp('^' + parts.map(p => esc(p) + '[a-z0-9_]*').join(''));
}

/** Types matching a name, best tier first: exact, full name, starts with, contains, capitals. */
function findTypes(q, { quiet = false, filtered = true } = {}) {
  const all = filtered ? types().filter(keep) : types();
  const ql = q.toLowerCase();
  const tiers = [
    ['exact name', t => t.name.toLowerCase() === ql],
    ['full name', t => t.fqn.toLowerCase() === ql || t.fqn.toLowerCase().endsWith('.' + ql)],
    ['name starts with', t => t.name.toLowerCase().startsWith(ql)],
    ['name contains', t => t.name.toLowerCase().includes(ql)],
    ['capitals match', (() => { const re = humpRegex(q); return t => re.test(t.name); })()]
  ];
  for (const [label, test] of tiers) {
    const hits = all.filter(test).sort(byUse);
    if (hits.length) {
      if (!quiet && label !== 'exact name') console.log(`(no exact match; showing: ${label} "${q}")`);
      return hits;
    }
  }
  return [];
}

/** Pick one type for users/subtypes. */
function pickType(q) {
  // Look the class up everywhere; --repo and --tests only filter the results.
  const hits = findTypes(q, { quiet: true, filtered: false });
  if (!hits.length) return null;
  const exact = hits.filter(t => t.name.toLowerCase() === q.toLowerCase() || t.fqn.toLowerCase() === q.toLowerCase());
  const pool = exact.length ? exact : hits;
  const fqns = [...new Set(pool.map(t => t.fqn))];
  if (fqns.length > 1) {
    console.log(`"${q}" matches ${fqns.length} classes; using the most used one. Pass the full name to pick another:`);
    fqns.slice(0, 8).forEach(f => console.log(`    ${f}`));
    console.log('');
  }
  return pool[0];
}

// ------------------------------------------------------------------ commands
const [cmd, ...rest] = positional;
let found = false;

if (cmd === 'users') {
  const t = pickType(rest[0] || '');
  if (!t) console.log(`No class named "${rest[0]}".`);
  else {
    const prefix = t.fqn + '\t';
    const byRepo = {};
    for (const l of lines('refs.tsv')) {
      if (!l.startsWith(prefix)) continue;
      const [, repo, file] = l.split('\t');
      if (repoFilter && repo !== repoFilter) continue;
      if (!withTests && isTest(file)) continue;
      (byRepo[repo] ||= new Set()).add(file);
    }
    const repos = Object.keys(byRepo).sort((a, b) => (a === t.repo) - (b === t.repo) || byRepo[b].size - byRepo[a].size);
    const total = repos.reduce((n, r) => n + byRepo[r].size, 0);
    console.log(`${t.fqn} (${where(t)}) is used in ${total} file${total === 1 ? '' : 's'}${withTests ? '' : ' of main code (add --tests to include tests)'}:`);
    let shown = 0;
    for (const r of repos) {
      const files = [...byRepo[r]].sort();
      console.log(`  ${r}${r === t.repo ? ' (its own repo)' : ''}: ${files.length} file${files.length === 1 ? '' : 's'}`);
      for (const f of files) {
        if (shown >= limit) break;
        console.log(`    repos/${r}/${f}`);
        shown++;
      }
    }
    if (shown < total) console.log(`... ${total - shown} more files not listed. Use --repo <name> to see one repo, or raise --limit.`);
    found = true;
  }
} else if (cmd === 'subtypes') {
  const t = pickType(rest[0] || '');
  if (!t) console.log(`No class named "${rest[0]}".`);
  else {
    const all = types();
    const out = [];
    const seen = new Set([t.fqn]);
    let frontier = [t];
    let depth = 0;
    while (frontier.length && (depth === 0 || flags.deep) && depth < 10) {
      const next = [];
      for (const parent of frontier) {
        for (const c of all) {
          if (seen.has(c.fqn)) continue;
          const supers = [c.extends, ...c.implements.split(',')].filter(Boolean);
          if (supers.some(s => s === parent.fqn || simple(s) === parent.name)) {
            seen.add(c.fqn);
            next.push(c);
            if (keep(c)) out.push({ ...c, depth });
          }
        }
      }
      frontier = next;
      depth++;
    }
    console.log(`Classes that extend or implement ${t.fqn}${flags.deep ? ' (all levels)' : ' (direct only; --deep for all levels)'}:`);
    found = printList(out.sort(byUse), c => `${'  '.repeat(c.depth)}${showType(c)}`, 'classes');
    if (!found) console.log('  (none found)');
    found = true;
  }
} else if (cmd === 'method') {
  const name = (rest[0] || '').toLowerCase();
  const owner = rest[1];
  const ownerFqns = owner ? new Set(findTypes(owner, { quiet: true, filtered: false }).map(t => t.fqn)) : null;
  const wildcard = name.endsWith('*');
  const stem = wildcard ? name.slice(0, -1) : name;
  const hits = [];
  for (const l of lines('members.tsv')) {
    const tab1 = l.indexOf('\t'), tab2 = l.indexOf('\t', tab1 + 1);
    const n = l.slice(tab1 + 1, tab2).toLowerCase();
    if (wildcard ? !n.startsWith(stem) : n !== stem) continue;
    const m = toObj(MEMBER_COLS, l);
    if (!keep(m)) continue;
    if (ownerFqns && !ownerFqns.has(m.type)) continue;
    hits.push(m);
  }
  found = printList(hits, m => `${simple(m.type)}.${m.signature}  ${m.mods}  ${where(m)}${m.annotations ? '  ' + m.annotations.split(';').join(' ') : ''}`, 'methods');
  if (!found) console.log(`No method named "${rest[0]}"${owner ? ' in ' + owner : ''}. Try a wildcard: method ${stem}*`);
  found = true;
} else if (cmd === 'annotated') {
  const ann = '@' + String(rest[0] || '').replace(/^@/, '').toLowerCase();
  const text = (rest[1] || '').toLowerCase();
  const matches = a => a.split(';').some(x => {
    const lx = x.toLowerCase();
    return (lx === ann || lx.startsWith(ann + '(')) && (!text || lx.includes(text));
  });
  const out = [];
  for (const t of types()) if (t.annotations && keep(t) && matches(t.annotations)) out.push(showType(t));
  for (const l of lines('members.tsv')) {
    if (!l.toLowerCase().includes(ann)) continue;
    const m = toObj(MEMBER_COLS, l);
    if (keep(m) && m.annotations && matches(m.annotations)) out.push(`${simple(m.type)}.${m.signature}  ${where(m)}  ${m.annotations.split(';').join(' ')}`);
  }
  found = printList(out, x => x, 'results');
  if (!found) console.log(`Nothing annotated with ${ann}${text ? ' containing "' + text + '"' : ''}.`);
  found = true;
} else {
  const q = [cmd, ...rest].join(' ').trim();
  const hits = findTypes(q);
  found = printList(hits, showType, 'classes');
  if (!found) console.log(`No class, interface, enum or record matching "${q}"${repoFilter ? ' in ' + repoFilter : ''}${withTests ? '' : ' (test code excluded; add --tests)'}. For text inside files, use the Grep tool.`);
}

if (ageDays > 7) console.log(`\nNote: the index is ${Math.floor(ageDays)} days old. Run node tools/refresh.mjs for fresh results.`);
