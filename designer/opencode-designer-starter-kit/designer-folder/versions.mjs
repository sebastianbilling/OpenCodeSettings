#!/usr/bin/env node
// versions.mjs - ideas, versions and the team's code for a designer who does not use Git.
//
// Lives in <project>\.designer\ and is run by the AI (or by a developer) from the project folder:
//   node .designer/versions.mjs <action> [arguments]
// Run without arguments for the list of actions.
//
// How it maps to Git (the designer never sees these words):
//   idea            = local branch       design/<idea>
//   version N       = annotated tag      design/<idea>/v<N>   (the message holds the title)
//   team's code     = local main branch, kept equal to <remote>/<main>
//   backup          = hidden ref         refs/design-backups/<time>   (made before anything is thrown away)
//   deleted things  = hidden refs        refs/design-trash/<time>/...
//   safety copy     = a git bundle of all of the above, outside the project folder
//
// Exit codes: 0 done, 1 problem (message says what), 2 a choice is needed (message lists the options).
// Only Node.js built-ins and the git command are used.

import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { fileURLToPath } from "node:url"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, "..")
const BACKUP_NS = "refs/design-backups/"
const TRASH_NS = "refs/design-trash/"
const MAX_BACKUPS = 200
const PUSH_BLOCK_URL = "PUSHING-IS-TURNED-OFF-ON-THIS-COMPUTER"

// ---------------------------------------------------------------- output helpers

class Stop extends Error {
  constructor(message, code = 1) {
    super(message)
    this.code = code
  }
}
const say = (...lines) => console.log(lines.join("\n"))
const problem = (msg) => {
  throw new Stop("PROBLEM: " + msg, 1)
}
const choice = (msg, options) => {
  const lines = ["CHOICE NEEDED: " + msg, "Ask the designer which one, then run the same command again with that option added:"]
  for (const [opt, text] of options) lines.push(`  ${opt.padEnd(20)} ${text}`)
  throw new Stop(lines.join("\n"), 2)
}

// ---------------------------------------------------------------- settings

function loadSettings() {
  const file = path.join(HERE, "settings.json")
  let s = {}
  if (fs.existsSync(file)) {
    try {
      s = JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""))
    } catch (e) {
      throw new Stop(`PROBLEM: .designer/settings.json is not valid JSON (${e.message}). In folder paths, write / or \\\\ instead of a single \\. Ask a developer to fix it.`)
    }
  }
  return {
    remote: s.remote || "origin",
    mainBranch: s.mainBranch || "",
    dependencyFiles: s.dependencyFiles || ["package.json", "package-lock.json"],
    safetyCopyFolder: s.safetyCopyFolder || path.join(os.homedir(), "Design safety copies"),
    helperName: s.helperName || "a developer",
  }
}
let S = { helperName: "a developer" }
try {
  S = loadSettings()
} catch (e) {
  console.log(e.message)
  process.exit(1)
}

// ---------------------------------------------------------------- git

const NO_HOOKS = path.join(HERE, "state", "no-hooks") // an empty folder: the team's Git hooks never run for the tool's own commands
function git(args, opts = {}) {
  const pre = ["-c", "core.quotePath=false"]
  if (!opts.raw) pre.push("-c", "core.hooksPath=" + NO_HOOKS)
  const r = spawnSync("git", [...pre, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    timeout: opts.timeout || 120000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", LANG: "C", LC_ALL: "C", ...(opts.env || {}) },
    input: opts.input,
    windowsHide: true,
  })
  if (r.error) {
    if (r.error.code === "ENOENT") throw new Stop("PROBLEM: the git program was not found. Ask " + S.helperName + " to check the Git installation.")
    if (r.error.code === "ETIMEDOUT") throw new Stop("PROBLEM: git took too long (" + args.slice(0, 2).join(" ") + "). Check the network connection and try again.")
    throw r.error
  }
  const out = (r.stdout || "").replace(/\s+$/, "")
  if (r.status !== 0 && !opts.allowFail) {
    const err = (r.stderr || r.stdout || "").trim()
    throw new Stop(`PROBLEM: git ${args.join(" ")} failed:\n${err}`)
  }
  return opts.full ? { ok: r.status === 0, out, err: (r.stderr || "").trim(), status: r.status } : out
}
const gitOk = (args) => git(args, { allowFail: true, full: true }).ok
const refExists = (ref) => gitOk(["rev-parse", "-q", "--verify", ref + "^{commit}"])
const revParse = (ref) => git(["rev-parse", "-q", "--verify", ref + "^{commit}"], { allowFail: true }) || ""

let GIT_DIR = ""
function checkRepo() {
  const r = git(["rev-parse", "--show-toplevel", "--absolute-git-dir"], { allowFail: true, full: true })
  if (!r.ok) problem(`${ROOT} is not a Git project folder. The .designer folder must sit directly inside the project.`)
  const [top, gd] = r.out.split(/\r?\n/)
  if (path.resolve(top).toLowerCase() !== ROOT.toLowerCase())
    problem(`The .designer folder must sit directly in the project's top folder (${top}).`)
  GIT_DIR = gd
}

let MAIN = ""
function mainBranch() {
  if (MAIN) return MAIN
  if (S.mainBranch) return (MAIN = S.mainBranch)
  const head = git(["symbolic-ref", "-q", "--short", `refs/remotes/${S.remote}/HEAD`], { allowFail: true })
  if (head) return (MAIN = head.slice(S.remote.length + 1))
  for (const b of ["main", "master", "develop", "trunk"]) if (refExists(`refs/remotes/${S.remote}/${b}`)) return (MAIN = b)
  for (const b of ["main", "master", "develop", "trunk"]) if (refExists(`refs/heads/${b}`)) return (MAIN = b)
  problem(`I can't tell which branch holds the team's code. Ask ${S.helperName} to set "mainBranch" in .designer/settings.json.`)
}
const MAIN_REF = () => `refs/heads/${mainBranch()}`
const REMOTE_MAIN = () => `refs/remotes/${S.remote}/${mainBranch()}`

// ---------------------------------------------------------------- names

