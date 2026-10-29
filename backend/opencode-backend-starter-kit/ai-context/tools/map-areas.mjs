#!/usr/bin/env node
// map-areas.mjs - lets the surveyor agent write area notes (flows, business rules, data, integrations),
// one area at a time, a few at a time.
//
//   node tools/map-areas.mjs --only repoA                  every area of repoA that has no note yet
//   node tools/map-areas.mjs --only repoA --area billing   one area (rewrites its note)
//   node tools/map-areas.mjs --only repoA,repoB --all      every area of these repos, rewriting notes
//   node tools/map-areas.mjs --missing                     every area of every repo without a note (takes long)
//
// Without --model and --variant, the surveyor uses the model: and variant: lines in
// .opencode/agents/surveyor.md (or the default model if it has none).
// Options: --model <provider>/<ID>, --variant max, --parallel 3, --timeout 60 (minutes per area)
// Run tools/refresh.mjs first: the surveyor starts from generated/areas/<repo>/<area>.md.
import fs from 'node:fs';
import path from 'node:path';
import { GENERATED, REPOS_DIR, ROOT, fail, git, listRepos, parseArgs, pool, readText, run, today, which, writeText } from './lib/common.mjs';
import { areaNotesDir, readAreaList, writeAreaIndex } from './lib/areas.mjs';

const { flags } = parseArgs();

// The model the surveyor will use: --model, else its agent file, else the project default.
const agentFile = readText(path.join(ROOT, '.opencode', 'agents', 'surveyor.md'));
const front = (agentFile.match(/^---\r?\n([\s\S]*?)\r?\n---/) || [])[1] || '';
const agentModel = (front.match(/^model:\s*["']?([^"'\r\n#]+?)["']?\s*(?:#.*)?$/m) || [])[1];
const agentVariant = (front.match(/^variant:\s*["']?([^"'\r\n#]+?)["']?\s*(?:#.*)?$/m) || [])[1];
const projectModel = (readText(path.join(ROOT, 'opencode.jsonc')).match(/^\s*"model"\s*:\s*"([^"]+)"/m) || [])[1];
const model = typeof flags.model === 'string' ? flags.model : (agentModel || projectModel || 'default model');
const variant = typeof flags.variant === 'string' ? flags.variant : (typeof flags.model === 'string' ? null : (agentModel ? agentVariant || null : null));
const modelLabel = model + (variant ? ` (${variant})` : '');

let repos;
if (flags.only) repos = listRepos(flags.only);
else if (flags.missing) repos = listRepos();
else fail('Choose the repos: --only a,b (optionally with --area <name> or --all), or --missing for every repo.');

const jobs = [];
for (const repo of repos) {
  const areas = readAreaList(repo);
  if (!areas.length) { console.log(`  ${repo}: no areas yet, run node tools/refresh.mjs first`); continue; }
  for (const a of areas) {
    if (typeof flags.area === 'string' && a.name !== flags.area) continue;
    const hasNote = fs.existsSync(path.join(areaNotesDir(repo), `${a.name}.md`));
    if (hasNote && !flags.all && typeof flags.area !== 'string') continue;
    jobs.push({ repo, area: a });
  }
  if (typeof flags.area === 'string' && !areas.some(a => a.name === flags.area))
    fail(`${repo} has no area "${flags.area}". Its areas: ${areas.map(a => a.name).join(', ')}`);
}
if (!jobs.length) { console.log('Nothing to do: every area asked for has a note. Use --all or --area to rewrite.'); process.exit(0); }

const opencode = which('opencode');
if (!opencode) fail('Could not find opencode on the PATH.');
const logs = path.join(GENERATED, 'map-logs');
fs.mkdirSync(logs, { recursive: true });
const parallel = Number(flags.parallel || 3);
const timeoutMin = Number(flags.timeout || 60);
console.log(`Surveying ${jobs.length} area(s) in ${new Set(jobs.map(j => j.repo)).size} repo(s) with ${modelLabel}, ${parallel} at a time.`);

const started = Date.now();
const results = await pool(jobs, parallel, async ({ repo, area }) => {
  const noteRel = `context/areas/${repo}/${area.name}.md`;
  const noteAbs = path.join(ROOT, noteRel);
  fs.mkdirSync(path.dirname(noteAbs), { recursive: true });
  const before = fs.existsSync(noteAbs) ? fs.statSync(noteAbs).mtimeMs : 0;
  const commit = git(path.join(REPOS_DIR, repo), ['rev-parse', '--short', 'HEAD']) || 'unknown';
  // One line on purpose: multi-line arguments do not survive the Windows command shell.
  const message = `Survey area ${area.name} of repo ${repo}. Note path: ${noteRel}. Facts file: generated/areas/${repo}/${area.name}.md. ` +
    `Card: context/cards/${repo}.md. Commit: ${commit}. Model: ${modelLabel}. Today: ${today()}. Follow your instructions and context/area-template.md.`;
  const args = ['run', '--agent', 'surveyor', '--title', `area ${repo}/${area.name}`];
  if (typeof flags.model === 'string') args.push('--model', flags.model);
  if (typeof flags.variant === 'string') args.push('--variant', flags.variant);
  args.push(message);
  const t0 = Date.now();
  const label = `${repo}/${area.name}`;
  console.log(`  ${label}: started (${area.files} main files)`);
  const r = await run(opencode, args, { cwd: ROOT, timeoutMs: timeoutMin * 60000 });
  const minutes = ((Date.now() - t0) / 60000).toFixed(1);
  writeText(path.join(logs, `${repo}.${area.name}.area.log`), `$ opencode ${args.join(' ')}\n\n${r.stdout}\n${r.stderr}`);
  const after = fs.existsSync(noteAbs) ? fs.statSync(noteAbs).mtimeMs : 0;
  const text = after ? fs.readFileSync(noteAbs, 'utf8') : '';
  let status;
  if (r.timedOut) status = `stopped after ${timeoutMin} min`;
  else if (after <= before) status = 'FAILED: no note written';
  else if (!/^##\s*Read when/m.test(text) || !/^##\s*Main flows/m.test(text)) status = 'written, but "## Read when" or "## Main flows" is missing';
  else status = 'ok';
  console.log(`  ${label}: ${status} (${minutes} min)`);
  return { label, repo, status, minutes, lines: text ? text.split('\n').length : 0 };
});

for (const r of new Set(results.map(x => x.repo))) writeAreaIndex(r);
const total = ((Date.now() - started) / 60000).toFixed(1);
const summary = ['| Area | Result | Minutes | Note lines |', '| --- | --- | --- | --- |', ...results.map(x => `| ${x.label} | ${x.status} | ${x.minutes} | ${x.lines} |`)].join('\n');
writeText(path.join(logs, `summary-areas-${today()}.md`), `# Area run ${today()}\n\nModel: ${modelLabel}. Total: ${total} min.\n\n${summary}\n`);
console.log(`\nDone in ${total} min. Summary: generated/map-logs/summary-areas-${today()}.md`);
console.log('Updated context/areas/<repo>/README.md. Next: read the new notes, fix what is wrong, and set "Reviewed by" to your name.');
