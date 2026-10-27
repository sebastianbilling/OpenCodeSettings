#!/usr/bin/env node
// refresh.mjs - rebuilds everything the scripts can work out on their own. No AI involved.
//
//   node tools/refresh.mjs                  index all code, update dependencies where builds changed, rewrite the map
//   node tools/refresh.mjs --gradle-all     ask Gradle again for every repo (slow; after big build changes)
//   node tools/refresh.mjs --skip-gradle    never run Gradle; reuse earlier results or read build files as text
//   node tools/refresh.mjs --only a,b       Gradle and facts only for these repos (the code index always covers all)
//
// Other options: --parallel 3 (Gradle runs at once), --daemon (keep Gradle daemons, faster but uses memory),
// --gradle-args "--offline", --stale 30 (commits after which a card counts as possibly out of date).
//
// Writes: generated/index, generated/stats, generated/deps, generated/facts (all ignored by Git)
//         context/DEPENDENCIES.md and context/REPOS.md (committed)
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { CARDS, GENERATED, REPOS_DIR, ROOT, TOOLS, git, listRepos, parseArgs, readJson, readText, writeText, fail } from './lib/common.mjs';
import { collectDeps, depsFile } from './lib/deps.mjs';
import { buildGraph, writeDependencies, writeRepoMap } from './lib/map.mjs';
import { writeFacts, writeOverview } from './lib/facts.mjs';
import { syncCards, cardsInReposEnabled } from './lib/cards.mjs';

const { flags } = parseArgs();
const all = listRepos();
if (!all.length) fail('No repos found in repos\\. Run: node tools/clone-all.mjs');
const only = flags.only ? listRepos(flags.only) : all;
const started = Date.now();

// 1. Code index -------------------------------------------------------------------
if (!flags['skip-index']) {
  console.log(`1/4 Indexing the Java code of ${all.length} repos...`);
  const r = spawnSync('java', [path.join(TOOLS, 'JavaIndexer.java'), '--repos', REPOS_DIR, '--out', GENERATED], { stdio: 'inherit', cwd: ROOT });
  if (r.error) fail('Could not start java. Is a JDK 17+ on the PATH? (' + r.error.message + ')');
  if (r.status !== 0) fail('The Java indexer failed; see the messages above.');
} else console.log('1/4 Skipping the code index (--skip-index).');

// 2. Dependencies -----------------------------------------------------------------
const STATE = path.join(GENERATED, 'refresh-state.json');
const state = readJson(STATE, {});
const buildFiles = ['build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts', 'gradle.properties',
  path.join('gradle', 'libs.versions.toml'), path.join('gradle', 'wrapper', 'gradle-wrapper.properties'), 'pom.xml'];
function buildHash(repo) {
  const h = crypto.createHash('sha1');
  const dir = path.join(REPOS_DIR, repo);
  const walk = (d, depth) => {
    for (const f of buildFiles) { const p = path.join(d, f); if (fs.existsSync(p)) h.update(p + readText(p)); }
    if (depth > 8) return;
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.') || ['build', 'src', 'out', 'target', 'node_modules', 'bin'].includes(e.name)) continue;
      walk(path.join(d, e.name), depth + 1);
    }
  };
  walk(dir, 0);
  return h.digest('hex').slice(0, 16);
}
const hashes = {};
const needGradle = [];
for (const r of only) {
  hashes[r] = buildHash(r);
  const known = state[r]?.buildHash === hashes[r] && fs.existsSync(depsFile(r));
  if (flags['gradle-all'] || !known) needGradle.push(r);
}
const gradleFailed = [];
if (flags['skip-gradle']) {
  // Nothing is recorded, so the next normal refresh still asks Gradle.
  console.log('2/4 Not running Gradle (--skip-gradle).');
  const missing = only.filter(r => !fs.existsSync(depsFile(r)));
  if (missing.length) await collectDeps(missing, { staticOnly: true, log: () => {} });
} else if (needGradle.length) {
  console.log(`2/4 Reading dependencies of ${needGradle.length} repo(s) whose build files changed (Gradle, ${flags.parallel || 3} at a time)...`);
  const results = await collectDeps(needGradle, {
    parallel: Number(flags.parallel || 3),
    daemon: !!flags.daemon,
    gradleArgs: typeof flags['gradle-args'] === 'string' ? flags['gradle-args'].split(' ').filter(Boolean) : [],
    timeoutMin: Number(flags['gradle-timeout'] || 15)
  });
  results.forEach((res, i) => {
    const r = needGradle[i];
    state[r] = { buildHash: hashes[r], source: res.source, checked: new Date().toISOString() };
    if (res.gradleError) gradleFailed.push(r);
  });
  writeText(STATE, JSON.stringify(state, null, 2));
} else console.log('2/4 Build files unchanged since last time; reusing dependency data.');

// 3. Facts per repo ---------------------------------------------------------------
console.log(`3/4 Writing facts for ${only.length} repo(s)...`);
const g = buildGraph(all);
for (const r of only) writeFacts(r, g);
writeOverview(g);

// 4. Map and dependency overview --------------------------------------------------
console.log('4/4 Writing context/REPOS.md and context/DEPENDENCIES.md...');
writeDependencies(g);
writeRepoMap(g);
if (cardsInReposEnabled()) {
  const n = syncCards(all);
  console.log(`    Copied ${n} card(s) into the repos as AGENTS.md (turn off: node tools/sync-cards.mjs --off).`);
}

// Report: missing and possibly outdated cards -------------------------------------
const staleAfter = Number(flags.stale || 30);
const missing = [], stale = [];
for (const r of all) {
  const card = readText(path.join(CARDS, `${r}.md`));
  if (!card) { missing.push(r); continue; }
  const from = (card.match(/^-\s*From commit:\s*([0-9a-f]{6,40})/m) || [])[1];
  if (!from) continue;
  const n = Number(git(path.join(REPOS_DIR, r), ['rev-list', '--count', `${from}..HEAD`]) || 0);
  if (n >= staleAfter) stale.push(`${r} (${n} commits since the card was written)`);
}
const secs = Math.round((Date.now() - started) / 1000);
console.log(`\nDone in ${secs}s.`);
if (gradleFailed.length) console.log(`Gradle could not run for: ${gradleFailed.join(', ')}. Their build files were read as text instead.\n  To retry with another JDK: set $env:JAVA_HOME, then node tools/refresh.mjs --only ${gradleFailed.join(',')} --gradle-all`);
if (missing.length) console.log(`Repos without a card (${missing.length}): ${missing.join(', ')}`);
if (stale.length) console.log(`Cards that may be out of date: ${stale.join(', ')}\n  Update one with /update-card <repo> in OpenCode.`);