function slug(text) {
  let s = String(text || "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "")
  if (!s) problem(`"${text}" can't be used as an idea name. Use letters and numbers, e.g. "new-checkout".`)
  if (!/^[a-z]/.test(s)) s = "idea-" + s
  return s
}
function cleanTitle(t) {
  const s = String(t || "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100)
  return s
}
const ideaRef = (idea) => `refs/heads/design/${idea}`
const versionTag = (idea, n) => `design/${idea}/v${n}`
const versionRef = (idea, n) => `refs/tags/${versionTag(idea, n)}`

// ---------------------------------------------------------------- dates

function fmtDate(iso) {
  if (!iso) return "unknown date"
  const d = new Date(iso)
  if (isNaN(d)) return iso
  const p = (n) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}
function ago(iso) {
  const d = new Date(iso)
  if (isNaN(d)) return ""
  const days = Math.floor((startOfDay(new Date()) - startOfDay(d)) / 86400000)
  if (days <= 0) return "today"
  if (days === 1) return "yesterday"
  return `${days} days ago`
}
function startOfDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}
function stamp() {
  const d = new Date()
  const p = (n, w = 2) => String(n).padStart(w, "0")
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${p(d.getMilliseconds(), 3)}`
}
const commitDate = (ref) => git(["log", "-1", "--format=%cI", ref], { allowFail: true })

// ---------------------------------------------------------------- reading state

/** All versions: [{idea, n, tag, ref, commit, date, title, body}] sorted by idea, n */
function allVersions() {
  const fmt = "%(refname)%1f%(*objectname)%1f%(objectname)%1f%(taggerdate:iso-strict)%1f%(contents:subject)%1f%(contents:body)%1e"
  const out = git(["for-each-ref", "--format=" + fmt, "refs/tags/design/"], { allowFail: true })
  const list = []
  for (const rec of out.split("\x1e")) {
    const f = rec.replace(/^\s+/, "").split("\x1f")
    if (f.length < 5) continue
    const m = /^refs\/tags\/design\/([a-z0-9][a-z0-9-]*)\/v(\d+)$/.exec(f[0])
    if (!m) continue
    list.push({ idea: m[1], n: Number(m[2]), tag: f[0].slice(10), ref: f[0], commit: f[1] || f[2], date: f[3], title: f[4], body: f[5] || "" })
  }
  return list.sort((a, b) => (a.idea < b.idea ? -1 : a.idea > b.idea ? 1 : a.n - b.n))
}
const versionsOf = (idea) => allVersions().filter((v) => v.idea === idea)

function allIdeas() {
  const names = new Set(git(["for-each-ref", "--format=%(refname:strip=3)", "refs/heads/design/"], { allowFail: true }).split(/\r?\n/).filter(Boolean))
  for (const v of allVersions()) names.add(v.idea)
  return [...names].sort()
}

function currentBranch() {
  return git(["symbolic-ref", "-q", "--short", "HEAD"], { allowFail: true })
}
function currentIdea() {
  const b = currentBranch()
  return b.startsWith("design/") ? b.slice(7) : ""
}

/** Versions whose commit is exactly the given commit. */
function versionsAt(commit) {
  if (!commit) return []
  return allVersions().filter((v) => v.commit === commit)
}

/** The version the working copy is based on, within the current idea (or anywhere). */
function baseVersion(idea) {
  const head = revParse("HEAD")
  const here = versionsAt(head)
  const same = here.find((v) => v.idea === idea)
  if (same) return { v: same, exact: true }
  if (here.length) return { v: here[here.length - 1], exact: true }
  if (!idea) return { v: null, exact: false }
  const d = git(["describe", "--tags", "--abbrev=0", "--match", `design/${idea}/v*`, "HEAD"], { allowFail: true })
  if (d) {
    const v = versionsOf(idea).find((x) => x.tag === d)
    if (v) return { v, exact: false }
  }
  return { v: null, exact: false }
}

/** Unsaved changes, as [{kind, path}] */
function unsaved() {
  const r = spawnSync("git", ["-c", "core.hooksPath=" + NO_HOOKS, "status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd: ROOT, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, windowsHide: true, timeout: 120000, env: { ...process.env, LANG: "C", LC_ALL: "C" } })
  if (r.error || r.status !== 0)
    throw new Stop(`PROBLEM: Git could not list the changed files, so nothing was done (${((r.stderr || "") + (r.error ? r.error.message : "")).trim().split("\n")[0]}). Run "node .designer/versions.mjs doctor".`)
  const out = r.stdout || ""
  const parts = out.split("\0")
  const list = []
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i]
    if (!e) continue
    const xy = e.slice(0, 2)
    const p = e.slice(3)
    if (xy[0] === "R" || xy[0] === "C") i++ // skip the old name
    let kind = "changed"
    if (xy === "??" || xy[0] === "A") kind = "new"
    else if (xy.includes("D")) kind = "deleted"
    else if (xy.includes("U") || xy === "AA" || xy === "DD") kind = "clash"
    list.push({ kind, path: p })
  }
  return list
}

function inProgress() {
  const f = (n) => fs.existsSync(path.join(GIT_DIR, n))
  if (f("MERGE_HEAD")) return fs.existsSync(updateMarker()) ? "update" : "merge"
  if (f("rebase-merge") || f("rebase-apply")) return "rebase"
  if (f("CHERRY_PICK_HEAD")) return "cherry-pick"
  if (f("REVERT_HEAD")) return "revert"
  return ""
}
const updateMarker = () => path.join(GIT_DIR, "design-update.json")

function teamInfo() {
  const main = mainBranch()
  const local = revParse(MAIN_REF())
  const fetchHead = path.join(GIT_DIR, "FETCH_HEAD")
  const lastDownload = fs.existsSync(fetchHead) ? fs.statSync(fetchHead).mtime.toISOString() : ""
  return { main, local, date: local ? commitDate(local) : "", lastDownload }
}

function describeVersion(v) {
  return `version ${v.n} "${v.title}" (saved ${fmtDate(v.date)})`
}

// ---------------------------------------------------------------- safety helpers

/** Make a hidden backup of everything unsaved (tracked and new files). Returns the backup ref or "". */
function backup(reason) {
  const changes = unsaved()
  if (!changes.length) return ""
  const idx = path.join(GIT_DIR, "design-backup-index")
  try {
    fs.rmSync(idx, { force: true })
    const env = { GIT_INDEX_FILE: idx }
    const head = revParse("HEAD")
    if (head) git(["read-tree", head], { env })
    git(["add", "-A", "--", "."], { env })
    const tree = git(["write-tree"], { env })
    const idea = currentIdea()
    const base = baseVersion(idea).v
    const where = idea ? `idea ${idea}` + (base ? ` v${base.n}` : "") : currentBranch() ? `the team's code (${currentBranch()})` : "no idea"
    const msg = [`Backup before ${reason}`, "", `Where: ${where}`, `Files: ${changes.length}`, ...changes.slice(0, 50).map((c) => `  ${c.kind} ${c.path}`)].join("\n")
    const args = ["commit-tree", tree, "-m", msg]
    if (head) args.splice(2, 0, "-p", head)
    const commit = git(args, { env: identityEnv() })
    const ref = BACKUP_NS + stamp()
    git(["update-ref", ref, commit])
    pruneBackups()
    return ref
  } finally {
    fs.rmSync(idx, { force: true })
    fs.rmSync(idx + ".lock", { force: true })
  }
}

function pruneBackups() {
  const refs = git(["for-each-ref", "--sort=-refname", "--format=%(refname)", BACKUP_NS], { allowFail: true }).split(/\r?\n/).filter(Boolean)
  for (const r of refs.slice(MAX_BACKUPS)) git(["update-ref", "-d", r], { allowFail: true })
}

function trash(ref, label) {
  const target = git(["rev-parse", ref])
  const name = TRASH_NS + stamp() + "/" + label
  git(["update-ref", name, target])
}

let IDENTITY = null
function identityEnv() {
  if (IDENTITY) return IDENTITY
  const name = git(["config", "user.name"], { allowFail: true })
  const email = git(["config", "user.email"], { allowFail: true })
  IDENTITY = {}
  if (!name) Object.assign(IDENTITY, { GIT_AUTHOR_NAME: "Designer", GIT_COMMITTER_NAME: "Designer" })
  if (!email) Object.assign(IDENTITY, { GIT_AUTHOR_EMAIL: "designer@localhost", GIT_COMMITTER_EMAIL: "designer@localhost" })
  return IDENTITY
}

function writeSafetyCopy() {
  try {
    const dir = S.safetyCopyFolder
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, path.basename(ROOT) + ".bundle")
    const tmp = file + ".tmp"
    const args = ["bundle", "create", "-q", tmp, "--branches=design/*", "--tags=design/*", `--glob=${BACKUP_NS}*`, `--glob=${TRASH_NS}*`]
    const exclude = refExists(REMOTE_MAIN()) ? REMOTE_MAIN() : refExists(MAIN_REF()) ? MAIN_REF() : ""
    if (exclude) args.push("--not", exclude)
    const r = git(args, { allowFail: true, full: true, timeout: 300000 })
    if (!r.ok) {
      fs.rmSync(tmp, { force: true })
      if (/empty bundle/i.test(r.err)) return "nothing to copy yet"
      return "could not write the safety copy: " + r.err.split("\n")[0]
    }
    if (fs.existsSync(file)) fs.copyFileSync(file, path.join(dir, path.basename(ROOT) + ".previous.bundle"))
    fs.renameSync(tmp, file)
    return "ok"
  } catch (e) {
    return "could not write the safety copy: " + e.message
  }
}

function depsChanged(fromCommit, toCommit) {
  if (!fromCommit || !toCommit || fromCommit === toCommit) return false
  const r = git(["diff", "--name-only", fromCommit, toCommit, "--", ...S.dependencyFiles], { allowFail: true })
  return r.length > 0
}
const DEPS_NOTE = "The app's building blocks (package files) are different here. Restart the app so they are installed: node .designer/app.mjs restart"

// ---------------------------------------------------------------- guards

function parseOpts(args) {
  const opts = { _: [] }
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === "--save") opts.save = args[++i] ?? ""
    else if (a === "--discard") opts.discard = true
    else if (a === "--idea") opts.idea = args[++i] ?? ""
    else if (a === "--from-here") opts.fromHere = true
    else if (a === "--continue") opts.continue = true
    else if (a === "--abort") opts.abort = true
    else if (a === "--use") {
      opts.use = args[++i]
      opts.useFiles = []
      while (i + 1 < args.length && !args[i + 1].startsWith("--")) opts.useFiles.push(args[++i])
    } else if (a === "--no-download") opts.noDownload = true
    else if (a === "--yes") opts.yes = true
    else if (a === "--keep") opts.keep = true
    else opts._.push(a)
  }
  return opts
}

function refuseIfStuck(action) {
  const p = inProgress()
  if (!p) return
  if (p === "update")
    problem(`An update of this idea with the team's code is half-done (some places clash). Finish it first:
  node .designer/versions.mjs update-idea --continue   (after the clashes are fixed)
  node .designer/versions.mjs update-idea --abort      (to cancel the update)`)
  problem(`Git is in the middle of a ${p} that was started outside this tool. Run "node .designer/versions.mjs doctor" to clean it up, then try "${action}" again.`)
}

