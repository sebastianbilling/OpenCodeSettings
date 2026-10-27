#!/usr/bin/env node
// sync-cards.mjs - OPTIONAL. Puts a private copy of each card into its repo folder as AGENTS.md.
//
//   node tools/sync-cards.mjs          show whether copies are on
//   node tools/sync-cards.mjs --on     copy every card into its repo (and keep doing so on each refresh)
//   node tools/sync-cards.mjs --off    remove all copies this script made
//
// Why: OpenCode reads a folder's AGENTS.md by itself as soon as the AI opens a file in that folder,
// so the right card is always loaded. The copy is listed in the repo's .git/info/exclude, a private
// ignore list that is never shared: Git does not show it, and it cannot be committed or pushed.
// A repo that already has its own AGENTS.md is left alone.
import fs from 'node:fs';
import path from 'node:path';
import { REPOS_DIR, listRepos, parseArgs } from './lib/common.mjs';
import { cardsInReposEnabled, disableCards, enableCards } from './lib/cards.mjs';

const { flags } = parseArgs();
const repos = listRepos();
if (flags.on) {
  const n = enableCards(repos, console.log);
  console.log(`Copied ${n} card(s). They are refreshed every time you run tools/refresh.mjs.`);
} else if (flags.off) {
  disableCards(repos, console.log);
} else {
  const copies = repos.filter(r => {
    const f = path.join(REPOS_DIR, r, 'AGENTS.md');
    return fs.existsSync(f) && fs.readFileSync(f, 'utf8').startsWith('<!-- Copy of ai-context/');
  });
  console.log(`Card copies in repos: ${cardsInReposEnabled() ? 'ON' : 'OFF'} (${copies.length} of ${repos.length} repos have one).`);
  console.log('Use --on or --off to change.');
}
