#!/usr/bin/env node
// changed.mjs - shows which repos have uncommitted changes (used by /check-changes).
//
//   node tools/changed.mjs              repos with uncommitted changes or unpushed commits, and their files
//   node tools/changed.mjs --card <repo>  what changed in a repo since its card was written (used by /update-card)
import path from 'node:path';
import { CARDS, REPOS_DIR, ROOT, git, listRepos, parseArgs, pool, readText, run, today } from './lib/common.mjs';

const { flags } = parseArgs();

if (typeof flags.card === 'string') {
  const repo = flags.card;
  const dir = path.join(REPOS_DIR, repo);
  const head = git(dir, ['rev-parse', '--short', 'HEAD']);
  if (!head) { console.log(`- Repo ${repo} not found in repos/ (or not a Git repo).`); process.exit(0); }
  console.log(`- Commit: ${head}`);
  console.log(`- Today: ${today()}`);
  const card = readText(path.join(CARDS, `${repo}.md`));
  const from = (card.match(/^-\s*From commit:\s*([0-9a-f]{6,40})/m) || [])[1];
  if (!card) console.log('- There is no card yet: write a new one.');
  else if (!from) console.log('- The card does not say which commit it was written from.');
  else {
    const n = git(dir, ['rev-list', '--count', `${from}..HEAD`]);
    console.log(`- The card was written from commit ${from}, ${n || '?'} commits ago.`);
    const log = git(dir, ['log', '--oneline', '--no-merges', '-30', `${from}..HEAD`]);
    if (log) console.log('- Commits since then (newest first, at most 30):\n' + log.split('\n').map(l => '    ' + l).join('\n'));
    const stat = git(dir, ['diff', '--stat=120', '--stat-count=25', from, 'HEAD']);
    if (stat) console.log('- Files changed since then:\n' + stat.split('\n').map(l => '    ' + l).join('\n'));
  }
  process.exit(0);
}

async function status(dir) {
  const r = await run('git', ['-C', dir, 'status', '--porcelain=v1', '--branch'], { timeoutMs: 120000 });
  if (r.code !== 0) return null;
  const lines = r.stdout.split(/\r?\n/).filter(Boolean);
  const branchLine = lines.shift() || '';
  const branch = (branchLine.match(/^## (\S+?)(?:\.\.\.|\s|$)/) || [])[1] || '?';
  const ahead = Number((branchLine.match(/ahead (\d+)/) || [])[1] || 0);
  return { branch, ahead, files: lines };
}

const repos = listRepos();
const results = await pool(repos, 8, async r => ({ repo: r, s: await status(path.join(REPOS_DIR, r)) }));
let any = false;
for (const { repo, s } of results) {
  if (!s || (!s.files.length && !s.ahead)) continue;
  any = true;
  console.log(`${repo} (branch ${s.branch}${s.ahead ? `, ${s.ahead} commit${s.ahead === 1 ? '' : 's'} not pushed` : ''})`);
  s.files.slice(0, 40).forEach(f => console.log('  ' + f));
  if (s.files.length > 40) console.log(`  ... ${s.files.length - 40} more files`);
}
const own = await status(ROOT);
if (own && own.files.length) {
  any = true;
  console.log('ai-context (this folder)');
  own.files.slice(0, 20).forEach(f => console.log('  ' + f));
}
if (!any) console.log('No uncommitted changes in any repo.');
