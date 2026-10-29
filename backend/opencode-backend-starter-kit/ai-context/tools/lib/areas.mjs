// Splits each repo into "areas" (a module, or a group of packages) and writes, per area,
// the facts a script can find: entry points, a likely reading order, data, integrations,
// configuration keys and business-rule hints. The surveyor agent turns these into area notes.
//
//   generated/areas/<repo>/<area>.md   facts per area (scripts only)
//   generated/areas/<repo>/areas.json  the split, used by tools/map-areas.mjs
//   context/areas/<repo>/README.md     index of the areas, with the notes that exist
//
// A team can choose the split of a repo itself in context/areas/<repo>/split.txt, one area per line:
//   billing: se.acme.billing, se.acme.invoice
//   batch: batch-jobs/            (a folder in the repo; ends with / or contains /)
import fs from 'node:fs';
import path from 'node:path';
import { CONTEXT, GENERATED, REPOS_DIR, git, num, readText, today, writeText } from './common.mjs';

const INDEX = path.join(GENERATED, 'index');
const MIN_AREA = 15;      // packages with fewer main files are merged into a neighbour group
const MAX_AREA = 350;     // groups with more main files are split one level deeper
const MAX_AREAS = 15;     // per repo
const SMALL_REPO = 80;    // repos with fewer main files are one area

export const areaNotesDir = repo => path.join(CONTEXT, 'areas', repo);
export const areaFactsDir = repo => path.join(GENERATED, 'areas', repo);

// ------------------------------------------------------------------ loading the index

function* tsv(file) {
  const text = readText(path.join(INDEX, file));
  if (!text) return;
  const nl = text.indexOf('\n');
  const head = text.slice(0, nl).split('\t');
  let start = nl + 1;
  while (start < text.length) {
    let end = text.indexOf('\n', start);
    if (end < 0) end = text.length;
    if (end > start) {
      const v = text.slice(start, end).split('\t');
      const o = {};
      for (let i = 0; i < head.length; i++) o[head[i]] = v[i] ?? '';
      yield o;
    }
    start = end + 1;
  }
}

const isTestFile = f => f.test === '1';

/** Everything the area code needs, loaded once. */
export function loadIndex() {
  if (!fs.existsSync(path.join(INDEX, 'files.tsv'))) return null;
  const files = new Map();          // repo\tfile -> file row
  const filesByRepo = new Map();    // repo -> [file rows]
  for (const f of tsv('files.tsv')) {
    f.lines = Number(f.lines) || 0;
    f.sql = f.sqlTables ? f.sqlTables.split(',').map(x => { const i = x.lastIndexOf(':'); return [x.slice(0, i), Number(x.slice(i + 1)) || 1]; }) : [];
    f.integ = f.integrations ? f.integrations.split(',') : [];
    f.keys = f.configKeys ? f.configKeys.split(',') : [];
    f.urlList = f.urls ? f.urls.split(',') : [];
    files.set(f.repo + '\t' + f.file, f);
    if (!filesByRepo.has(f.repo)) filesByRepo.set(f.repo, []);
    filesByRepo.get(f.repo).push(f);
  }
  const types = new Map();          // fqn -> [type rows] (same name can exist twice)
  const typesByFile = new Map();
  for (const t of tsv('types.tsv')) {
    t.used = Number(t.usedByFiles) || 0;
    t.anns = t.annotations ? t.annotations.split(';') : [];
    if (!types.has(t.fqn)) types.set(t.fqn, []);
    types.get(t.fqn).push(t);
    const k = t.repo + '\t' + t.file;
    if (!typesByFile.has(k)) typesByFile.set(k, []);
    typesByFile.get(k).push(t);
  }
  const membersByFile = new Map();
  for (const m of tsv('members.tsv')) {
    if (!m.annotations && m.name !== 'main') continue; // only what entry points need
    m.anns = m.annotations ? m.annotations.split(';') : [];
    const k = m.repo + '\t' + m.file;
    if (!membersByFile.has(k)) membersByFile.set(k, []);
    membersByFile.get(k).push(m);
  }
  const refsByFile = new Map();     // repo\tfile -> [fqn]
  const usersOf = new Map();        // fqn -> [repo\tfile]
  for (const r of tsv('refs.tsv')) {
    const k = r.repo + '\t' + r.file;
    if (!refsByFile.has(k)) refsByFile.set(k, []);
    refsByFile.get(k).push(r.fqn);
    if (!usersOf.has(r.fqn)) usersOf.set(r.fqn, []);
    usersOf.get(r.fqn).push(k);
  }
  const enumsByFile = new Map();
  for (const e of tsv('enums.tsv')) {
    const k = e.repo + '\t' + e.file;
    if (!enumsByFile.has(k)) enumsByFile.set(k, []);
    enumsByFile.get(k).push(e);
  }
  const throwsByFile = new Map();
  for (const t of tsv('throws.tsv')) {
    const k = t.repo + '\t' + t.file;
    if (!throwsByFile.has(k)) throwsByFile.set(k, []);
    throwsByFile.get(k).push(t);
  }
  return { files, filesByRepo, types, typesByFile, membersByFile, refsByFile, usersOf, enumsByFile, throwsByFile };
}

