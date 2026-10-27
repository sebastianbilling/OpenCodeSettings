// Optional: copies each card into its repo folder as AGENTS.md, so OpenCode loads it by itself
// whenever the AI opens a file in that repo. The copy is listed in the repo's private Git ignore
// list (.git/info/exclude), so Git never shows, commits or pushes it.
import fs from 'node:fs';
import path from 'node:path';
import { CARDS, GENERATED, REPOS_DIR, git, readText } from './common.mjs';

const MARKER = path.join(GENERATED, 'cards-in-repos.on');
const HEADER = '<!-- Copy of ai-context/context/cards/{repo}.md made by tools/sync-cards.mjs. Never committed (listed in .git/info/exclude). Edit the original, not this copy. -->';

export function cardsInReposEnabled() {
  return fs.existsSync(MARKER);
}

function ours(file) {
  return readText(file).startsWith('<!-- Copy of ai-context/context/cards/');
}

function excludeFile(repoDir) {
  const gitDir = path.join(repoDir, '.git');
  try { if (fs.statSync(gitDir).isDirectory()) return path.join(gitDir, 'info', 'exclude'); } catch { /* no .git */ }
  return null;
}

/** Copy cards into repos. Returns the number of copies written. */
export function syncCards(repos, log = () => {}) {
  let n = 0;
  for (const repo of repos) {
    const card = path.join(CARDS, `${repo}.md`);
    const repoDir = path.join(REPOS_DIR, repo);
    const target = path.join(repoDir, 'AGENTS.md');
    if (!fs.existsSync(card)) continue;
    if (fs.existsSync(target) && !ours(target)) { log(`  ${repo}: has its own AGENTS.md, left alone`); continue; }
    if (git(repoDir, ['ls-files', 'AGENTS.md'])) { log(`  ${repo}: AGENTS.md is tracked by Git there, left alone`); continue; }
    const ex = excludeFile(repoDir);
    if (!ex) { log(`  ${repo}: no .git folder, skipped`); continue; }
    const exText = readText(ex);
    if (!/^\/?AGENTS\.md\s*$/m.test(exText)) {
      fs.mkdirSync(path.dirname(ex), { recursive: true });
      fs.writeFileSync(ex, (exText && !exText.endsWith('\n') ? exText + '\n' : exText) + '# ai-context: local copy of the repo card\n/AGENTS.md\n');
    }
    const text = HEADER.replace('{repo}', repo) + '\n\n' + readText(card);
    if (readText(target) !== text) fs.writeFileSync(target, text);
    n++;
  }
  return n;
}

export function enableCards(repos, log) {
  fs.mkdirSync(GENERATED, { recursive: true });
  fs.writeFileSync(MARKER, 'Cards are copied into the repos. Turn off with: node tools/sync-cards.mjs --off\n');
  return syncCards(repos, log);
}

/** Remove the copies (only files this script made) and the exclude lines. */
export function disableCards(repos, log = () => {}) {
  try { fs.rmSync(MARKER, { force: true }); } catch { /* ignore */ }
  let n = 0;
  for (const repo of repos) {
    const repoDir = path.join(REPOS_DIR, repo);
    const target = path.join(repoDir, 'AGENTS.md');
    if (fs.existsSync(target) && ours(target)) { fs.rmSync(target); n++; }
    const ex = excludeFile(repoDir);
    if (ex && fs.existsSync(ex)) {
      const t = readText(ex);
      const cleaned = t.replace(/# ai-context: local copy of the repo card\r?\n\/AGENTS\.md\r?\n?/g, '');
      if (cleaned !== t) fs.writeFileSync(ex, cleaned);
    }
  }
  log(`Removed ${n} copies.`);
  return n;
}
