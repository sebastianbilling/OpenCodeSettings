#!/usr/bin/env node
// map-all.mjs - lets the cartographer agent write the card of many repos, a few at a time.
//
//   node tools/map-all.mjs --model local/<ID> --missing           every repo that has no card yet
//   node tools/map-all.mjs --model local/<ID> --only a,b,c        just these repos (rewrites their cards)
//   node tools/map-all.mjs --model local/<ID> --only a,b,c --bakeoff glm
//        model comparison: cards go to generated/bakeoff/glm/ instead of context/cards/
//
// Options: --parallel 3 (repos at once), --variant max (model variant, if your models have them),
//          --timeout 60 (minutes per repo), --all (every repo, rewriting existing cards)
// Run tools/refresh.mjs first: the cartographer starts from generated/facts/<repo>.md.
// Each run's full output is saved in generated/map-logs/<repo>.log.
import fs from 'node:fs';
import path from 'node:path';
import { CARDS, GENERATED, REPOS_DIR, ROOT, fail, git, listRepos, parseArgs, pool, run, today, which, writeText } from './lib/common.mjs';
import { factsFile } from './lib/facts.mjs';
import { buildGraph, writeRepoMap } from './lib/map.mjs';
import { cardsInReposEnabled, syncCards } from './lib/cards.mjs';

const { flags } = parseArgs();
const model = flags.model;
if (typeof model !== 'string') fail('Say which model writes the cards, e.g.: node tools/map-all.mjs --model local/<ID> --missing');
const label = typeof flags.bakeoff === 'string' ? flags.bakeoff : null;

let repos;
if (flags.only) repos = listRepos(flags.only);
else if (flags.missing) repos = listRepos().filter(r => !fs.existsSync(path.join(CARDS, `${r}.md`)));
else if (flags.all) repos = listRepos();
else fail('Choose the repos: --missing, --only a,b,c or --all');
if (!repos.length) { console.log('Nothing to do: every repo has a card.'); process.exit(0); }

const noFacts = repos.filter(r => !fs.existsSync(factsFile(r)));
if (noFacts.length) fail(`No facts yet for: ${noFacts.join(', ')}. Run: node tools/refresh.mjs`);

const opencode = which('opencode');
if (!opencode) fail('Could not find opencode on the PATH.');

const logs = path.join(GENERATED, 'map-logs');
fs.mkdirSync(logs, { recursive: true });
const parallel = Number(flags.parallel || 3);
const timeoutMin = Number(flags.timeout || 60);
console.log(`Mapping ${repos.length} repo(s) with ${model}, ${parallel} at a time${label ? `, bake-off "${label}"` : ''}.`);

const started = Date.now();
const results = await pool(repos, parallel, async repo => {
  const cardRel = label ? `generated/bakeoff/${label}/${repo}.md` : `context/cards/${repo}.md`;
  const cardAbs = path.join(ROOT, cardRel);
  const before = fs.existsSync(cardAbs) ? fs.statSync(cardAbs).mtimeMs : 0;
  const commit = git(path.join(REPOS_DIR, repo), ['rev-parse', '--short', 'HEAD']) || 'unknown';
  // One line on purpose: multi-line arguments do not survive the Windows command shell.
  const message = `Map repo ${repo}. Card path: ${cardRel}. Facts file: generated/facts/${repo}.md. ` +
    `Commit: ${commit}. Model: ${model}. Today: ${today()}. Follow your instructions and context/card-template.md.`;
  const args = ['run', '--agent', 'cartographer', '--model', model, '--title', `map ${repo}`];
  if (typeof flags.variant === 'string') args.push('--variant', flags.variant);
  args.push(message);
  const t0 = Date.now();
  console.log(`  ${repo}: started`);
  const r = await run(opencode, args, { cwd: ROOT, timeoutMs: timeoutMin * 60000 });
  const minutes = ((Date.now() - t0) / 60000).toFixed(1);
  writeText(path.join(logs, `${repo}${label ? '.' + label : ''}.log`), `$ opencode ${args.join(' ')}\n\n${r.stdout}\n${r.stderr}`);
  const after = fs.existsSync(cardAbs) ? fs.statSync(cardAbs).mtimeMs : 0;
  const text = after ? fs.readFileSync(cardAbs, 'utf8') : '';
  let status;
  if (r.timedOut) status = `stopped after ${timeoutMin} min`;
  else if (after <= before) status = 'FAILED: no card written';
  else if (!/^##\s*Map entry/m.test(text)) status = 'written, but the "## Map entry" section is missing';
  else status = 'ok';
  console.log(`  ${repo}: ${status} (${minutes} min)`);
  return { repo, status, minutes, lines: text ? text.split('\n').length : 0 };
});

const total = ((Date.now() - started) / 60000).toFixed(1);
const summary = ['| Repo | Result | Minutes | Card lines |', '| --- | --- | --- | --- |',
  ...results.map(x => `| ${x.repo} | ${x.status} | ${x.minutes} | ${x.lines} |`)].join('\n');
writeText(path.join(logs, `summary-${today()}${label ? '-' + label : ''}.md`), `# Mapping run ${today()}\n\nModel: ${model}${label ? `, bake-off ${label}` : ''}. Total: ${total} min.\n\n${summary}\n`);
console.log(`\nDone in ${total} min. Summary: generated/map-logs/summary-${today()}${label ? '-' + label : ''}.md`);

if (!label) {
  writeRepoMap(buildGraph(listRepos()));
  console.log('Updated context/REPOS.md.');
  if (cardsInReposEnabled()) syncCards(listRepos());
  console.log('Next: read the new cards (git diff context/cards), fix what is wrong, and set "Reviewed by" to your name.');
}
