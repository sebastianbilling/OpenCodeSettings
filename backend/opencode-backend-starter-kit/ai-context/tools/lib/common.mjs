// Shared helpers for the scripts in tools/. Node.js built-ins only, nothing to install.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const TOOLS = path.join(ROOT, 'tools');
export const REPOS_DIR = path.join(ROOT, 'repos');
export const GENERATED = path.join(ROOT, 'generated');
export const CONTEXT = path.join(ROOT, 'context');
export const CARDS = path.join(CONTEXT, 'cards');
export const IS_WINDOWS = process.platform === 'win32';

/** Repo folders inside repos/, optionally limited to a comma-separated list. */
export function listRepos(only) {
  if (!fs.existsSync(REPOS_DIR)) return [];
  let names = fs.readdirSync(REPOS_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory() && !d.name.startsWith('.'))
    .map(d => d.name)
    .sort();
  if (only) {
    const wanted = String(only).split(',').map(s => s.trim()).filter(Boolean);
    const missing = wanted.filter(w => !names.includes(w));
    if (missing.length) fail(`Not found in repos\\: ${missing.join(', ')}`);
    names = names.filter(n => wanted.includes(n));
  }
  return names;
}

// Options that are on/off switches: they never take the next word as their value.
const SWITCHES = new Set(['tests', 'deep', 'missing', 'all', 'daemon', 'skip-gradle', 'gradle-all', 'skip-index',
  'on', 'off', 'status', 'pull', 'write-list', 'help']);
// Options that always take the next word as their value, even if it starts with "--" (e.g. --gradle-args "--offline").
const VALUES = new Set(['gradle-args', 'only', 'model', 'repo', 'limit', 'parallel', 'variant', 'timeout', 'bakeoff',
  'stale', 'card', 'gradle-timeout']);

/** --flag value / --flag=value / --switch / positional arguments. */
export function parseArgs(argv = process.argv.slice(2)) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--') || a === '--') { positional.push(a); continue; }
    const eq = a.indexOf('=');
    if (eq > 2) { flags[a.slice(2, eq)] = a.slice(eq + 1); continue; }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (SWITCHES.has(key)) flags[key] = true;
    else if (VALUES.has(key)) { if (next !== undefined) { flags[key] = next; i++; } else flags[key] = true; }
    else if (next !== undefined && !next.startsWith('--')) { flags[key] = next; i++; }
    else flags[key] = true;
  }
  return { flags, positional };
}

export function fail(msg) {
  console.error(msg);
  process.exit(1);
}

export function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

export function readText(file, fallback = '') {
  try { return fs.readFileSync(file, 'utf8'); } catch { return fallback; }
}

export function writeText(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, 'utf8');
}

export function rel(p) {
  return path.relative(ROOT, p).split(path.sep).join('/');
}

function quoteWin(a) {
  if (a === '') return '""';
  return /[\s"&|<>^()%!]/.test(a) ? '"' + a.replace(/"/g, '""') + '"' : a;
}

/**
 * Run a program and collect its output. Works for .bat/.cmd files on Windows too.
 * Resolves { code, stdout, stderr, timedOut, ms }; never rejects.
 */
export function run(cmd, args = [], { cwd = ROOT, timeoutMs = 0, env, input } = {}) {
  return new Promise(resolve => {
    const started = Date.now();
    let child;
    const opts = { cwd, env: env ? { ...process.env, ...env } : process.env, windowsHide: true };
    try {
      if (IS_WINDOWS && /\.(bat|cmd)$/i.test(cmd)) {
        const line = [cmd, ...args].map(quoteWin).join(' ');
        child = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${line}"`], { ...opts, windowsVerbatimArguments: true });
      } else {
        child = spawn(cmd, args, opts);
      }
    } catch (e) {
      resolve({ code: -1, stdout: '', stderr: String(e), timedOut: false, ms: 0 });
      return;
    }
    let stdout = '', stderr = '', timedOut = false, timer = null;
    child.stdout?.on('data', d => { stdout += d; if (stdout.length > 4e6) stdout = stdout.slice(-2e6); });
    child.stderr?.on('data', d => { stderr += d; if (stderr.length > 4e6) stderr = stderr.slice(-2e6); });
    if (input !== undefined) { child.stdin?.end(input); } else { child.stdin?.end(); }
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        if (IS_WINDOWS) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
        else child.kill('SIGKILL');
      }, timeoutMs);
    }
    child.on('error', e => { stderr += String(e); });
    child.on('close', code => {
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr, timedOut, ms: Date.now() - started });
    });
  });
}

/** Run fn over items, at most `limit` at a time. Keeps the input order in the result. */
export async function pool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}

/** Full path of a program on the PATH (handles .exe/.cmd on Windows), or null. */
export function which(name) {
  const exts = IS_WINDOWS ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = path.join(dir, name + ext);
      try { if (fs.statSync(p).isFile()) return p; } catch { /* not here */ }
    }
  }
  return null;
}

/** git in a repo folder; returns trimmed stdout, or '' on any error. */
export function git(repoDir, args) {
  const r = spawnSync('git', ['-C', repoDir, ...args], { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  return r.status === 0 ? (r.stdout || '').trim() : '';
}

export function today() {
  return new Date().toISOString().slice(0, 10);
}

/** "12345" -> "12,345" */
export function num(n) {
  return Number(n || 0).toLocaleString('en-US');
}

export function pct(part, whole) {
  if (!whole) return '0%';
  return Math.round((100 * part) / whole) + '%';
}

/** Tab-separated file with a header row -> array of objects. Streams line by line. */
export function readTsv(file) {
  const text = readText(file);
  if (!text) return [];
  const lines = text.split('\n');
  const head = lines[0].split('\t');
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i]) continue;
    const cols = lines[i].split('\t');
    const o = {};
    for (let j = 0; j < head.length; j++) o[head[j]] = cols[j] ?? '';
    out.push(o);
  }
  return out;
}