// ------------------------------------------------------------------ splitting a repo into areas

const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'area';

function commonPackage(pkgs) {
  const list = [...new Set(pkgs.filter(Boolean))].sort();
  if (!list.length) return '';
  const a = list[0].split('.'), b = list[list.length - 1].split('.');
  const out = [];
  for (let i = 0; i < Math.min(a.length, b.length) && a[i] === b[i]; i++) out.push(a[i]);
  return out.join('.');
}

/** Groups files by package below their common root. Returns [{name, prefixes:[{pkg, deep}], files}] */
function splitByPackage(files, depth = 0) {
  let root = commonPackage(files.map(f => f.pkg));
  const groupOf = (f, r) => {
    if (!f.pkg || f.pkg === r) return null; // directly in the root package
    const rest = r ? f.pkg.slice(r.length + 1) : f.pkg;
    return rest.split('.')[0];
  };
  // Descend while everything sits in one sub-package (com.acme.order.x.* -> com.acme.order.x).
  for (let i = 0; i < 6; i++) {
    const gs = new Set(files.map(f => groupOf(f, root)));
    if (gs.size === 1 && !gs.has(null)) root = root ? `${root}.${[...gs][0]}` : [...gs][0];
    else break;
  }
  const groups = new Map();
  for (const f of files) {
    const g = groupOf(f, root);
    const key = g === null ? '' : g;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(f);
  }
  let result = [];
  const rootName = root ? root.split('.').pop() : 'default';
  for (const [g, fs_] of groups) {
    const pkg = g === '' ? root : (root ? `${root}.${g}` : g);
    if (g !== '' && fs_.length > MAX_AREA && depth < 2) {
      const sub = splitByPackage(fs_, depth + 1);
      if (sub.length > 1) { result.push(...sub.map(s => ({ ...s, name: s.name === g || s.name === 'misc' ? `${g}${s.name === 'misc' ? '-misc' : ''}` : `${g}-${s.name}` }))); continue; }
    }
    result.push({ name: g === '' ? rootName : g, prefixes: [{ pkg, deep: g !== '' }], files: fs_ });
  }
  // Merge small groups into one "misc" group (or into the root group).
  const small = result.filter(r => r.files.length < MIN_AREA);
  if (small.length && result.length > 1) {
    result = result.filter(r => r.files.length >= MIN_AREA);
    const merged = { name: 'misc', prefixes: small.flatMap(s => s.prefixes), files: small.flatMap(s => s.files) };
    if (!result.length) return [{ ...merged, name: rootName }];
    if (small.length === 1) merged.name = small[0].name;
    result.push(merged);
  }
  return result;
}

function readSplitFile(repo) {
  const text = readText(path.join(areaNotesDir(repo), 'split.txt'));
  if (!text.trim()) return null;
  const rules = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.replace(/#.*$/, '').match(/^\s*([^:]+):\s*(.+)$/);
    if (!m) continue;
    const parts = m[2].split(',').map(s => s.trim()).filter(Boolean);
    rules.push({ name: slug(m[1]), paths: parts.filter(p => p.includes('/')).map(p => p.replace(/\\/g, '/').replace(/\/?$/, '/')), pkgs: parts.filter(p => !p.includes('/')) });
  }
  return rules.length ? rules : null;
}

