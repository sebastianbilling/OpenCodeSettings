// Collects, per repo, what its Gradle (or Maven) projects are and what they depend on.
// First choice: ask Gradle itself, with tools/ai-deps.gradle. If Gradle cannot run,
// fall back to reading the build files as text, which catches most common forms.
import fs from 'node:fs';
import path from 'node:path';
import { GENERATED, REPOS_DIR, TOOLS, IS_WINDOWS, run, readText, writeText, pool } from './common.mjs';

const DEPS_DIR = path.join(GENERATED, 'deps');

export function depsFile(repo) {
  return path.join(DEPS_DIR, `${repo}.json`);
}

function exists(p) { try { fs.accessSync(p); return true; } catch { return false; } }

export function wrapperVersion(dir) {
  const props = readText(path.join(dir, 'gradle', 'wrapper', 'gradle-wrapper.properties'));
  const m = props.match(/gradle-([0-9][0-9A-Za-z.\-]*?)-(?:bin|all)\.zip/);
  return m ? m[1] : '';
}

function versionAtLeast(v, major, minor) {
  const m = String(v).match(/^(\d+)\.(\d+)/);
  if (!m) return false;
  const a = +m[1], b = +m[2];
  return a > major || (a === major && b >= minor);
}

function isGradle(dir) {
  return ['build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts'].some(f => exists(path.join(dir, f)));
}

/** Run Gradle for every repo (a few at a time) and write generated/deps/<repo>.json. */
export async function collectDeps(repos, { parallel = 3, staticOnly = false, daemon = false, gradleArgs = [], timeoutMin = 15, log = console.log } = {}) {
  fs.mkdirSync(DEPS_DIR, { recursive: true });
  const initScript = path.join(TOOLS, 'ai-deps.gradle');
  return pool(repos, parallel, async repo => {
    const dir = path.join(REPOS_DIR, repo);
    const outFile = depsFile(repo);
    let result;
    if (isGradle(dir)) {
      let gradleError = '';
      if (!staticOnly) {
        const wrapper = path.join(dir, IS_WINDOWS ? 'gradlew.bat' : 'gradlew');
        const wv = wrapperVersion(dir);
        const cmd = exists(wrapper) ? (IS_WINDOWS ? wrapper : 'sh') : (IS_WINDOWS ? 'gradle.bat' : 'gradle');
        const args = exists(wrapper) && !IS_WINDOWS ? [wrapper] : [];
        const tmpOut = outFile + '.tmp';
        try { fs.rmSync(tmpOut, { force: true }); } catch { /* ignore */ }
        args.push('-q', '-I', initScript, `-PaiDepsOut=${tmpOut}`);
        if (!daemon) args.push('--no-daemon');
        // Configuration cache would skip our script on a second run; switch it off where it exists (6.6+).
        if (!wv || versionAtLeast(wv, 6, 6)) args.push('--no-configuration-cache');
        args.push(...gradleArgs, 'help');
        log(`  ${repo}: asking Gradle${wv ? ' ' + wv : ''}...`);
        const r = await run(cmd, args, { cwd: dir, timeoutMs: timeoutMin * 60000 });
        if (r.code === 0 && exists(tmpOut)) {
          try {
            result = JSON.parse(readText(tmpOut));
            result.source = 'gradle';
            result.seconds = Math.round(r.ms / 1000);
          } catch (e) { gradleError = 'could not read Gradle output: ' + e.message; }
        } else {
          const tail = (r.stderr || r.stdout || '').split(/\r?\n/).filter(l => l.trim() && !/^\s*at /.test(l)).slice(-12).join('\n');
          gradleError = r.timedOut ? `Gradle took longer than ${timeoutMin} minutes` : (tail || `Gradle exited with code ${r.code}`);
        }
        try { fs.rmSync(tmpOut, { force: true }); } catch { /* ignore */ }
      }
      if (!result) {
        result = staticGradle(dir);
        if (gradleError) result.gradleError = gradleError;
        log(`  ${repo}: ${staticOnly ? 'read' : 'Gradle failed, read'} build files as text`);
      } else {
        log(`  ${repo}: done (${result.projects.length} project${result.projects.length === 1 ? '' : 's'}, ${result.seconds}s)`);
      }
      if (!result.gradleVersion) result.gradleVersion = wrapperVersion(dir);
      result.wrapper = exists(path.join(dir, 'gradlew.bat')) || exists(path.join(dir, 'gradlew'));
    } else if (exists(path.join(dir, 'pom.xml'))) {
      result = staticMaven(dir);
      log(`  ${repo}: Maven project, read pom.xml files`);
    } else {
      result = { source: 'none', projects: [] };
      log(`  ${repo}: no Gradle or Maven build found`);
    }
    result.repo = repo;
    result.buildFileHints = buildHints(dir);
    writeText(outFile, JSON.stringify(result, null, 2));
    return result;
  });
}