/** Deal with unsaved changes before leaving the current version. */
function settleUnsaved(opts, leaving) {
  const changes = unsaved()
  if (!changes.length) return ""
  if (opts.save !== undefined) {
    const title = cleanTitle(opts.save)
    if (!title) problem('--save needs a title, e.g. --save "Bigger buttons"')
    if (!currentIdea()) {
      if (!opts.idea) choice("there are unsaved changes on the team's code. To save them, they need an idea name.", [["--idea <name> --save <title>", "save them as the first version of a new idea"], ["--discard", "throw them away (a backup is kept)"]])
    }
    const msg = doSave(title, opts.idea, true)
    return msg
  }
  if (opts.discard) {
    const ref = backup(leaving)
    discardAll()
    writeSafetyCopy()
    return `Threw away unsaved changes in ${changes.length} file(s) (backup ${ref.slice(BACKUP_NS.length)} keeps them).`
  }
  const idea = currentIdea()
  const base = baseVersion(idea).v
  const where = idea ? `idea "${idea}"` + (base ? ` (on top of version ${base.n})` : "") : "the team's code"
  const next = idea ? nextNumber(idea) : 1
  choice(`there are unsaved changes in ${changes.length} file(s) on ${where}.`, [
    ['--save "<title>"', idea ? `save them first as version ${next}` : "save them first (also needs --idea <name>)"],
    ["--discard", "throw them away (a backup is kept)"],
  ])
}

function discardAll() {
  git(["reset", "-q", "--hard", "HEAD"])
  git(["clean", "-q", "-fd"])
}

function nextNumber(idea) {
  const nums = versionsOf(idea).map((v) => v.n)
  for (const e of trashEntries()) if (e.idea === idea && /^v\d+$/.test(e.what)) nums.push(Number(e.what.slice(1)))
  return nums.length ? Math.max(...nums) + 1 : 1
}

/** Make sure the tip of an idea branch is a saved version, so moving the branch loses nothing. */
function protectTip(idea) {
  const tip = revParse(ideaRef(idea))
  if (!tip) return
  if (versionsAt(tip).some((v) => v.idea === idea)) return
  const main = revParse(MAIN_REF())
  if (tip === main) return
  if (main && gitOk(["merge-base", "--is-ancestor", tip, main])) return
  const n = nextNumber(idea)
  git(["tag", "-a", versionTag(idea, n), tip, "-m", `Kept automatically (was not saved as a version)\n\nIdea: ${idea}\nSaved: ${fmtDate(new Date().toISOString())}`], { env: identityEnv() })
}

// ---------------------------------------------------------------- resolving "which version"