/** The areas of one repo. Each: {name, module, prefixes, files (main), lines, why} */
export function computeAreas(repo, idx, deps) {
  const all = (idx.filesByRepo.get(repo) || []);
  const main = all.filter(f => !isTestFile(f));
  if (!main.length) return [];
  const finish = list => {
    const used = new Set();
    return list.filter(a => a.files.length).map(a => {
      let name = slug(a.name), n = 2;
      while (used.has(name)) name = `${slug(a.name)}-${n++}`;
      used.add(name);
      return { ...a, name, lines: a.files.reduce((s, f) => s + f.lines, 0) };
    });
  };

  const rules = readSplitFile(repo);
  if (rules) {
    const areas = rules.map(r => ({ name: r.name, module: '', prefixes: r.pkgs.map(pkg => ({ pkg, deep: true })), paths: r.paths, files: [], why: 'chosen in split.txt' }));
    const other = { name: 'other', module: '', prefixes: [], files: [], why: 'not covered by split.txt' };
    for (const f of main) {
      const a = areas.find(x => x.paths.some(p => f.file.startsWith(p)) || x.prefixes.some(p => f.pkg === p.pkg || f.pkg.startsWith(p.pkg + '.')));
      (a || other).files.push(f);
    }
    return finish([...areas, other]);
  }

  if (main.length < SMALL_REPO) return finish([{ name: repo, module: '', prefixes: [], files: main, why: `small repo (${main.length} main files): one area` }]);

  // Modules from the build (longest folder wins).
  const modDirs = [...new Set((deps?.projects || []).map(p => (p.dir || '').replace(/\\/g, '/').replace(/\/$/, '')))].sort((a, b) => b.length - a.length);
  const moduleOf = f => modDirs.find(d => d === '' || f.file.startsWith(d + '/')) ?? '';
  const byModule = new Map();
  for (const f of main) {
    const m = moduleOf(f);
    if (!byModule.has(m)) byModule.set(m, []);
    byModule.get(m).push(f);
  }
  let areas = [];
  if (byModule.size >= 2) {
    const tiny = [];
    for (const [m, fs_] of [...byModule].sort()) {
      const mname = m ? m.split('/').pop() : repo;
      const prefix = mname === repo ? '' : `${mname}-`;
      if (fs_.length < MIN_AREA) { tiny.push([m, fs_]); continue; }
      if (fs_.length > MAX_AREA) {
        const parts = splitByPackage(fs_);
        if (parts.length > 1) { areas.push(...parts.map(p => ({ ...p, name: `${prefix}${p.name}`, module: m, why: `part of module ${m || '(root)'}` }))); continue; }
      }
      areas.push({ name: mname, module: m, prefixes: [], files: fs_, why: `module ${m || '(root)'}` });
    }
    if (tiny.length === 1) areas.push({ name: tiny[0][0].split('/').pop() || repo, module: tiny[0][0], prefixes: [], files: tiny[0][1], why: `module ${tiny[0][0]}` });
    else if (tiny.length) areas.push({ name: 'small-modules', module: '', modules: tiny.map(t => t[0]), prefixes: [], files: tiny.flatMap(t => t[1]), why: `small modules: ${tiny.map(t => t[0] || '(root)').join(', ')}` });
  } else {
    areas = splitByPackage(main).map(p => ({ ...p, module: [...byModule.keys()][0] || '', why: 'package group' }));
  }
  // Keep the number of areas readable: move the smallest into one "other" area.
  areas.sort((a, b) => b.files.length - a.files.length);
  if (areas.length > MAX_AREAS) {
    const keep = areas.slice(0, MAX_AREAS - 1), rest = areas.slice(MAX_AREAS - 1);
    keep.push({ name: 'other', module: '', prefixes: rest.flatMap(r => r.prefixes), modules: rest.map(r => r.module).filter(Boolean),
      files: rest.flatMap(r => r.files), why: `the ${rest.length} smallest groups: ${rest.map(r => r.name).join(', ')}` });
    areas = keep;
  }
  return finish(areas);
}

/** Git pathspecs for an area: one per folder, without subfolders (they may belong to other areas). */
function pathspecs(area) {
  const dirs = [...new Set(area.files.map(f => path.posix.dirname(f.file)))].sort();
  if (dirs.length <= 150) return dirs.map(d => `:(glob)${d}/*`);
  const top = [...new Set(dirs.map(d => d.split('/').slice(0, 6).join('/')))];
  return top.slice(0, 150);
}

function describe(area) {
  if (area.why?.startsWith('module') || area.why?.startsWith('small modules') || area.why?.startsWith('the ')) return area.why;
  const pk = area.prefixes.map(p => (p.deep ? `${p.pkg}.*` : `${p.pkg} (only this package)`));
  const where = area.module ? `module ${area.module}: ` : '';
  if (pk.length) return where + pk.slice(0, 6).join(', ') + (pk.length > 6 ? ', ...' : '');
  return area.why || '';
}

// ------------------------------------------------------------------ facts per area

const ROLE = /(Service|Manager|Facade|Handler|Processor|Controller|Resource|Endpoint|Listener|Consumer|Producer|Publisher|Job|Task|Dao|DAO|Repository|Repo|Mapper|Store|Client|Gateway|Adapter|Validator|Calculator|Rule|Rules|Policy|Engine|Factory|Builder|Converter|Helper|Util|Utils)(Impl|Bean)?$/;
const RULE_CLASS = /(Validator|Validation|Rule|Rules|Policy|Policies|Calculator|Checker|Check|Specification|Strategy|Constraint|Guard|Eligibility|Decision|Evaluator)(Impl)?$/;
const DATA_CLASS = /(Dao|DAO|Repository|Repo|Mapper|Store|Persister|Finder)(Impl)?$/;
const HTTP_JAXRS = ['@GET', '@POST', '@PUT', '@DELETE', '@PATCH', '@HEAD', '@OPTIONS'];
const HTTP_SPRING = { '@GetMapping': 'GET', '@PostMapping': 'POST', '@PutMapping': 'PUT', '@DeleteMapping': 'DELETE', '@PatchMapping': 'PATCH', '@RequestMapping': 'ANY' };
const LISTENERS = ['@JmsListener', '@KafkaListener', '@RabbitListener', '@SqsListener', '@StreamListener', '@Incoming', '@ServiceActivator'];
const SCHEDULED = ['@Scheduled', '@Schedule', '@Schedules'];
const EVENTS = ['@EventListener', '@TransactionalEventListener', '@Subscribe'];