// ---------------------------------------------------------------- static reading

function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[\s;{}])\/\/.*$/gm, '$1');
}

function props(file) {
  const out = {};
  for (const line of readText(file).split(/\r?\n/)) {
    const m = line.match(/^\s*([\w.\-]+)\s*[=:]\s*(.*?)\s*$/);
    if (m && !line.trim().startsWith('#')) out[m[1]] = m[2];
  }
  return out;
}

function readCatalog(dir) {
  const text = readText(path.join(dir, 'gradle', 'libs.versions.toml'));
  const versions = {}, libs = {};
  let section = '';
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const sec = line.match(/^\[(.+)]$/);
    if (sec) { section = sec[1].trim(); continue; }
    const kv = line.match(/^([\w.\-]+)\s*=\s*(.+)$/);
    if (!kv) continue;
    const key = kv[1], val = kv[2].trim();
    if (section === 'versions') {
      const s = val.match(/^"([^"]*)"/);
      versions[key] = s ? s[1] : val;
    } else if (section === 'libraries') {
      let group = '', name = '', version = '';
      const plain = val.match(/^"([^":]+):([^":]+)(?::([^"]+))?"$/);
      if (plain) { [, group, name, version = ''] = plain; }
      else {
        const mod = val.match(/module\s*=\s*"([^":]+):([^"]+)"/);
        if (mod) { group = mod[1]; name = mod[2]; }
        const g = val.match(/group\s*=\s*"([^"]+)"/); if (g) group = g[1];
        const n = val.match(/name\s*=\s*"([^"]+)"/); if (n) name = n[1];
        const vr = val.match(/version\.ref\s*=\s*"([^"]+)"/) || val.match(/version\s*=\s*\{\s*ref\s*=\s*"([^"]+)"/);
        const v = val.match(/version\s*=\s*"([^"]+)"/);
        version = vr ? (versions[vr[1]] ?? '') : (v ? v[1] : '');
      }
      if (group && name) libs[key.replace(/[-_]/g, '.').toLowerCase()] = { group, name, version };
    }
  }
  return libs;
}

const CONFIGS = 'api|implementation|compile|compileOnly|compileOnlyApi|runtimeOnly|runtime|testImplementation|testCompile|testCompileOnly|testRuntimeOnly|testRuntime|annotationProcessor|providedCompile|providedRuntime|earlib|deploy|integrationTestImplementation|testFixturesApi|testFixturesImplementation';

