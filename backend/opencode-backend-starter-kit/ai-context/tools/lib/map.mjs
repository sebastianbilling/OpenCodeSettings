// Turns generated/deps and generated/stats into:
//   context/DEPENDENCIES.md  which repo uses which other repo's jars, layers, version differences
//   context/REPOS.md         the one-page map of all repos (built from the cards)
import fs from 'node:fs';
import path from 'node:path';
import { CARDS, CONTEXT, GENERATED, readJson, readText, writeText, today } from './common.mjs';
import { depsFile } from './deps.mjs';

const isTestConfig = c => /^test|Test[A-Z]|^integrationTest/.test(c || '');
const realGroup = g => g && g !== 'unspecified' && g !== 'null';

/** Everything the map and the facts need about how repos depend on each other. */
export function buildGraph(repos) {
  const deps = {}, stats = {};
  for (const r of repos) {
    deps[r] = readJson(depsFile(r), { source: 'missing', projects: [] });
    stats[r] = readJson(path.join(GENERATED, 'stats', `${r}.json`), null);
  }

  // Which repo builds which jar.
  const owner = new Map();       // "group:name" -> { repo, project, version }
  const ownerByName = new Map(); // "name" -> Set(repo) (for builds where the group is unknown)
  const groupsOf = {};           // repo -> Set(group)
  for (const r of repos) {
    groupsOf[r] = new Set();
    for (const p of deps[r].projects || []) {
      const names = new Set([p.name, p.archivesName].filter(Boolean));
      for (const pub of p.publications || []) {
        if (realGroup(pub.group) && pub.artifact) owner.set(`${pub.group}:${pub.artifact}`, { repo: r, project: p.path, version: pub.version || p.version });
        if (pub.artifact) names.add(pub.artifact);
      }
      for (const n of names) {
        if (realGroup(p.group)) owner.set(`${p.group}:${n}`, { repo: r, project: p.path, version: p.version });
        if (!ownerByName.has(n)) ownerByName.set(n, new Set());
        ownerByName.get(n).add(r);
      }
      if (realGroup(p.group)) groupsOf[r].add(p.group);
    }
  }
  const orgPrefix = g => String(g).split('.').slice(0, 2).join('.');
  const orgPrefixes = new Set(repos.flatMap(r => [...groupsOf[r]].map(orgPrefix)));

  // Edges: repo -> repo, with the jars and versions involved.
  const edges = {};   // from -> to -> [{ coord, version, configuration, sure }]
  const localJars = {};
  for (const r of repos) {
    edges[r] = {};
    localJars[r] = [];
    for (const p of deps[r].projects || []) {
      for (const d of p.dependencies || []) {
        if (d.type === 'files') { localJars[r].push(...(d.files || [])); continue; }
        if (d.type !== 'module') continue;
        const key = `${d.group}:${d.name}`;
        let hit = owner.get(key);
        let sure = true;
        if (!hit && (!realGroup(d.group) || orgPrefixes.has(orgPrefix(d.group)))) {
          const byName = ownerByName.get(d.name);
          if (byName && byName.size === 1) { hit = { repo: [...byName][0] }; sure = false; }
        }
        if (!hit || hit.repo === r) continue;
        (edges[r][hit.repo] ||= []).push({ coord: key, version: d.version, configuration: d.configuration, sure, project: p.path });
      }
    }
    localJars[r] = [...new Set(localJars[r])];
  }

  const usedBy = {};
  for (const r of repos) usedBy[r] = [];
  for (const r of repos) for (const to of Object.keys(edges[r])) usedBy[to].push(r);
  for (const r of repos) usedBy[r].sort();

  // Imports seen in the code (a second opinion that also works when the build cannot be read).
  const importUses = {};
  for (const r of repos) importUses[r] = stats[r]?.usesRepos || {};

  // Layers: 0 = uses no other repo. Test-only dependencies do not count.
  const layer = {};
  const cycles = new Set();
  const state = {};
  function visit(r) {
    if (layer[r] !== undefined) return layer[r];
    if (state[r] === 'visiting') { cycles.add(r); return 0; }
    state[r] = 'visiting';
    let l = 0;
    for (const [to, list] of Object.entries(edges[r])) {
      if (list.every(e => isTestConfig(e.configuration))) continue;
      l = Math.max(l, visit(to) + 1);
    }
    state[r] = 'done';
    layer[r] = l;
    return l;
  }
  repos.forEach(visit);

  // Version differences: which versions of each internal jar are in use.
  const drift = {}; // coord -> { repo, current, uses: { version: [repos] } }
  for (const r of repos) {
    for (const [to, list] of Object.entries(edges[r])) {
      for (const e of list) {
        if (!e.sure) continue;
        const o = owner.get(e.coord);
        const d = (drift[e.coord] ||= { repo: to, current: o?.version || '', uses: {} });
        const v = e.version || '(not given)';
        (d.uses[v] ||= new Set()).add(r);
      }
    }
  }
  return { repos, deps, stats, edges, usedBy, importUses, layer, cycles, drift, localJars };
}