const annName = a => (a.includes('(') ? a.slice(0, a.indexOf('(')) : a);
const annArg = a => { const m = a.match(/^@\w+\("(.*)"\)$/); return m ? m[1] : ''; };
const findAnn = (anns, names) => anns.find(a => names.includes(annName(a)));
const joinPath = (a, b) => ('/' + [a, b].filter(Boolean).join('/')).replace(/\/+/g, '/').replace(/(.)\/$/, '$1');
const short = fqn => String(fqn).split('.').pop();
const cell = s => String(s ?? '').replace(/\|/g, '/').replace(/\s+/g, ' ').trim();

function entryPoints(area, repo, idx) {
  const out = []; // {kind, text, type, file, line}
  for (const f of area.files) {
    const k = repo + '\t' + f.file;
    const types = idx.typesByFile.get(k) || [];
    const members = idx.membersByFile.get(k) || [];
    for (const t of types) {
      const classPath = annArg(findAnn(t.anns, ['@Path', '@RequestMapping']) || '');
      const tAnnNames = t.anns.map(annName);
      for (const m of members.filter(x => x.type === t.fqn)) {
        const jax = m.anns.find(a => HTTP_JAXRS.includes(annName(a)));
        const spring = m.anns.find(a => HTTP_SPRING[annName(a)]);
        const loc = { type: t.fqn, file: f.file, line: m.line };
        if (jax) out.push({ kind: 'HTTP', text: `${annName(jax).slice(1)} ${joinPath(classPath, annArg(findAnn(m.anns, ['@Path']) || ''))} -> ${t.name}.${m.name}`, ...loc });
        else if (spring) out.push({ kind: 'HTTP', text: `${HTTP_SPRING[annName(spring)]} ${joinPath(classPath, annArg(spring))} -> ${t.name}.${m.name}`, ...loc });
        const lis = m.anns.find(a => LISTENERS.includes(annName(a)));
        if (lis) out.push({ kind: 'Messages', text: `${t.name}.${m.name} listens to ${annArg(lis) ? '"' + annArg(lis) + '"' : '(see annotation)'} (${annName(lis)})`, ...loc });
        const sch = m.anns.find(a => SCHEDULED.includes(annName(a)));
        if (sch) out.push({ kind: 'Scheduled', text: `${t.name}.${m.name} ${annArg(sch) ? 'runs on "' + annArg(sch) + '"' : 'runs on a schedule'} (${annName(sch)})`, ...loc });
        const ev = m.anns.find(a => EVENTS.includes(annName(a)));
        if (ev) out.push({ kind: 'Events', text: `${t.name}.${m.name} handles events (${annName(ev)})`, ...loc });
        if (m.anns.some(a => annName(a) === '@WebMethod')) out.push({ kind: 'SOAP', text: `${t.name}.${m.name} (@WebMethod)`, ...loc });
        if (m.name === 'main' && /\bstatic\b/.test(m.mods) && /^main\(String(\[\]|\.\.\.)/.test(m.signature)) out.push({ kind: 'Program start', text: `${t.name}.main`, ...loc });
      }
      const loc = { type: t.fqn, file: f.file, line: t.line };
      if (tAnnNames.includes('@MessageDriven') || (t.implements.split(',').includes('MessageListener') && f.integ.includes('JMS'))) out.push({ kind: 'Messages', text: `${t.name} (message-driven: onMessage)`, ...loc });
      if (/HttpServlet$/.test(t.extends) || tAnnNames.includes('@WebServlet')) out.push({ kind: 'HTTP', text: `${t.name} (servlet${annArg(findAnn(t.anns, ['@WebServlet']) || '') ? ' ' + annArg(findAnn(t.anns, ['@WebServlet'])) : ''})`, ...loc });
      if (tAnnNames.includes('@WebService')) out.push({ kind: 'SOAP', text: `${t.name} (@WebService)`, ...loc });
      if ((t.implements.split(',').some(i => i === 'Job' || i === 'StatefulJob') && f.integ.includes('Quartz')) || /QuartzJobBean$/.test(t.extends)) out.push({ kind: 'Scheduled', text: `${t.name} (Quartz job)`, ...loc });
      if (t.implements.split(',').some(i => ['Tasklet', 'ItemReader', 'ItemProcessor', 'ItemWriter'].includes(i)) && f.integ.includes('Spring Batch')) out.push({ kind: 'Batch', text: `${t.name} (Spring Batch ${t.implements.split(',').find(i => ['Tasklet', 'ItemReader', 'ItemProcessor', 'ItemWriter'].includes(i))})`, ...loc });
      if (tAnnNames.some(a => ['@Stateless', '@Stateful', '@Singleton'].includes(a)) && f.integ.includes('EJB')) out.push({ kind: 'EJB', text: `${t.name} (${tAnnNames.find(a => ['@Stateless', '@Stateful', '@Singleton'].includes(a))} session bean)`, ...loc });
    }
  }
  return out;
}

export function writeAreaFacts(repo, areas, idx, allAreasByFile) {
  const dir = areaFactsDir(repo);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const repoDir = path.join(REPOS_DIR, repo);
  const sha = git(repoDir, ['rev-parse', '--short', 'HEAD']);
  const areaOfKey = k => allAreasByFile.get(k) || null; // "repo\tarea"
  const allTests = (idx.filesByRepo.get(repo) || []).filter(isTestFile);

  for (const area of areas) {
    const L = [];
    const keys = new Set(area.files.map(f => repo + '\t' + f.file));
    const typesIn = area.files.flatMap(f => idx.typesByFile.get(repo + '\t' + f.file) || []);
    const typeInfo = fqn => (idx.types.get(fqn) || []).find(t => t.repo === repo) || (idx.types.get(fqn) || [])[0];
    const fileOfType = fqn => { const t = typeInfo(fqn); return t ? repo + '\t' + t.file : null; };

    L.push(`# Area facts: ${repo} / ${area.name}`, '');
    L.push(`Generated by tools/refresh.mjs on ${today()}${sha ? ` from commit ${sha}` : ''}. Counted by scripts, not written by an AI. "Uses" below means "refers to in the code"; it is not proof of a call.`, '');

    // ---- scope
    L.push('## What is in this area', '');
    L.push(`- Covers: ${describe(area)}`);
    const pk = new Map();
    for (const f of area.files) pk.set(f.pkg, (pk.get(f.pkg) || 0) + 1);
    L.push(`- Main code: ${num(area.files.length)} files, ${num(area.lines)} lines, in ${pk.size} package${pk.size === 1 ? '' : 's'}: ${[...pk].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([p, n]) => `${p || '(default)'} ${n}`).join(', ')}${pk.size > 12 ? ', ...' : ''}`);
    const pkgSet = new Set(pk.keys());
    const tests = allTests.filter(t => pkgSet.has(t.pkg) && (!area.module || t.file.startsWith(area.module + '/')));
    L.push(`- Tests in the same packages: ${tests.length} files${tests.length ? ', e.g. ' + tests.slice(0, 4).map(t => path.posix.basename(t.file)).join(', ') : ''}`);
    L.push('');

    // ---- entry points
    const eps = entryPoints(area, repo, idx);
    L.push('## Entry points', '', 'Where work starts in this area: HTTP calls, messages, schedules, events, program starts.', '');
    if (!eps.length) L.push('- None found. Code here is probably called by other areas or repos (see "Most used classes"). In-house frameworks may use annotations this script does not know: see "Annotations in this area".');
    const byKind = new Map();
    for (const e of eps) { if (!byKind.has(e.kind)) byKind.set(e.kind, []); byKind.get(e.kind).push(e); }
    for (const [kind, list] of byKind) {
      L.push(`- ${kind} (${list.length}):`);
      list.slice(0, 25).forEach(e => L.push(`    - ${e.text} (${e.file}:${e.line})`));
      if (list.length > 25) L.push(`    - ... ${list.length - 25} more`);
    }
    L.push('');

    // ---- reading order trees
    const usesOf = key => [...new Set(idx.refsByFile.get(key) || [])]
      .map(fqn => ({ fqn, t: typeInfo(fqn) }))
      .filter(x => x.t && x.t.repo === repo && !/(^|\/)(src\/test|test|tests)\//.test(x.t.file));
    const rank = x => (ROLE.test(x.t.name) ? 0 : 1) * 10 + (keys.has(repo + '\t' + x.t.file) ? 0 : 1);
    const tag = t => {
      const bits = [];
      const tf = idx.files.get(repo + '\t' + t.file);
      const ent = t.anns.find(a => ['@Entity', '@Table', '@Document'].includes(annName(a)));
      const tbl = annArg(t.anns.find(a => annName(a) === '@Table') || '');
      if (ent) bits.push(`entity${tbl ? ' -> table ' + tbl : ''}`);
      if (tf?.sql.length) bits.push('SQL: ' + tf.sql.slice(0, 4).map(s => s[0]).join(', '));
      const integ = (tf?.integ || []).filter(i => !['JPA', 'REST endpoint', 'Servlet', 'EJB', 'XML binding'].includes(i));
      if (integ.length) bits.push(integ.join(', '));
      const ak = areaOfKey(repo + '\t' + t.file);
      if (ak && ak !== repo + '\t' + area.name) bits.push(`in area ${ak.split('\t')[1]}`);
      return bits.length ? `  [${bits.join('; ')}]` : '';
    };
    const roots = [];
    const seenRoot = new Set();
    for (const e of eps) { if (!seenRoot.has(e.type)) { seenRoot.add(e.type); roots.push(e.type); } }
    const mostUsed = typesIn.slice().sort((a, b) => b.used - a.used);
    if (!roots.length) mostUsed.slice(0, 5).forEach(t => roots.push(t.fqn));
    L.push('## Likely reading order', '', eps.length
      ? 'From each entry point, the classes of this repo it uses, two levels deep. Read the code in this order to follow a flow.'
      : 'No entry points here, so this starts from the most used classes of the area.', '');
    const expanded = new Set();
    for (const fqn of roots.slice(0, 8)) {
      const t = typeInfo(fqn);
      if (!t) continue;
      L.push(`- ${t.name} (${t.file})${tag(t)}`);
      expanded.add(fqn);
      const lvl1 = usesOf(repo + '\t' + t.file).filter(x => x.fqn !== fqn).sort((a, b) => rank(a) - rank(b) || a.t.name.localeCompare(b.t.name)).slice(0, 8);
      for (const c of lvl1) {
        if (expanded.has(c.fqn)) { L.push(`    - ${c.t.name} (see above)`); continue; }
        expanded.add(c.fqn);
        L.push(`    - ${c.t.name}${tag(c.t)}`);
        const lvl2 = usesOf(repo + '\t' + c.t.file).filter(x => x.fqn !== c.fqn && x.fqn !== fqn).sort((a, b) => rank(a) - rank(b) || a.t.name.localeCompare(b.t.name)).slice(0, 5);
        for (const d of lvl2) L.push(`        - ${d.t.name}${expanded.has(d.fqn) ? '' : tag(d.t)}`);
      }
    }
    if (roots.length > 8) L.push(`- ... ${roots.length - 8} more entry classes`);
    L.push('');

    // ---- most used classes, split by where they are used
    L.push('## Most used classes in this area', '', '| Class | Kind | Used in: this area / other areas / other repos | Javadoc summary |', '| --- | --- | --- | --- |');
    for (const t of mostUsed.slice(0, 15)) {
      let inArea = 0, otherArea = 0, otherRepo = 0;
      for (const k of idx.usersOf.get(t.fqn) || []) {
        const uf = idx.files.get(k);
        if (!uf || isTestFile(uf)) continue;
        if (uf.repo !== repo) otherRepo++;
        else if (keys.has(k)) inArea++;
        else otherArea++;
      }
      L.push(`| ${t.name} | ${t.kind} | ${inArea} / ${otherArea} / ${otherRepo} | ${cell(t.doc)} |`);
    }
    L.push('');

    // ---- data
    L.push('## Data', '');
    const entities = typesIn.filter(t => t.anns.some(a => ['@Entity', '@Table', '@MappedSuperclass', '@Embeddable', '@Document'].includes(annName(a))));
    if (entities.length) {
      L.push(`- Entities (${entities.length}): ` + entities.slice(0, 30).map(t => {
        const tbl = annArg(t.anns.find(a => annName(a) === '@Table') || '');
        const kind = t.anns.map(annName).find(a => ['@MappedSuperclass', '@Embeddable'].includes(a));
        return `${t.name}${tbl ? ' -> ' + tbl : ''}${kind ? ' (' + kind.slice(1) + ')' : ''}`;
      }).join(', '));
    }
    const tables = new Map();
    for (const f of area.files) for (const [tb, n] of f.sql) {
      if (!tables.has(tb)) tables.set(tb, { n: 0, classes: new Set() });
      const e = tables.get(tb); e.n += n;
      (idx.typesByFile.get(repo + '\t' + f.file) || []).slice(0, 1).forEach(t => e.classes.add(t.name));
    }
    if (tables.size) {
      L.push(`- Tables (or entity names) in SQL and query strings (${tables.size}): ` + [...tables].sort((a, b) => b[1].n - a[1].n).slice(0, 30).map(([tb, e]) => `${tb} (${[...e.classes].slice(0, 3).join(', ')})`).join(', '));
    }
    const dataClasses = typesIn.filter(t => DATA_CLASS.test(t.name) || t.anns.some(a => ['@Repository', '@Mapper'].includes(annName(a))));
    if (dataClasses.length) L.push(`- Data access classes (${dataClasses.length}): ${dataClasses.slice(0, 20).map(t => t.name).join(', ')}`);
    if (!entities.length && !tables.size && !dataClasses.length) L.push('- No entities, SQL strings or data access classes found in this area.');
    L.push('');

    // ---- integrations
    L.push('## Integrations', '');
    const integ = new Map();
    for (const f of area.files) for (const i of f.integ) {
      if (!integ.has(i)) integ.set(i, []);
      integ.get(i).push(f);
    }
    if (!integ.size) L.push('- None found from the imports.');
    else {
      L.push('| Kind | Files | Example classes | Details |', '| --- | --- | --- | --- |');
      for (const [kind, fl] of [...integ].sort((a, b) => b[1].length - a[1].length)) {
        const ex = [...new Set(fl.flatMap(f => (idx.typesByFile.get(repo + '\t' + f.file) || []).slice(0, 1).map(t => t.name)))].slice(0, 4);
        const det = new Set();
        if (/REST client|SOAP/.test(kind)) fl.flatMap(f => f.urlList).forEach(u => det.add(u));
        const keyHint = { JMS: /queue|topic|destination|jms/i, Kafka: /topic|kafka/i, RabbitMQ: /queue|exchange|routing/i, 'IBM MQ': /queue|mq/i, 'REST client': /url|uri|endpoint|host|base/i, SOAP: /url|uri|endpoint|wsdl/i, Mail: /mail|smtp/i, FTP: /ftp|host/i, SFTP: /sftp|host/i }[kind];
        if (keyHint) fl.flatMap(f => f.keys).filter(k => keyHint.test(k)).forEach(k => det.add(k));
        L.push(`| ${kind} | ${fl.length} | ${ex.join(', ')} | ${cell([...det].slice(0, 6).join(', '))} |`);
      }
    }
    const urlHosts = new Map();
    for (const f of area.files) for (const u of f.urlList) {
      if (!urlHosts.has(u)) urlHosts.set(u, new Set());
      (idx.typesByFile.get(repo + '\t' + f.file) || []).slice(0, 1).forEach(t => urlHosts.get(u).add(t.name));
    }
    if (urlHosts.size) L.push('', `- Addresses written in the code: ${[...urlHosts].slice(0, 15).map(([u, cl]) => `${u} (${[...cl].slice(0, 2).join(', ')})`).join(', ')}`);
    L.push('');

    // ---- configuration
    const keyCount = new Map();
    for (const f of area.files) for (const k of f.keys) keyCount.set(k, (keyCount.get(k) || 0) + 1);
    L.push('## Configuration keys read in the code', '');
    if (!keyCount.size) L.push('- None found (no ${...} placeholders or getProperty("...") calls with a fixed key).');
    else L.push(`- ${[...keyCount].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 40).map(([k, n]) => (n > 1 ? `${k} (${n} files)` : k)).join(', ')}${keyCount.size > 40 ? ', ...' : ''}`);
    L.push('');

    // ---- business rule hints
    L.push('## Business rule hints', '', 'Places where rules and states usually live. Read them before changing behaviour.', '');
    const enums = area.files.flatMap(f => idx.enumsByFile.get(repo + '\t' + f.file) || []);
    if (enums.length) {
      L.push(`- Enums, often states or types (${enums.length}):`);
      enums.slice(0, 15).forEach(e => L.push(`    - ${short(e.fqn)}: ${e.constants.split(',').slice(0, 20).join(', ')}${e.constants.split(',').length > 20 ? ', ...' : ''}`));
    }
    const ruleClasses = typesIn.filter(t => RULE_CLASS.test(t.name));
    if (ruleClasses.length) L.push(`- Rule-like classes (${ruleClasses.length}): ${ruleClasses.slice(0, 20).map(t => t.name + (t.doc ? ` ("${cell(t.doc).slice(0, 80)}")` : '')).join(', ')}`);
    const thrown = area.files.flatMap(f => idx.throwsByFile.get(repo + '\t' + f.file) || []).filter(t => t.message && t.message.replace(/[….\s]/g, '').length > 3);
    if (thrown.length) {
      const jdk = /^(IllegalArgumentException|IllegalStateException|NullPointerException|RuntimeException|Exception|UnsupportedOperationException|IndexOutOfBoundsException|AssertionError|Error|IOException)$/;
      const sorted = thrown.slice().sort((a, b) => (jdk.test(a.exception) ? 1 : 0) - (jdk.test(b.exception) ? 1 : 0));
      L.push(`- Errors thrown with a message (${thrown.length}; own exception types first):`);
      const seen = new Set();
      for (const t of sorted) {
        const key = t.exception + t.message;
        if (seen.has(key)) continue;
        seen.add(key);
        if (seen.size > 25) break;
        L.push(`    - ${short(t.type)}.${t.method}: ${t.exception} "${t.message}" (${t.file}:${t.line})`);
      }
    }
    if (!enums.length && !ruleClasses.length && !thrown.length) L.push('- None found.');
    L.push('');

    // ---- annotations (helps with in-house frameworks)
    const annCount = new Map();
    for (const t of typesIn) for (const a of t.anns) annCount.set(annName(a), (annCount.get(annName(a)) || 0) + 1);
    for (const f of area.files) for (const m of idx.membersByFile.get(repo + '\t' + f.file) || []) for (const a of m.anns) annCount.set(annName(a), (annCount.get(annName(a)) || 0) + 1);
    annCount.delete('@Override'); annCount.delete('@SuppressWarnings'); annCount.delete('@Deprecated');
    if (annCount.size) L.push('## Annotations in this area', '', [...annCount].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([a, n]) => `${a} ${n}`).join(' · '), '');

    // ---- resource files of the module
    const modDir = path.join(repoDir, area.module || '', 'src', 'main', 'resources');
    const res = [];
    const walk = (d, depth) => {
      if (depth > 6 || res.length >= 40) return;
      let ents = [];
      try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) walk(full, depth + 1);
        else if (/\.(xml|sql|properties|ya?ml|json|xsd|wsdl|hbm\.xml)$/i.test(e.name) && res.length < 40) res.push(path.relative(repoDir, full).split(path.sep).join('/'));
      }
    };
    walk(modDir, 0);
    if (res.length) L.push(`## Resource files${area.module ? ' of module ' + area.module : ''} (config, SQL, mappings, schemas)`, '', res.slice(0, 25).join(', ') + (res.length > 25 ? `, ... (${res.length >= 40 ? '40 or more' : res.length} in total)` : ''), '');

    // ---- suggested reading
    const pick = new Map();
    const add = (t, why) => { if (t && !pick.has(t.file) && pick.size < 15) pick.set(t.file, why); };
    roots.slice(0, 5).forEach(fqn => add(typeInfo(fqn), 'entry point'));
    mostUsed.slice(0, 4).forEach(t => add(t, `most used (${t.used} files)`));
    entities.slice(0, 3).forEach(t => add(t, 'entity'));
    ruleClasses.slice(0, 3).forEach(t => add(t, 'rules'));
    dataClasses.slice(0, 2).forEach(t => add(t, 'data access'));
    enums.slice(0, 2).forEach(e => add(typeInfo(e.fqn), 'states (enum)'));
    const throwers = new Map();
    for (const t of thrown) throwers.set(t.type, (throwers.get(t.type) || 0) + 1);
    [...throwers].sort((a, b) => b[1] - a[1]).slice(0, 2).forEach(([fqn, n]) => add(typeInfo(fqn), `throws ${n} business errors`));
    L.push('## Suggested files to read first', '');
    [...pick].forEach(([file, why], i) => L.push(`${i + 1}. repos/${repo}/${file} (${why})`));
    L.push('');

    writeText(path.join(dir, `${area.name}.md`), L.join('\n'));
  }
  writeText(path.join(dir, 'areas.json'), JSON.stringify(areas.map(a => ({
    name: a.name, covers: describe(a), module: a.module, files: a.files.length, lines: a.lines, pathspecs: pathspecs(a)
  })), null, 2));
}