function staticDeps(text, catalog) {
  const deps = [];
  const body = stripComments(text);
  const lineRe = new RegExp(`(?:^|[\\s{;])(?:"(${CONFIGS})"|(${CONFIGS}))\\s*(?:\\(|\\s)(.*)$`, 'gm');
  let m;
  while ((m = lineRe.exec(body))) {
    const configuration = m[1] || m[2];
    const rest = m[3];
    let found = false;
    const coordRe = /['"]([^'"\s:$]+):([^'"\s:$]+)(?::([^'"\s@]+))?(?:@\w+)?['"]/g;
    let c;
    while ((c = coordRe.exec(rest))) { deps.push({ configuration, type: 'module', group: c[1], name: c[2], version: c[3] || '' }); found = true; }
    const map = rest.match(/group\s*[:=]\s*['"]([^'"]+)['"]\s*,\s*name\s*[:=]\s*['"]([^'"]+)['"](?:\s*,\s*version\s*[:=]\s*['"]([^'"]+)['"])?/);
    if (map) { deps.push({ configuration, type: 'module', group: map[1], name: map[2], version: map[3] || '' }); found = true; }
    const proj = rest.match(/project\s*\(\s*(?:path\s*[:=]\s*)?['"](:[^'"]*)['"]/);
    if (proj) { deps.push({ configuration, type: 'project', path: proj[1] }); found = true; }
    if (/\b(files|fileTree)\s*\(/.test(rest)) {
      deps.push({ configuration, type: 'files', files: [rest.trim().replace(/\)\s*$/, '').slice(0, 120)] });
      found = true;
    }
    const cat = rest.match(/\blibs\.([\w.]+)/);
    if (!found && cat) {
      const lib = catalog[cat[1].toLowerCase()];
      if (lib) deps.push({ configuration, type: 'module', ...lib });
      else deps.push({ configuration, type: 'module', group: '', name: 'libs.' + cat[1], version: '' });
    }
  }
  return deps;
}

function javaLevel(text) {
  const t = stripComments(text);
  let m = t.match(/languageVersion\s*(?:=|\.set\s*\()\s*JavaLanguageVersion\.of\(\s*(\d+)/);
  if (m) return m[1];
  m = t.match(/(?:options\.)?release\s*(?:=|\.set\s*\()\s*(\d+)/);
  if (m) return m[1];
  m = t.match(/sourceCompatibility\s*=\s*['"]?(?:JavaVersion\.VERSION_)?([0-9][0-9_.]*)/);
  if (m) return m[1].replace('_', '.');
  return '';
}

export function staticGradle(dir) {
  const settingsFile = ['settings.gradle', 'settings.gradle.kts'].map(f => path.join(dir, f)).find(exists);
  const settings = stripComments(readText(settingsFile || ''));
  const rootName = (settings.match(/rootProject\.name\s*=\s*['"]([^'"]+)['"]/) || [])[1] || path.basename(dir);
  const includes = [];
  const incRe = /\binclude\s*\(?([^\n)]*)/g;
  let m;
  while ((m = incRe.exec(settings))) {
    for (const q of m[1].matchAll(/['"]([^'"]+)['"]/g)) includes.push(q[1].startsWith(':') ? q[1] : ':' + q[1]);
  }
  const rootProps = props(path.join(dir, 'gradle.properties'));
  const catalog = readCatalog(dir);
  const buildFile = d => ['build.gradle', 'build.gradle.kts'].map(f => path.join(d, f)).find(exists);
  const rootText = readText(buildFile(dir) || '');
  const rootGroup = (stripComments(rootText).match(/\bgroup\s*=\s*['"]([^'"]+)['"]/) || [])[1] || rootProps.group || '';
  const VERSION_RE = /\bversion\s*=\s*['"](\d[^'"\s\[\]()]*)['"]/;
  const rootVersion = (stripComments(rootText).match(VERSION_RE) || [])[1] || rootProps.version || '';
  const rootJava = javaLevel(rootText);
  const projects = [];
  for (const p of [':', ...includes]) {
    const pdir = p === ':' ? dir : path.join(dir, ...p.split(':').filter(Boolean));
    const text = p === ':' ? rootText : readText(buildFile(pdir) || '');
    const body = stripComments(text);
    projects.push({
      path: p,
      name: p === ':' ? rootName : p.split(':').pop(),
      group: (p !== ':' && (body.match(/\bgroup\s*=\s*['"]([^'"]+)['"]/) || [])[1]) || rootGroup,
      version: (p !== ':' && (body.match(VERSION_RE) || [])[1]) || rootVersion,
      dir: path.relative(dir, pdir).split(path.sep).join('/'),
      javaVersion: javaLevel(text) || rootJava,
      archivesName: (body.match(/archivesBaseName\s*=\s*['"]([^'"]+)['"]/) || body.match(/archivesName\s*(?:=|\.set\s*\()\s*['"]([^'"]+)['"]/) || [])[1] || '',
      plugins: [...body.matchAll(/id\s*\(?\s*['"]([\w.\-]+)['"]|apply\s+plugin\s*:\s*['"]([\w.\-]+)['"]|`([\w\-]+)`/g)].map(x => x[1] || x[2] || x[3]),
      publications: [],
      dependencies: staticDeps(text, catalog)
    });
  }
  return { source: 'static', gradleVersion: wrapperVersion(dir), rootProject: rootName, includedBuilds: [], projects };
}

export function staticMaven(dir, base = dir, out = []) {
  const pom = readText(path.join(dir, 'pom.xml')).replace(/<!--[\s\S]*?-->/g, '');
  const parent = (pom.match(/<parent>([\s\S]*?)<\/parent>/) || [])[1] || '';
  const own = pom.replace(/<parent>[\s\S]*?<\/parent>/, '').replace(/<dependencies>[\s\S]*?<\/dependencies>/g, '')
    .replace(/<dependencyManagement>[\s\S]*?<\/dependencyManagement>/g, '').replace(/<build>[\s\S]*?<\/build>/g, '')
    .replace(/<profiles>[\s\S]*?<\/profiles>/g, '');
  const tag = (t, s) => ((s.match(new RegExp(`<${t}>\\s*([^<]*?)\\s*</${t}>`)) || [])[1] || '');
  const deps = [];
  const depBlock = (pom.replace(/<dependencyManagement>[\s\S]*?<\/dependencyManagement>/g, '').match(/<dependencies>([\s\S]*?)<\/dependencies>/) || [])[1] || '';
  for (const d of depBlock.matchAll(/<dependency>([\s\S]*?)<\/dependency>/g)) {
    deps.push({ configuration: tag('scope', d[1]) || 'compile', type: 'module', group: tag('groupId', d[1]), name: tag('artifactId', d[1]), version: tag('version', d[1]) });
  }
  const rp = path.relative(base, dir).split(path.sep).join('/');
  out.push({
    path: rp ? ':' + rp.replace(/\//g, ':') : ':',
    name: tag('artifactId', own),
    group: tag('groupId', own) || tag('groupId', parent),
    version: tag('version', own) || tag('version', parent),
    dir: rp,
    javaVersion: tag('maven.compiler.release', pom) || tag('maven.compiler.source', pom),
    archivesName: '', plugins: ['maven'], publications: [], dependencies: deps
  });
  for (const mod of pom.matchAll(/<module>\s*([^<]+?)\s*<\/module>/g)) {
    const md = path.join(dir, mod[1]);
    if (exists(path.join(md, 'pom.xml'))) staticMaven(md, base, out);
  }
  if (dir === base) return { source: 'maven-static', gradleVersion: '', rootProject: out[0]?.name || path.basename(dir), includedBuilds: [], projects: out };
  return out;
}

/** Things the AI should know that Gradle does not report directly. */
function buildHints(dir) {
  const hints = [];
  const all = ['build.gradle', 'build.gradle.kts'].map(f => readText(path.join(dir, f))).join('\n');
  if (all && !/sourceCompatibility|targetCompatibility|languageVersion|release\s*(=|\.set)/.test(all)) hints.push('Java level is not set in the root build file (it may be set in modules or convention plugins)');
  if (exists(path.join(dir, 'buildSrc'))) hints.push('has buildSrc/ (shared build logic lives there)');
  if (exists(path.join(dir, 'gradle', 'libs.versions.toml'))) hints.push('uses a version catalog: gradle/libs.versions.toml');
  if (exists(path.join(dir, 'libs')) || exists(path.join(dir, 'lib'))) hints.push('has a libs/ or lib/ folder with jar files');
  const gp = props(path.join(dir, 'gradle.properties'));
  if (gp['org.gradle.java.home']) hints.push('gradle.properties pins org.gradle.java.home=' + gp['org.gradle.java.home']);
  if (exists(path.join(dir, 'Jenkinsfile'))) hints.push('has a Jenkinsfile (CI build steps can show the real build command)');
  if (exists(path.join(dir, '.gitlab-ci.yml'))) hints.push('has .gitlab-ci.yml (CI build steps can show the real build command)');
  if (exists(path.join(dir, 'azure-pipelines.yml'))) hints.push('has azure-pipelines.yml (CI build steps can show the real build command)');
  return hints;
}