function findVersion(words) {
  // Accepts: "<idea> <n>", "<idea> v<n>", "<idea>/v<n>", "design/<idea>/v<n>", "<n>" or "v<n>" (current idea), "<idea>" (latest)
  const text = words.join(" ").trim()
  if (!text) problem("Which version? Give an idea name and a version number, e.g. checkout 2")
  const known = (i) => refExists(ideaRef(i)) || versionsOf(i).length > 0
  let m
  let idea, n
  if ((m = /^(?:version\s+)?v?(\d+)$/i.exec(text))) {
    idea = currentIdea()
    if (!idea) problem(`You are on the team's code, so "${text}" is ambiguous. Give the idea name too, e.g. checkout ${m[1]}`)
    n = Number(m[1])
  } else if ((m = /^(?:design\/)?(.+?)(?:\s*\/\s*|\s+)(?:version\s+)?v?(\d+)$/i.exec(text)) && (known(slug(m[1])) || !known(slug(text)))) {
    idea = slug(m[1])
    n = Number(m[2])
  } else {
    idea = slug(text.replace(/^design\//i, ""))
  }
  const vs = versionsOf(idea)
  if (!vs.length) {
    if (refExists(ideaRef(idea))) return { idea, v: null }
    const ideas = allIdeas()
    problem(`There is no idea called "${idea}".` + (ideas.length ? ` Ideas: ${ideas.join(", ")}.` : " No ideas exist yet."))
  }
  if (n === undefined) return { idea, v: vs[vs.length - 1] }
  const v = vs.find((x) => x.n === n)
  if (!v) problem(`Idea "${idea}" has no version ${n}. It has: ${vs.map((x) => "v" + x.n).join(", ")}.`)
  return { idea, v }
}

// ---------------------------------------------------------------- actions

function doSave(title, ideaName, quiet = false) {
  refuseIfStuck("save")
  let idea = currentIdea()
  const branch = currentBranch()
  if (!branch) problem('The project is not on any idea right now. Run "node .designer/versions.mjs doctor" first.')
  if (!idea) {
    if (!ideaName) choice(`this is the team's code (${branch}), not an idea. A save needs an idea name.`, [["--idea <name>", "start a new idea with these changes as its first version"]])
    idea = slug(ideaName)
    if (refExists(ideaRef(idea)) || versionsOf(idea).length) problem(`An idea called "${idea}" already exists. Pick another name.`)
    git(["switch", "-q", "-c", "design/" + idea])
  }
  const before = baseVersion(idea).v
  git(["add", "-A", "--", "."])
  const staged = !gitOk(["diff", "--cached", "--quiet"])
  const head = revParse("HEAD")
  const headIsVersion = versionsAt(head).some((v) => v.idea === idea)
  if (!staged && headIsVersion) {
    const v = versionsAt(head).find((x) => x.idea === idea)
    const m = `Nothing new to save: what you see is exactly ${describeVersion(v)} of idea "${idea}".`
    return quiet ? m : say(m)
  }
  if (!staged && revParse(MAIN_REF()) && gitOk(["merge-base", "--is-ancestor", head, MAIN_REF()])) {
    const m = `Nothing to save yet: idea "${idea}" has no changes compared with the team's code.`
    return quiet ? m : say(m)
  }
  const n = nextNumber(idea)
  if (staged) git(["commit", "-q", "--no-verify", "-m", `Design ${idea} v${n}: ${title}`], { env: identityEnv() })
  const basedOn = before
    ? `version ${before.n} "${before.title}"` + (before.idea !== idea ? ` of idea "${before.idea}"` : "")
    : `the team's code from ${fmtDate(commitDate(MAIN_REF()))}`
  git(["tag", "-a", versionTag(idea, n), "-m", `${title}\n\nIdea: ${idea}\nBased on: ${basedOn}\nSaved: ${fmtDate(new Date().toISOString())}`], { env: identityEnv() })
  const copy = writeSafetyCopy()
  const lines = [`Saved as version ${n} of idea "${idea}": "${title}".`, `(Based on ${basedOn}.)`]
  if (copy !== "ok" && copy !== "nothing to copy yet") lines.push("Note: " + copy)
  if (quiet) return lines.join(" ")
  say(...lines)
}

function actSave(opts) {
  const title = cleanTitle(opts._.join(" "))
  if (!title) problem('Give the version a short title, e.g.: node .designer/versions.mjs save "Bigger buttons"')
  if (!unsaved().length) {
    const idea = currentIdea()
    const v = idea && versionsAt(revParse("HEAD")).find((x) => x.idea === idea)
    if (v) return say(`Nothing new to save: what you see is exactly ${describeVersion(v)} of idea "${idea}".`)
    if (!idea) return say("Nothing to save: there are no changes to the team's code.")
  }
  doSave(title, opts.idea)
}

function actStatus() {
  const lines = []
  const p = inProgress()
  const branch = currentBranch()
  const idea = currentIdea()
  const head = revParse("HEAD")
  if (!branch) lines.push(`The project is not on any idea or on the team's code (Git calls this "detached"). Run "node .designer/versions.mjs doctor" to fix it.`)
  else if (idea) {
    const { v, exact } = baseVersion(idea)
    if (v && exact) lines.push(`You are on idea "${idea}", ${describeVersion(v)}.`)
    else if (v) lines.push(`You are on idea "${idea}", based on ${describeVersion(v)} (with later changes that are not a version yet).`)
    else lines.push(`You are on idea "${idea}". It has no saved version yet.`)
    lines.push(`The next save becomes version ${nextNumber(idea)}.`)
  } else if (branch === mainBranch()) lines.push(`You are looking at the team's code (no idea). Changes made here need an idea name when you save them.`)
  else lines.push(`You are on "${branch}", which is not one of your ideas and not the team's main code. "team-code" takes you back to the team's code.`)

  if (p === "update") lines.push("An update with the team's code is half-done: some places clash. Fix them, then run update-idea --continue, or cancel with update-idea --abort.")
  else if (p) lines.push(`Git is in the middle of a ${p} started outside this tool. Run doctor.`)

  const changes = unsaved()
  if (changes.length) {
    lines.push(`Unsaved changes in ${changes.length} file(s):`)
    for (const c of changes.slice(0, 25)) lines.push(`  ${c.kind.padEnd(8)} ${c.path}`)
    if (changes.length > 25) lines.push(`  ... and ${changes.length - 25} more`)
  } else lines.push("No unsaved changes.")

  const t = teamInfo()
  if (t.local) {
    let line = `The team's code on this computer is from ${fmtDate(t.date)}`
    line += t.lastDownload ? ` (last download ${ago(t.lastDownload)}, ${fmtDate(t.lastDownload)}).` : " (never downloaded with get-latest)."
    lines.push(line)
    if (idea && head && p !== "update") {
      const behind = Number(git(["rev-list", "--count", `HEAD..${MAIN_REF()}`], { allowFail: true }) || 0)
      if (behind > 0) lines.push(`This idea does not have the team's ${behind} newest change(s). "update-idea" brings them in as a new version.`)
      else lines.push("This idea includes all of the team's code on this computer.")
    }
  }
  say(...lines)
}

function actList(opts) {
  const only = opts._.length ? slug(opts._.join(" ")) : ""
  const ideas = allIdeas().filter((i) => !only || i === only)
  const cur = currentIdea()
  const head = revParse("HEAD")
  const changes = unsaved().length
  if (!ideas.length) {
    say(only ? `There is no idea called "${only}".` : "No ideas yet. Start one with new-idea <name>, or save changes with save <title> --idea <name>.")
    return
  }
  const lines = ["Ideas and their versions:", ""]
  const all = allVersions()
  for (const idea of ideas) {
    const here = idea === cur
    const vs = all.filter((v) => v.idea === idea)
    let head1 = (here ? "* " : "  ") + idea
    if (here) {
      const at = vs.find((v) => v.commit === head)
      head1 += at ? `   <- you are here: version ${at.n}` : "   <- you are here"
      if (inProgress() === "update") head1 += " (an update with the team's code is half-done)"
      else if (changes) head1 += `, plus unsaved changes`
    }
    lines.push(head1)
    if (!vs.length) lines.push("      (no saved versions yet)")
    for (const v of vs) {
      const mark = here && v.commit === head ? "  <- open now" : ""
      lines.push(`      v${String(v.n).padEnd(3)} ${fmtDate(v.date)}  ${v.title}${mark}`)
    }
  }
  if (!cur && currentBranch() === mainBranch()) lines.push("", "You are on the team's code (no idea open)" + (changes ? ", with unsaved changes." : "."))
  say(...lines)
}

function download() {
  const r = git(["fetch", "--prune", "--no-tags", S.remote], { allowFail: true, full: true, timeout: 180000 })
  if (!r.ok) {
    const err = r.err.toLowerCase()
    let why = "the Git server could not be reached"
    if (/auth|credential|permission|403|401|denied/.test(err)) why = "the Git server did not accept the login"
    else if (/could not resolve|unable to access|timed out|connection|network/.test(err)) why = "the Git server could not be reached (network)"
    problem(`Could not download the team's code: ${why}. Try again later or ask ${S.helperName}.\nDetails: ${r.err.split("\n").slice(-3).join(" ")}`)
  }
}

/** Make local main equal to remote main. Returns {before, after, rescued}. */
function syncMain() {
  const before = revParse(MAIN_REF())
  const remote = revParse(REMOTE_MAIN())
  if (!remote) problem(`The server has no branch "${mainBranch()}". Ask ${S.helperName} to set "mainBranch" in .designer/settings.json.`)
  let rescued = ""
  if (before && !gitOk(["merge-base", "--is-ancestor", before, remote])) {
    // Someone saved straight onto the team's code. Keep that work as an idea, then reset.
    rescued = "rescued-" + stamp().slice(0, 13)
    git(["branch", "design/" + rescued, before])
    git(["tag", "-a", versionTag(rescued, 1), before, "-m", `Work found on the team's code\n\nIdea: ${rescued}\nSaved: ${fmtDate(new Date().toISOString())}`], { env: identityEnv() })
  }
  if (currentBranch() === mainBranch()) {
    if (before !== remote) git(["reset", "-q", "--keep", remote])
  } else {
    git(["update-ref", MAIN_REF(), remote])
  }
  if (!gitOk(["config", `branch.${mainBranch()}.remote`])) {
    git(["config", `branch.${mainBranch()}.remote`, S.remote], { allowFail: true })
    git(["config", `branch.${mainBranch()}.merge`, MAIN_REF()], { allowFail: true })
  }
  return { before, after: remote, rescued }
}

function summarizeNew(before, after) {
  if (!before || before === after) return []
  const subjects = git(["log", "--no-merges", "--format=%s", "-n", "8", `${before}..${after}`], { allowFail: true }).split(/\r?\n/).filter(Boolean)
  return subjects
}

function actGetLatest(opts) {
  refuseIfStuck("get-latest")
  const pre = []
  if (currentBranch() === mainBranch() && unsaved().length) {
    const settled = settleUnsaved(opts, "downloading the team's newest code")
    if (settled) pre.push(settled)
  }
  const onMain = currentBranch() === mainBranch()
  download()
  const { before, after, rescued } = syncMain()
  const lines = [...pre]
  const count = before ? Number(git(["rev-list", "--count", `${before}..${after}`], { allowFail: true }) || 0) : 0
  if (!before) lines.push(`Downloaded the team's code (from ${fmtDate(commitDate(after))}).`)
  else if (count === 0) lines.push(`Downloaded: nothing new. The team's code is still from ${fmtDate(commitDate(after))}.`)
  else {
    lines.push(`Downloaded ${count} new change(s) from the team. The team's code is now from ${fmtDate(commitDate(after))}.`)
    const subj = summarizeNew(before, after)
    if (subj.length) lines.push("Latest change descriptions (developer wording):", ...subj.map((s) => "  - " + s))
  }
  if (rescued) lines.push(`Note: there was saved work directly on the team's code. It is kept as idea "${rescued}" (version 1).`)
  const idea = currentIdea()
  if (onMain) {
    lines.push("You are on the team's code, so you now see the newest version.")
    if (depsChanged(before, after)) lines.push(DEPS_NOTE)
  } else if (idea) {
    const behind = Number(git(["rev-list", "--count", `HEAD..${MAIN_REF()}`], { allowFail: true }) || 0)
    if (behind > 0) lines.push(`Your idea "${idea}" is unchanged and does not have the newest team code yet. "update-idea" brings it in as a new version; a new idea always starts from the newest team code.`)
    else lines.push(`Your idea "${idea}" already includes everything.`)
  }
  say(...lines)
}

function actNewIdea(opts) {
  refuseIfStuck("new-idea")
  const name = slug(opts._.join(" "))
  if (refExists(ideaRef(name)) || versionsOf(name).length) problem(`An idea called "${name}" already exists. Pick another name, or open it.`)
  const notes = []
  if (opts.fromHere) {
    // copy of where we are now, unsaved changes included
    const from = currentIdea()
    const base = baseVersion(from).v
    git(["switch", "-q", "-c", "design/" + name])
    say(`Started idea "${name}" as a copy of ${from ? `idea "${from}"` + (base ? ` version ${base.n}` : "") : "the team's code"}${unsaved().length ? ", including the unsaved changes" : ""}. Nothing is saved in it yet.`)
    return
  }
  const onMainWithChanges = currentBranch() === mainBranch() && unsaved().length
  if (onMainWithChanges && opts.keep) {
    git(["switch", "-q", "-c", "design/" + name])
    return say(`Started idea "${name}" from the team's code, with the unsaved changes carried over. Nothing is saved in it yet.`)
  }
  if (onMainWithChanges && opts.save === undefined && !opts.discard)
    choice(`there are unsaved changes on the team's code (${unsaved().length} file(s)).`, [
      ["--keep", `carry them into the new idea "${name}"`],
      ["--discard", "throw them away (a backup is kept)"],
    ])
  const settled = settleUnsaved(opts, `starting idea ${name}`)
  if (settled) notes.push(settled)
  const old = revParse("HEAD")
  if (!opts.noDownload) {
    try {
      download()
      syncMain()
    } catch (e) {
      notes.push("Could not download the newest team code, so the idea starts from the team's code already on this computer. " + e.message.replace(/^PROBLEM: /, ""))
    }
  }
  if (!revParse(MAIN_REF())) {
    if (refExists(REMOTE_MAIN())) git(["branch", mainBranch(), REMOTE_MAIN()])
    else problem("The team's code is not on this computer yet. Run get-latest first.")
  }
  git(["switch", "-q", "-c", "design/" + name, MAIN_REF()])
  notes.push(`Started idea "${name}" from the team's code of ${fmtDate(commitDate(MAIN_REF()))}. Nothing is saved in it yet; save when you like what you see.`)
  if (depsChanged(old, revParse("HEAD"))) notes.push(DEPS_NOTE)
  say(...notes)
}

function actOpen(opts) {
  refuseIfStuck("open")
  const { idea, v } = findVersion(opts._)
  const head = revParse("HEAD")
  const target = v ? v.commit : revParse(ideaRef(idea))
  if (currentIdea() === idea && head === target) {
    const changes = unsaved().length
    return say(v ? `You are already on ${describeVersion(v)} of idea "${idea}".` + (changes ? ` There are unsaved changes on top of it (${changes} file(s)).` : "") : `You are already on idea "${idea}".`)
  }
  const notes = []
  const settled = settleUnsaved(opts, `opening ${idea}${v ? " v" + v.n : ""}`)
  if (settled) notes.push(settled)
  protectTip(idea)
  if (!refExists(ideaRef(idea))) git(["branch", "design/" + idea, target])
  if (currentIdea() !== idea) git(["switch", "-q", "design/" + idea])
  if (revParse("HEAD") !== target) git(["reset", "-q", "--hard", target])
  const latest = versionsOf(idea).slice(-1)[0]
  if (v) {
    notes.push(`Now showing idea "${idea}", ${describeVersion(v)}.`)
    if (latest && latest.n !== v.n) notes.push(`This is not the newest version (that is version ${latest.n}). Nothing is lost: all versions stay. Changes you save from here become version ${latest.n + 1}, based on version ${v.n}.`)
  } else notes.push(`Now on idea "${idea}" (no saved versions yet).`)
  notes.push("The browser updates by itself; press F5 if it doesn't.")
  if (depsChanged(head, target)) notes.push(DEPS_NOTE)
  say(...notes)
}

function actTeamCode(opts) {
  refuseIfStuck("team-code")
  if (currentBranch() === mainBranch() && !unsaved().length) return say("You are already looking at the team's code.")
  const notes = []
  const head = revParse("HEAD")
  if (currentBranch() !== mainBranch()) {
    const settled = settleUnsaved(opts, "going to the team's code")
    if (settled) notes.push(settled)
    if (!revParse(MAIN_REF())) {
      if (refExists(REMOTE_MAIN())) git(["branch", mainBranch(), REMOTE_MAIN()])
      else problem("The team's code is not on this computer yet. Run get-latest first.")
    }
    git(["switch", "-q", mainBranch()])
  } else {
    const settled = settleUnsaved(opts, "going to the team's code")
    if (settled) notes.push(settled)
  }
  notes.push(`Now showing the team's code from ${fmtDate(commitDate(MAIN_REF()))}, without any of your ideas. (get-latest downloads newer team code.)`)
  if (depsChanged(head, revParse("HEAD"))) notes.push(DEPS_NOTE)
  say(...notes)
}

function actUpdateIdea(opts) {
  const marker = updateMarker()
  if (opts.abort) {
    if (inProgress() !== "update" && inProgress() !== "merge") return say("No update is in progress.")
    git(["merge", "--abort"], { allowFail: true })
    fs.rmSync(marker, { force: true })
    return say("Cancelled the update. The idea is exactly as it was before.")
  }
  if (opts.use) {
    if (inProgress() !== "update") problem("No update is in progress.")
    const side = opts.use === "team" ? "--theirs" : opts.use === "mine" ? "--ours" : ""
    if (!side || !opts.useFiles.length) problem("Use: update-idea --use team <file> ...   or   update-idea --use mine <file> ...")
    for (const f of opts.useFiles) {
      const r = git(["checkout", side, "--", f], { allowFail: true, full: true })
      if (!r.ok) {
        // that side deleted the file
        git(["rm", "-q", "-f", "--", f], { allowFail: true })
      } else git(["add", "--", f])
    }
    return say(`Took the ${opts.use === "team" ? "team's" : "idea's"} version of ${opts.useFiles.length} file(s). Run update-idea --continue when all clashes are fixed.`)
  }
  if (opts.continue) {
    if (inProgress() !== "update") problem("No update is in progress.")
    const info = JSON.parse(fs.readFileSync(marker, "utf8"))
    const unmerged = git(["diff", "--name-only", "--diff-filter=U"], { allowFail: true }).split(/\r?\n/).filter(Boolean)
    const still = unmerged.filter((f) => hasMarkers(path.join(ROOT, f)))
    if (still.length) problem(`These files still contain clash markers (<<<<<<<, =======, >>>>>>>): ${still.join(", ")}. Fix them first.`)
    git(["add", "-A", "--", "."])
    git(["commit", "-q", "--no-verify", "--no-edit", "-m", `Design ${info.idea} v${info.next}: ${info.title}`], { env: identityEnv() })
    fs.rmSync(marker, { force: true })
    return finishUpdate(info)
  }
  refuseIfStuck("update-idea")
  const idea = currentIdea()
  if (!idea) problem("You are not on an idea. Open an idea first; the team's code is updated with get-latest.")
  const notes = []
  const settled = settleUnsaved(opts, "updating the idea")
  if (settled) notes.push(settled)
  if (!opts.noDownload) {
    download()
    const s = syncMain()
    if (s.rescued) notes.push(`Note: work found on the team's code was kept as idea "${s.rescued}".`)
  }
  const behind = Number(git(["rev-list", "--count", `HEAD..${MAIN_REF()}`], { allowFail: true }) || 0)
  if (!behind) return say(...notes, `Idea "${idea}" already has all of the team's code (from ${fmtDate(commitDate(MAIN_REF()))}). Nothing to update.`)
  if (gitOk(["merge-base", "--is-ancestor", "HEAD", MAIN_REF()]) && !versionsAt(revParse("HEAD")).some((v) => v.idea === idea)) {
    git(["merge", "-q", "--ff-only", MAIN_REF()])
    return say(...notes, `Idea "${idea}" had no saved changes yet, so it now simply starts from the team's newest code (${fmtDate(commitDate(MAIN_REF()))}).`)
  }
  protectTip(idea)
  const base = baseVersion(idea).v
  const next = nextNumber(idea)
  const teamDay = fmtDate(commitDate(MAIN_REF())).slice(0, 10)
  const title = cleanTitle(base ? `Version ${base.n} + the team's code of ${teamDay}` : `Updated with the team's code of ${teamDay}`)
  const info = { idea, next, title, from: base ? base.n : 0, before: revParse("HEAD") }
  const r = git(["merge", "--no-ff", "--no-commit", MAIN_REF()], { allowFail: true, full: true, env: identityEnv() })
  const unmerged = git(["diff", "--name-only", "--diff-filter=U"], { allowFail: true }).split(/\r?\n/).filter(Boolean)
  if (!r.ok && !unmerged.length) {
    git(["merge", "--abort"], { allowFail: true })
    problem("The update could not start: " + (r.err || r.out).split("\n").slice(-2).join(" "))
  }
  if (unmerged.length) {
    fs.writeFileSync(marker, JSON.stringify(info))
    say(
      ...notes,
      `The team changed some of the same places as idea "${idea}". ${unmerged.length} file(s) clash and must be combined by hand:`,
      ...unmerged.map((f) => "  " + f),
      "In each file, the clashing parts sit between <<<<<<< (the idea), ======= and >>>>>>> (the team). Keep the idea's design and the team's new behaviour, and remove the marker lines.",
      "Or take one side for a whole file:  update-idea --use mine <file>   /   update-idea --use team <file>",
      "Then: update-idea --continue      To cancel everything: update-idea --abort",
    )
    throw new Stop("", 2)
  }
  if (gitOk(["rev-parse", "-q", "--verify", "MERGE_HEAD"])) git(["commit", "-q", "--no-verify", "--no-edit", "-m", `Design ${idea} v${next}: ${title}`], { env: identityEnv() })
  notes.push(finishUpdate(info, true))
  say(...notes)
}

function hasMarkers(file) {
  try {
    const t = fs.readFileSync(file, "utf8")
    return /^<{7}( |$)/m.test(t) || /^>{7}( |$)/m.test(t)
  } catch {
    return false
  }
}

function finishUpdate(info, quiet = false) {
  const basedOn = info.from ? `version ${info.from} plus the team's newest code` : "the idea plus the team's newest code"
  git(["tag", "-a", versionTag(info.idea, info.next), "-m", `${info.title}\n\nIdea: ${info.idea}\nBased on: ${basedOn}\nSaved: ${fmtDate(new Date().toISOString())}`], { env: identityEnv() })
  writeSafetyCopy()
  const msg = [`Idea "${info.idea}" now has the team's newest code. Saved automatically as version ${info.next}: "${info.title}". The earlier versions are unchanged.`]
  if (depsChanged(info.before, revParse("HEAD"))) msg.push(DEPS_NOTE)
  if (quiet) return msg.join(" ")
  say(...msg)
}

function actDiscard(opts) {
  const p = inProgress()
  if (p === "update") {
    git(["merge", "--abort"], { allowFail: true })
    fs.rmSync(updateMarker(), { force: true })
  }
  const changes = unsaved()
  if (!changes.length) return say(p === "update" ? "Cancelled the half-done update. No unsaved changes." : "There are no unsaved changes to throw away.")
  const files = opts._
  const idea = currentIdea()
  const base = baseVersion(idea).v
  if (!files.length) {
    const ref = backup("throwing away all unsaved changes")
    discardAll()
    writeSafetyCopy()
    return say(
      `Threw away unsaved changes in ${changes.length} file(s).`,
      base ? `Back to ${describeVersion(base)} of idea "${idea}".` : idea ? `Back to where idea "${idea}" started.` : "Back to the team's code.",
      `Backup ${ref.slice(BACKUP_NS.length)} keeps what was thrown away, if it's ever needed.`,
    )
  }
  const ref = backup("throwing away changes in " + files.join(", "))
  const tracked = []
  for (const f of files) {
    const c = changes.find((x) => x.path === f.replace(/\\/g, "/") || x.path.startsWith(f.replace(/\\/g, "/").replace(/\/?$/, "/")))
    if (!c) {
      say(`(No unsaved changes in ${f}.)`)
      continue
    }
    if (c.kind === "new" && !gitOk(["cat-file", "-e", "HEAD:" + c.path])) fs.rmSync(path.join(ROOT, c.path), { force: true, recursive: true })
    else tracked.push(f)
  }
  if (tracked.length) git(["restore", "--source=HEAD", "--staged", "--worktree", "--", ...tracked])
  git(["clean", "-q", "-fd", "--", ...files], { allowFail: true })
  writeSafetyCopy()
  say(`Threw away the unsaved changes in: ${files.join(", ")}. Other unsaved changes are kept.`, `Backup ${ref.slice(BACKUP_NS.length)} keeps what was thrown away.`)
}

function actChanges(opts) {
  refuseIfStuck("changes")
  const words = opts._
  if (!words.length) {
    const ch = unsaved()
    if (!ch.length) return say("No unsaved changes.")
    git(["add", "-A", "--intent-to-add", "--", "."], { allowFail: true })
    const stat = git(["diff", "--stat=120", "HEAD"], { allowFail: true })
    git(["reset", "-q"], { allowFail: true })
    return say(`Unsaved changes (${ch.length} file(s)):`, ...ch.map((c) => `  ${c.kind.padEnd(8)} ${c.path}`), "", stat, "", "For details: git diff HEAD -- <file>")
  }
  // split into one or two version references
  const refs = splitRefs(words)
  if (refs.length === 1) {
    const a = findVersion(refs[0]).v
    if (!a) problem("That idea has no saved versions.")
    const stat = git(["diff", "--stat=120", a.commit], { allowFail: true })
    return say(`Differences between ${describeVersion(a)} of "${a.idea}" and what you see now:`, stat || "(none)", "", `For details: git diff ${a.tag} -- <file>`)
  }
  const a = findVersion(refs[0]).v
  const b = findVersion(refs[1]).v
  if (!a || !b) problem("Both ideas need saved versions to compare.")
  const stat = git(["diff", "--stat=120", a.commit, b.commit], { allowFail: true })
  say(`Differences from "${a.idea}" v${a.n} to "${b.idea}" v${b.n}:`, stat || "(none)", "", `For details: git diff ${a.tag} ${b.tag} -- <file>`)
}

function splitRefs(words) {
  // "checkout 2 checkout 4" | "checkout v2 v4" | "2 4" | "checkout/v2 menu/v1"
  const toks = words.join(" ").split(/\s+|,|\band\b|\bto\b|\bvs\.?\b/).filter(Boolean)
  const out = []
  let lastIdea = ""
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]
    if (/^(design\/)?[a-z0-9-]+\/v\d+$/i.test(t)) {
      out.push([t])
      lastIdea = t.replace(/^design\//, "").split("/")[0]
    } else if (/^v?\d+$/i.test(t)) out.push(lastIdea ? [lastIdea, t] : [t])
    else if (i + 1 < toks.length && /^v?\d+$/i.test(toks[i + 1])) {
      out.push([t, toks[i + 1]])
      lastIdea = t
      i++
    } else {
      out.push([t])
      lastIdea = t
    }
  }
  return out.slice(0, 2)
}

function actRenameVersion(opts) {
  const words = opts._
  const title = cleanTitle(words.pop() || "")
  if (!title) problem('Use: rename-version <idea> <number> "<new title>"')
  const { v } = findVersion(words)
  if (!v) problem("That idea has no saved versions.")
  const msg = git(["tag", "-l", "--format=%(contents:body)", v.tag], { allowFail: true })
  git(["tag", "-a", "-f", v.tag, v.commit, "-m", `${title}\n\n${msg}`], { env: { ...identityEnv(), GIT_COMMITTER_DATE: v.date } })
  writeSafetyCopy()
  say(`Version ${v.n} of "${v.idea}" is now called "${title}" (was "${v.title}").`)
}

function actRenameIdea(opts) {
  const [oldName, ...rest] = opts._
  if (!oldName || !rest.length) problem("Use: rename-idea <old name> <new name>")
  const from = slug(oldName)
  const to = slug(rest.join(" "))
  if (!refExists(ideaRef(from)) && !versionsOf(from).length) problem(`There is no idea called "${from}".`)
  if (refExists(ideaRef(to)) || versionsOf(to).length) problem(`An idea called "${to}" already exists.`)
  refuseIfStuck("rename-idea")
  if (refExists(ideaRef(from))) git(["branch", "-m", "design/" + from, "design/" + to])
  for (const v of versionsOf(from)) {
    const body = git(["tag", "-l", "--format=%(contents:body)", v.tag], { allowFail: true }).replace(`Idea: ${from}`, `Idea: ${to}`)
    git(["tag", "-a", versionTag(to, v.n), v.commit, "-m", `${v.title}\n\n${body}`], { env: { ...identityEnv(), GIT_COMMITTER_DATE: v.date } })
    git(["tag", "-d", v.tag], { allowFail: true })
  }
  writeSafetyCopy()
  say(`Idea "${from}" is now called "${to}". Its versions keep their numbers.`)
}

function actDeleteVersion(opts) {
  const { idea, v } = findVersion(opts._)
  if (!v) problem("That idea has no saved versions.")
  if (!opts.yes) choice(`delete version ${v.n} "${v.title}" of idea "${idea}"? It can be brought back later with undelete.`, [["--yes", "delete it"]])
  const tip = revParse(ideaRef(idea))
  trash(v.ref, `${idea}/v${v.n}`)
  git(["tag", "-d", v.tag])
  if (tip === v.commit) {
    const remaining = versionsOf(idea).filter((x) => x.commit !== v.commit)
    if (currentIdea() !== idea) {
      if (remaining.length) git(["update-ref", ideaRef(idea), remaining[remaining.length - 1].commit])
    }
  }
  writeSafetyCopy()
  say(`Deleted version ${v.n} of idea "${idea}". (Brought back with: undelete ${idea} ${v.n})`)
}

function actDeleteIdea(opts) {
  const idea = slug(opts._.join(" "))
  if (!refExists(ideaRef(idea)) && !versionsOf(idea).length) problem(`There is no idea called "${idea}".`)
  if (!opts.yes) choice(`delete idea "${idea}" with all its ${versionsOf(idea).length} version(s)? It can be brought back later with undelete.`, [["--yes", "delete it"]])
  const notes = []
  if (currentIdea() === idea) {
    refuseIfStuck("delete-idea")
    const settled = settleUnsaved(opts, "deleting idea " + idea)
    if (settled) notes.push(settled)
    git(["switch", "-q", mainBranch()])
    notes.push("Moved to the team's code first.")
  }
  const st = stamp()
  if (refExists(ideaRef(idea))) {
    git(["update-ref", `${TRASH_NS}${st}/${idea}/branch`, ideaRef(idea)])
    git(["branch", "-D", "design/" + idea])
  }
  for (const v of versionsOf(idea)) {
    git(["update-ref", `${TRASH_NS}${st}/${idea}/v${v.n}`, v.ref])
    git(["tag", "-d", v.tag])
  }
  writeSafetyCopy()
  notes.push(`Deleted idea "${idea}". (Brought back with: undelete ${idea})`)
  say(...notes)
}

function trashEntries() {
  const out = git(["for-each-ref", "--sort=-refname", "--format=%(refname)%1f%(objectname)%1f%(objecttype)", TRASH_NS], { allowFail: true })
  const list = []
  for (const line of out.split(/\r?\n/).filter(Boolean)) {
    const [ref, obj, type] = line.split("\x1f")
    const m = /^refs\/design-trash\/([^/]+)\/([a-z0-9-]+)\/(v\d+|branch|unsaved-tip)$/.exec(ref)
    if (!m) continue
    list.push({ ref, obj, type, when: m[1], idea: m[2], what: m[3] })
  }
  return list
}

function tagSubject(obj) {
  const raw = git(["cat-file", "tag", obj], { allowFail: true })
  const i = raw.search(/\r?\n\r?\n/)
  return i < 0 ? "" : raw.slice(i).trim().split(/\r?\n/)[0]
}

function actDeleted() {
  const list = trashEntries().filter((e) => e.what !== "unsaved-tip")
  if (!list.length) return say("Nothing has been deleted.")
  const lines = ["Deleted ideas and versions (newest first):"]
  for (const e of list) {
    if (e.what === "branch") continue
    const title = e.type === "tag" ? tagSubject(e.obj) : ""
    lines.push(`  ${e.idea} ${e.what}  "${title || ""}"  (deleted ${e.when.slice(0, 4)}-${e.when.slice(4, 6)}-${e.when.slice(6, 8)})`)
  }
  say(...lines)
}

function actUndelete(opts) {
  const [ideaWord, ver] = opts._
  if (!ideaWord) problem("Use: undelete <idea> [version number]")
  const idea = slug(ideaWord)
  const n = ver ? Number(String(ver).replace(/^v/i, "")) : 0
  const list = trashEntries().filter((e) => e.idea === idea)
  if (!list.length) problem(`Nothing deleted under the name "${idea}".`)
  const restored = []
  const skipped = []
  const seen = new Set()
  for (const e of list) {
    if (seen.has(e.what)) continue
    seen.add(e.what)
    if (e.what.startsWith("v")) {
      const num = Number(e.what.slice(1))
      if (n && num !== n) continue
      const tag = versionTag(idea, num)
      if (refExists("refs/tags/" + tag)) {
        skipped.push("v" + num)
        continue
      }
      git(["update-ref", "refs/tags/" + tag, e.obj])
      git(["update-ref", "-d", e.ref])
      restored.push("v" + num)
    } else if (e.what === "branch" && !n && !refExists(ideaRef(idea))) {
      git(["update-ref", ideaRef(idea), e.obj])
      git(["update-ref", "-d", e.ref])
    }
  }
  if (!refExists(ideaRef(idea))) {
    const vs = versionsOf(idea)
    if (vs.length) git(["branch", "design/" + idea, vs[vs.length - 1].commit])
  }
  writeSafetyCopy()
  const msg = restored.length ? `Brought back idea "${idea}" ${restored.join(", ")}.` : skipped.length ? `Nothing was brought back.` : `Brought back idea "${idea}".`
  say(msg + (skipped.length ? ` Not brought back, because a version with the same number exists now: ${skipped.join(", ")}.` : ""))
}

function backupList() {
  const out = git(["for-each-ref", "--sort=-refname", "--format=%(refname)%1f%(objectname)%1f%(contents:subject)%1f%(contents:body)%1e", BACKUP_NS], { allowFail: true })
  const list = []
  for (const rec of out.split("\x1e")) {
    const f = rec.replace(/^\s+/, "").split("\x1f")
    if (f.length < 3) continue
    const id = f[0].slice(BACKUP_NS.length)
    const where = (/^Where: (.*)$/m.exec(f[3] || "") || [])[1] || ""
    const files = (/^Files: (\d+)/m.exec(f[3] || "") || [])[1] || "?"
    list.push({ id, ref: f[0], commit: f[1], reason: f[2].replace(/^Backup before /, ""), where, files, body: f[3] || "" })
  }
  return list
}

function actBackups() {
  const list = backupList()
  if (!list.length) return say("No backups yet. A backup is made automatically whenever unsaved changes are thrown away.")
  const lines = ["Backups (newest first). Each holds unsaved changes from just before they were thrown away:"]
  list.slice(0, 30).forEach((b, i) => {
    const d = b.id
    lines.push(`  ${String(i + 1).padStart(2)}. ${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)} ${d.slice(9, 11)}:${d.slice(11, 13)}  ${b.files} file(s), ${b.where}, before ${b.reason}   [id ${d}]`)
  })
  if (list.length > 30) lines.push(`  ... ${list.length - 30} older backups`)
  lines.push("", "To see what one holds: backup-files <number>      To bring one back: restore-backup <number>")
  say(...lines)
}

function pickBackup(word) {
  const list = backupList()
  if (!word) problem("Which backup? Give its number from the backups list.")
  const b = /^\d{1,3}$/.test(word) ? list[Number(word) - 1] : list.find((x) => x.id === word)
  if (!b) problem(`There is no backup "${word}". Run backups to see the list.`)
  return b
}

function actBackupFiles(opts) {
  const b = pickBackup(opts._[0])
  const parent = git(["rev-parse", "-q", "--verify", b.commit + "^"], { allowFail: true })
  const stat = parent ? git(["diff", "--stat=120", parent, b.commit], { allowFail: true }) : ""
  say(`Backup ${b.id} (${b.where}, before ${b.reason}):`, stat || b.body)
}

function actRestoreBackup(opts) {
  refuseIfStuck("restore-backup")
  const b = pickBackup(opts._[0])
  const notes = []
  const settled = settleUnsaved(opts, "restoring backup " + b.id)
  if (settled) notes.push(settled)
  const parent = git(["rev-parse", "-q", "--verify", b.commit + "^"], { allowFail: true })
  // go to where the backup was made
  if (parent && revParse("HEAD") !== parent) {
    const at = versionsAt(parent)
    const ideaName = (/^idea ([a-z0-9-]+)/.exec(b.where) || [])[1]
    const v = at.find((x) => x.idea === ideaName) || at[0]
    if (v) {
      protectTip(v.idea)
      if (!refExists(ideaRef(v.idea))) git(["branch", "design/" + v.idea, v.commit])
      if (currentIdea() !== v.idea) git(["switch", "-q", "design/" + v.idea])
      git(["reset", "-q", "--hard", v.commit])
      notes.push(`Opened idea "${v.idea}" ${describeVersion(v)}, where the backup was made.`)
    } else if (parent === revParse(MAIN_REF())) {
      git(["switch", "-q", mainBranch()])
      notes.push("Went to the team's code, where the backup was made.")
    } else {
      const name = "restored-" + b.id.slice(0, 13)
      git(["switch", "-q", "-c", "design/" + name, parent])
      notes.push(`The place where the backup was made is not a saved version any more, so it was opened as a new idea "${name}".`)
    }
  }
  // make the files equal to the backup, as unsaved changes
  const removed = git(["diff", "--name-only", "--diff-filter=A", b.commit, "HEAD"], { allowFail: true }).split(/\r?\n/).filter(Boolean)
  for (const f of removed) fs.rmSync(path.join(ROOT, f), { force: true })
  git(["restore", "--source=" + b.commit, "--worktree", "--", "."])
  notes.push(`Brought back backup ${b.id} (${b.files} file(s)) as unsaved changes. Save them if you want to keep them.`)
  say(...notes)
}

function actSafetyCopy() {
  const r = writeSafetyCopy()
  if (r === "ok") say(`Safety copy written to ${path.join(S.safetyCopyFolder, path.basename(ROOT) + ".bundle")} (all ideas, versions and backups).`)
  else say("Safety copy: " + r)
}

function actRestoreSafetyCopy(opts) {
  const file = opts._.join(" ") || path.join(S.safetyCopyFolder, path.basename(ROOT) + ".bundle")
  if (!fs.existsSync(file)) {
    const found = fs.existsSync(S.safetyCopyFolder) ? fs.readdirSync(S.safetyCopyFolder).filter((f) => f.endsWith(".bundle")) : []
    problem(`No safety copy at ${file}.` + (found.length ? ` Safety copies in ${S.safetyCopyFolder}: ${found.join(", ")}. Give the file: restore-safety-copy "<full path>"` : ""))
  }
  if (currentIdea()) problem('Go to the team\'s code first ("team-code"), then read the safety copy.')
  const v = git(["bundle", "verify", file], { allowFail: true, full: true })
  if (!v.ok) problem(`The safety copy can't be used in this project yet: ${v.err.split("\n").slice(-2).join(" ")}\nRun get-latest first, then try again.`)
  const f = git(["fetch", "--no-tags", file, "+refs/heads/design/*:refs/heads/design/*", "+refs/tags/design/*:refs/tags/design/*", `+${BACKUP_NS}*:${BACKUP_NS}*`, `+${TRASH_NS}*:${TRASH_NS}*`], { allowFail: true, full: true, timeout: 300000 })
  if (!f.ok) problem("Could not read the safety copy: " + f.err.split("\n").slice(-2).join(" "))
  say(`Read the safety copy. Ideas now on this computer: ${allIdeas().join(", ") || "none"}.`)
}

function actDoctor() {
  const found = []
  const fixed = []
  // 1. stale lock files (a Git program stopped halfway)
  const locks = []
  const walk = (dir, depth) => {
    let list = []
    try {
      list = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const d of list) {
      const p = path.join(dir, d.name)
      if (d.isDirectory() && depth < 6 && !["objects", "lfs", "modules"].includes(d.name)) walk(p, depth + 1)
      else if (d.isFile() && d.name.endsWith(".lock")) locks.push(p)
    }
  }
  walk(GIT_DIR, 0)
  let young = 0
  for (const l of locks) {
    if ((Date.now() - fs.statSync(l).mtimeMs) / 1000 > 120) fs.rmSync(l, { force: true })
    else young++
  }
  if (locks.length - young) fixed.push(`Removed ${locks.length - young} leftover lock file(s) from a Git program that stopped halfway.`)
  if (young) found.push("Another Git program is busy right now (a lock file younger than 2 minutes). Close other programs that use the project, wait a minute and run doctor again.")
  // 2. operations in progress
  const p = inProgress()
  if (p === "update") found.push("An update with the team's code is half-done (some places clash). Either fix the clashes and run update-idea --continue, or cancel with update-idea --abort.")
  else if (p) {
    const ref = backup(`cleaning up a ${p}`)
    const cmd = p === "merge" ? ["merge", "--abort"] : p === "rebase" ? ["rebase", "--abort"] : p === "cherry-pick" ? ["cherry-pick", "--abort"] : ["revert", "--abort"]
    git(cmd, { allowFail: true })
    fixed.push(`Cancelled a half-done ${p} that was started outside this tool.` + (ref ? ` Backup ${ref.slice(BACKUP_NS.length)} keeps the files as they were.` : ""))
  }
  // 3. detached HEAD
  if (!currentBranch()) {
    const head = revParse("HEAD")
    const at = versionsAt(head)
    if (at.length) {
      const v = at[at.length - 1]
      protectTip(v.idea)
      git(["branch", "-f", "design/" + v.idea, head])
      git(["switch", "-q", "design/" + v.idea])
      fixed.push(`Put the project back on idea "${v.idea}" ${describeVersion(v)}.`)
    } else if (head && head === revParse(MAIN_REF())) {
      git(["switch", "-q", mainBranch()])
      fixed.push("Put the project back on the team's code.")
    } else if (head) {
      const name = "rescued-" + stamp().slice(0, 13)
      git(["switch", "-q", "-c", "design/" + name])
      fixed.push(`The project was on an unnamed place. Kept it as a new idea "${name}".`)
    }
  }
  // 4. commits on an idea that are not versions
  const idea = currentIdea()
  if (idea) {
    const head = revParse("HEAD")
    if (!versionsAt(head).some((v) => v.idea === idea) && head !== revParse(MAIN_REF()) && !gitOk(["merge-base", "--is-ancestor", head, MAIN_REF()])) {
      const n = nextNumber(idea)
      git(["tag", "-a", versionTag(idea, n), head, "-m", `Saved outside the tool\n\nIdea: ${idea}\nSaved: ${fmtDate(new Date().toISOString())}`], { env: identityEnv() })
      fixed.push(`Found work on idea "${idea}" that was saved outside this tool. Kept it as version ${n}.`)
    }
  }
  // 5. local team code with extra work on it
  if (refExists(REMOTE_MAIN()) && refExists(MAIN_REF()) && !gitOk(["merge-base", "--is-ancestor", MAIN_REF(), REMOTE_MAIN()])) {
    if (currentBranch() === mainBranch() && unsaved().length) found.push("There is saved work directly on the team's code, and unsaved changes on top. Save the changes into an idea (save <title> --idea <name>), then run doctor again.")
    else {
      const { rescued } = syncMain()
      if (rescued) fixed.push(`Found saved work directly on the team's code. Kept it as idea "${rescued}" and reset the team's code.`)
    }
  }
  // 6. safety settings
  const safety = applySafety()
  if (safety.length) fixed.push(...safety)
  // 7. unexpected branch
  const b = currentBranch()
  if (b && b !== mainBranch() && !b.startsWith("design/")) found.push(`The project is on "${b}", which is neither an idea nor the team's code. "team-code" or "open <idea>" moves you back.`)
  const u = unsaved()
  if (u.some((c) => c.kind === "clash") && inProgress() !== "update") found.push("Some files still contain clash markers from an earlier update. Check them or throw the changes away.")
  if (!fixed.length && !found.length) return say("Everything looks fine. " + (u.length ? `There are unsaved changes in ${u.length} file(s).` : "No unsaved changes."))
  say(...(fixed.length ? ["Fixed:", ...fixed.map((x) => "  - " + x)] : []), ...(found.length ? ["Needs attention:", ...found.map((x) => "  - " + x)] : []))
}

/** Push protection and the private ignore line; returns what had to be (re)applied. */
function applySafety() {
  const done = []
  const pushurl = git(["config", "--get", `remote.${S.remote}.pushurl`], { allowFail: true })
  if (gitOk(["config", "--get", `remote.${S.remote}.url`]) && pushurl !== PUSH_BLOCK_URL) {
    git(["config", `remote.${S.remote}.pushurl`, PUSH_BLOCK_URL])
    done.push("Turned off pushing to the server again (push address).")
  }
  if (git(["config", "--get", "push.default"], { allowFail: true }) !== "nothing") {
    git(["config", "push.default", "nothing"])
    done.push("Turned off pushing to the server again (push default).")
  }
  if (!git(["config", "--get", "core.hooksPath"], { allowFail: true, raw: true })) {
    const hook = path.join(GIT_DIR, "hooks", "pre-push")
    const body = '#!/bin/sh\necho "Pushing is turned off on this computer: design concepts stay local." >&2\nexit 1\n'
    if (!fs.existsSync(hook) || fs.readFileSync(hook, "utf8") !== body) {
      fs.mkdirSync(path.dirname(hook), { recursive: true })
      fs.writeFileSync(hook, body, { mode: 0o755 })
      done.push("Put the push blocker back in place (pre-push hook).")
    }
  }
  const excl = path.join(GIT_DIR, "info", "exclude")
  const cur = fs.existsSync(excl) ? fs.readFileSync(excl, "utf8") : ""
  if (!/^\/\.designer\/$/m.test(cur)) {
    fs.mkdirSync(path.dirname(excl), { recursive: true })
    fs.writeFileSync(excl, cur + (cur && !cur.endsWith("\n") ? "\n" : "") + "/.designer/\n")
    done.push("Hid the .designer folder from Git again.")
  }
  return done
}

// ---------------------------------------------------------------- main

const HELP = `node .designer/versions.mjs <action>

Where am I
  status                              idea, version, unsaved changes, team code age
  list [idea]                         all ideas and their versions
  changes                             unsaved changes, file by file
  changes <idea> <n> [<idea> <n>]     differences to a version, or between two versions

Save and open
  save "<title>" [--idea <name>]      save unsaved changes as the next version (--idea when on the team's code)
  open <idea> [<n>]                   open a version (the newest if no number)
  new-idea <name>                     start a fresh idea from the team's newest code
  new-idea <name> --from-here         start a new idea as a copy of what you see now
  team-code                           look at the team's code without any idea

Team's code
  get-latest                          download the team's newest code (ideas are not changed)
  update-idea                         bring the team's newest code into the current idea, as a new version
  update-idea --use mine|team <file>  during a clash: keep one side of a whole file
  update-idea --continue | --abort    finish or cancel a clashing update

Throw away and bring back
  discard [<file> ...]                throw away unsaved changes (a backup is kept)
  backups                             list automatic backups
  backup-files <number>               what a backup holds
  restore-backup <number>             bring a backup back as unsaved changes

Tidy up
  rename-version <idea> <n> "<title>"
  rename-idea <old> <new>
  delete-version <idea> <n> --yes
  delete-idea <idea> --yes
  deleted                             list deleted ideas and versions
  undelete <idea> [<n>]

Repair and safety
  doctor                              find and fix stuck states, put push protection back
  safety-copy                         write the safety copy outside the project now (also done on every save)
  restore-safety-copy [<file>]        read a safety copy into a fresh copy of the project

Options for actions that leave the current version (open, new-idea, team-code, update-idea,
get-latest on the team's code, restore-backup, delete-idea):
  --save "<title>"   save unsaved changes first        --discard   throw them away first (backup kept)
Exit codes: 0 done, 1 problem, 2 a choice is needed.`

const ACTIONS = {
  status: actStatus,
  list: actList,
  versions: actList,
  save: actSave,
  "new-idea": actNewIdea,
  open: actOpen,
  "team-code": actTeamCode,
  "get-latest": actGetLatest,
  "update-idea": actUpdateIdea,
  discard: actDiscard,
  changes: actChanges,
  "rename-version": actRenameVersion,
  "rename-idea": actRenameIdea,
  "delete-version": actDeleteVersion,
  "delete-idea": actDeleteIdea,
  deleted: actDeleted,
  undelete: actUndelete,
  backups: actBackups,
  "backup-files": actBackupFiles,
  "restore-backup": actRestoreBackup,
  "safety-copy": actSafetyCopy,
  "restore-safety-copy": actRestoreSafetyCopy,
  doctor: actDoctor,
}

function main() {
  const [action, ...rest] = process.argv.slice(2)
  if (!action || action === "help" || action === "--help" || action === "-h") return say(HELP)
  const fn = ACTIONS[action]
  if (!fn) problem(`Unknown action "${action}". Run without arguments to see the list.`)
  checkRepo()
  fn(parseOpts(rest))
}

try {
  main()
} catch (e) {
  if (e instanceof Stop) {
    if (e.message) console.log(e.message)
    process.exit(e.code)
  }
  console.log("PROBLEM: unexpected error in versions.mjs: " + (e && e.stack ? e.stack : e))
  console.log(`Nothing was thrown away. Run "node .designer/versions.mjs doctor", and if that does not help, ask ${S.helperName}.`)
  process.exit(1)
}
