#!/usr/bin/env node
// clone-all.mjs - gets the backend repos into repos/ and keeps them up to date.
//
//   node tools/clone-all.mjs               clone every repo in repos.json that is not in repos/ yet
//   node tools/clone-all.mjs --pull        also update the repos already there (only clean ones, fast-forward only)
//   node tools/clone-all.mjs --status      show the branch and state of every repo
//   node tools/clone-all.mjs --write-list  write repos.json from the repos already in repos/ (uses each one's origin URL)
//
// Option: --parallel 4 (how many git commands run at once)
import fs from 'node:fs';
import path from 'node:path';
import { REPOS_DIR, ROOT, fail, git, listRepos, parseArgs, pool, readJson, run } from './lib/common.mjs';

const { flags } = parseArgs();
const LIST = path.join(ROOT, 'repos.json');
const parallel = Number(flags.parallel || 4);
fs.mkdirSync(REPOS_DIR, { recursive: true });

if (flags['write-list']) {
  const repos = listRepos().map(name => {
    const url = git(path.join(REPOS_DIR, name), ['remote', 'get-url', 'origin']);
    return url ? { name, url } : { name, url: '', note: 'no origin remote found' };
  });
  const old = readJson(LIST, {});
  fs.writeFileSync(LIST, JSON.stringify({ comment: old.comment || 'Repos to clone into repos/.', repos }, null, 2) + '\n');
  console.log(`Wrote ${repos.length} repos to repos.json. Check it, then commit it.`);
  process.exit(0);
}

if (flags.status) {
  const rows = await pool(listRepos(), parallel, async name => {
    const dir = path.join(REPOS_DIR, name);
    const r = await run('git', ['-C', dir, 'status', '--porcelain=v1', '--branch'], { timeoutMs: 120000 });
    const lines = r.stdout.split(/\r?\n/).filter(Boolean);
    const head = lines.shift() || '';
    return `${name.padEnd(40)} ${(head.match(/^## (\S+?)(?:\.\.\.|\s|$)/) || [])[1] || '?'}  ${lines.length ? lines.length + ' changed files' : 'clean'}`;
  });
  rows.forEach(r => console.log(r));
  process.exit(0);
}

const list = readJson(LIST);
if (!list || !Array.isArray(list.repos)) fail('repos.json is missing or has no "repos" list.');
const wanted = list.repos.filter(r => r.name && r.url && !r.name.startsWith('example-'));
if (!wanted.length) fail('repos.json only has the examples. Put your own repos in it first.');

const results = await pool(wanted, parallel, async r => {
  const dir = path.join(REPOS_DIR, r.name);
  if (!fs.existsSync(dir)) {
    const args = ['clone', ...(r.branch ? ['--branch', r.branch] : []), r.url, dir];
    const res = await run('git', args, { timeoutMs: 60 * 60000 });
    return `${r.name}: ${res.code === 0 ? 'cloned' : 'CLONE FAILED: ' + (res.stderr.trim().split('\n').pop() || res.code)}`;
  }
  if (!flags.pull) return `${r.name}: already there`;
  const st = await run('git', ['-C', dir, 'status', '--porcelain=v1'], { timeoutMs: 120000 });
  if (st.stdout.trim()) return `${r.name}: has uncommitted changes, not updated`;
  const res = await run('git', ['-C', dir, 'pull', '--ff-only'], { timeoutMs: 30 * 60000 });
  return `${r.name}: ${res.code === 0 ? (/Already up to date/i.test(res.stdout) ? 'up to date' : 'updated') : 'PULL FAILED: ' + (res.stderr.trim().split('\n').pop() || res.code)}`;
});
results.forEach(l => console.log(l));
const extra = listRepos().filter(n => !wanted.some(w => w.name === n));
if (extra.length) console.log(`\nIn repos/ but not in repos.json: ${extra.join(', ')}`);
console.log('\nNext: node tools/refresh.mjs');