function usesLine(g, r) {
  const parts = [];
  for (const [to, list] of Object.entries(g.edges[r]).sort()) {
    const jars = [...new Set(list.map(e => `${e.coord.split(':')[1]} ${e.version || '?'}`))].slice(0, 4).join(', ');
    const testOnly = list.every(e => isTestConfig(e.configuration));
    const unsure = list.every(e => !e.sure);
    parts.push(`${to} (${jars}${testOnly ? '; tests only' : ''}${unsure ? '; matched by name only' : ''})`);
  }
  return parts.length ? parts.join(', ') : '(no other repo)';
}

export function writeDependencies(g) {
  const L = [];
  L.push('# Dependencies between repos', '');
  L.push(`Generated by tools/refresh.mjs on ${today()}. Do not edit by hand; run the script again.`, '');
  L.push('"A uses B" means A declares a jar that is built from repo B. Layer 0 uses no other repo. A change in a low layer can affect every repo above it that uses it.', '');

  const byLayer = {};
  for (const r of g.repos) (byLayer[g.layer[r]] ||= []).push(r);
  L.push('## Layers', '', '| Layer | Repos |', '| --- | --- |');
  for (const l of Object.keys(byLayer).map(Number).sort((a, b) => a - b)) L.push(`| ${l} | ${byLayer[l].join(', ')} |`);
  if (g.cycles.size) L.push('', `Circular dependencies found around: ${[...g.cycles].join(', ')}.`);
  L.push('');

  L.push('## Per repo', '');
  for (const r of g.repos) {
    const d = g.deps[r];
    L.push(`### ${r}`, '');
    L.push(`- Uses: ${usesLine(g, r)}`);
    L.push(`- Used by: ${g.usedBy[r].length ? g.usedBy[r].join(', ') : '(no other repo)'}`);
    const imp = Object.entries(g.importUses[r] || {}).filter(([k]) => k !== r);
    const notInBuild = imp.filter(([k]) => !g.edges[r][k]);
    if (notInBuild.length) L.push(`- Code also imports from: ${notInBuild.map(([k, n]) => `${k} (${n} files)`).join(', ')}. Not declared directly in the build; probably reached through another jar.`);
    if (g.localJars[r].length) L.push(`- Jar files kept in the repo: ${g.localJars[r].slice(0, 8).join(', ')}${g.localJars[r].length > 8 ? ', ...' : ''}`);
    const how = d.source === 'gradle' ? `Gradle ${d.gradleVersion}`
      : d.source === 'static' ? `read from the build files as text${d.gradleError ? ' (Gradle could not run: ' + firstLine(d.gradleError) + ')' : ''}; may miss dependencies set up in code`
      : d.source === 'maven-static' ? 'read from pom.xml files' : 'no build information';
    L.push(`- Source: ${how}`, '');
  }

  const driftRows = Object.entries(g.drift).filter(([, d]) => Object.keys(d.uses).length > 1 || (d.current && !d.uses[d.current]));
  L.push('## Version differences', '');
  if (!driftRows.length) L.push('All repos use the same version of each internal jar.', '');
  else {
    L.push('Internal jars used in more than one version, or in an older version than the repo builds now.', '');
    L.push('| Jar | Built by | Version in repo now | In use |', '| --- | --- | --- | --- |');
    for (const [coord, d] of driftRows.sort()) {
      const uses = Object.entries(d.uses).sort().map(([v, set]) => `${v}: ${[...set].sort().join(', ')}`).join(' · ');
      L.push(`| ${coord} | ${d.repo} | ${d.current || '?'} | ${uses} |`);
    }
    L.push('');
  }
  writeText(path.join(CONTEXT, 'DEPENDENCIES.md'), L.join('\n'));
}