// ------------------------------------------------------------------ the per-repo index of areas

/** Lines under a "## Heading" of a markdown text (until the next ## heading). */
export function section(text, heading) {
  const m = text.match(new RegExp(`^##\\s*${heading}\\s*$([\\s\\S]*?)(?=^##\\s|(?![\\s\\S]))`, 'mi'));
  return m ? m[1].trim() : '';
}

export function readAreaList(repo) {
  try { return JSON.parse(fs.readFileSync(path.join(areaFactsDir(repo), 'areas.json'), 'utf8')); } catch { return []; }
}

/** Commits that touched an area since its note was written (null if unknown). */
export function areaStaleness(repo, area, noteText) {
  const from = (noteText.match(/^-\s*From commit:\s*([0-9a-f]{6,40})/m) || [])[1];
  if (!from || !area?.pathspecs?.length) return null;
  const n = git(path.join(REPOS_DIR, repo), ['rev-list', '--count', `${from}..HEAD`, '--', ...area.pathspecs]);
  return n === '' ? null : Number(n);
}

export function writeAreaIndex(repo) {
  const areas = readAreaList(repo);
  const notesDir = areaNotesDir(repo);
  if (!areas.length) return 0;
  const L = [`# Areas of ${repo}`, '',
    `Generated by tools/refresh.mjs. ${repo} is split into ${areas.length} area${areas.length === 1 ? '' : 's'}. Before working in an area, read its note (written by AI, checked by people) and its facts (counted by scripts). Change the split with split.txt in this folder.`, '',
    '| Area | Covers | Main files | Read when | Note | Facts |', '| --- | --- | --- | --- | --- | --- |'];
  let notes = 0;
  for (const a of areas) {
    const noteFile = path.join(notesDir, `${a.name}.md`);
    const note = readText(noteFile);
    if (note) notes++;
    const readWhen = note ? section(note, 'Read when').split(/\r?\n/).map(l => l.replace(/^[-*]\s*/, '').trim()).filter(Boolean).join('; ') : '';
    L.push(`| ${a.name} | ${cell(a.covers)} | ${a.files} | ${cell(readWhen) || '(no note yet)'} | ${note ? `context/areas/${repo}/${a.name}.md` : '-'} | generated/areas/${repo}/${a.name}.md |`);
  }
  writeText(path.join(notesDir, 'README.md'), L.join('\n') + '\n');
  return notes;
}