function firstLine(s) {
  return String(s).split('\n').map(x => x.trim()).filter(Boolean)[0]?.slice(0, 140) || '';
}

/** "## Map entry" lines from a card: - Kind: / - Purpose: / - Go here for: / - Key packages: */
export function readMapEntry(repo) {
  const text = readText(path.join(CARDS, `${repo}.md`));
  if (!text) return null;
  const sec = text.match(/^##\s*Map entry\s*$([\s\S]*?)(?=^##\s|(?![\s\S]))/m);
  if (!sec) return null;
  const entry = {};
  for (const line of sec[1].split(/\r?\n/)) {
    const m = line.match(/^\s*-\s*([A-Za-z ]+):\s*(.+)$/);
    if (m) entry[m[1].trim().toLowerCase()] = m[2].trim().slice(0, 400);
  }
  const reviewed = (text.match(/^-\s*Reviewed by:\s*(.+)$/m) || [])[1] || '';
  entry.reviewed = reviewed && !/not yet|^-?$/i.test(reviewed.trim()) ? reviewed.trim() : '';
  return entry;
}

function guessKind(g, r) {
  const d = g.deps[r];
  const plugins = (d.projects || []).flatMap(p => p.plugins || []).join(' ');
  if (/Application|application|SpringBoot|org\.springframework\.boot|War|\bwar\b|Ear|\bear\b/.test(plugins)) return 'application';
  if (g.usedBy[r].length) return 'library';
  if ((g.stats[r]?.entryPoints || []).some(e => !/test code/.test(e.why))) return 'application';
  return 'unknown';
}

export function writeRepoMap(g) {
  const L = [];
  const mapped = g.repos.filter(r => readMapEntry(r)).length;
  L.push('# Repo map', '');
  L.push(`${g.repos.length} repos in repos\\, ${mapped} with a card. Generated by tools/refresh.mjs on ${today()} from context/cards/ and the dependency data. Edit the cards, not this file.`, '');
  L.push('Pick the repos for a task from "Purpose" and "Go here for". Then read their cards in context/cards/. "Uses" and "Used by" come from the Gradle builds (details: context/DEPENDENCIES.md). Layer 0 repos use no other repo.', '');
  for (const r of g.repos) {
    const e = readMapEntry(r);
    const s = g.stats[r];
    const kind = e?.kind || guessKind(g, r);
    L.push(`## ${r} (${kind}, layer ${g.layer[r]})`);
    if (e) {
      if (e.purpose) L.push(`Purpose: ${e.purpose}`);
      if (e['go here for']) L.push(`Go here for: ${e['go here for']}`);
      if (e['key packages']) L.push(`Key packages: ${e['key packages']}`);
      if (!e.reviewed) L.push('Card not reviewed by a person yet.');
    } else {
      L.push('Purpose: not mapped yet (no card).');
      if (s) {
        const pk = (s.packages || []).slice(0, 4).map(p => p.name).join(', ');
        L.push(`Facts: ${s.mainFiles} main + ${s.testFiles} test Java files. Biggest packages: ${pk || '(none)'}. See generated/facts/${r}.md.`);
      }
    }
    L.push(`Uses: ${Object.keys(g.edges[r]).length ? Object.keys(g.edges[r]).sort().join(', ') : '(none)'} · Used by: ${g.usedBy[r].length ? g.usedBy[r].join(', ') : '(none)'}`);
    L.push('');
  }
  // Team decisions, so they are found like a repo.
  const decDir = path.join(CONTEXT, 'decisions');
  const decisions = fs.existsSync(decDir) ? fs.readdirSync(decDir).filter(f => /^\d{3,4}.*\.md$/i.test(f) && !f.startsWith('0000')).sort() : [];
  if (decisions.length) {
    L.push('## Team decisions', '', 'Read the ones that apply before planning. A decision overrides the cards and CONVENTIONS.md.', '');
    for (const f of decisions) {
      const t = readText(path.join(decDir, f));
      const title = (t.match(/^#\s*(.+)$/m) || [])[1] || f;
      const applies = (t.match(/^-\s*Applies to:\s*(.+)$/m) || [])[1];
      L.push(`- context/decisions/${f}: ${title}${applies ? ` (applies to: ${applies})` : ''}`);
    }
    L.push('');
  }
  writeText(path.join(CONTEXT, 'REPOS.md'), L.join('\n'));
}

export function cardExists(repo) {
  return fs.existsSync(path.join(CARDS, `${repo}.md`));
}
