#!/usr/bin/env node
// app.mjs - start, stop and watch the app for the designer.
//
//   node .designer/app.mjs run        run the app in this window (used by "Start app.cmd")
//   node .designer/app.mjs start      open the app in its own window and wait until it answers
//   node .designer/app.mjs stop       stop the app
//   node .designer/app.mjs restart    stop, then start (installs packages first if they changed)
//   node .designer/app.mjs status     is it running, and where
//   node .designer/app.mjs log [N]    the last N lines the app printed (default 80); --errors for problem lines only
//   node .designer/app.mjs check      run the check command from settings.json (for example a type check)
//
// Settings come from .designer/settings.json. Only Node.js built-ins are used.

import { spawn, spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import net from "node:net"
import crypto from "node:crypto"
import { fileURLToPath } from "node:url"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, "..")
const STATE_DIR = path.join(HERE, "state")
const LOG_DIR = path.join(HERE, "logs")
const LOG = path.join(LOG_DIR, "app.log")
const STATE = path.join(STATE_DIR, "app.json")
const DEPS_HASH = path.join(STATE_DIR, "deps-hash.txt")
const WIN = process.platform === "win32"

function settings() {
  let s = {}
  try {
    s = JSON.parse(fs.readFileSync(path.join(HERE, "settings.json"), "utf8").replace(/^\uFEFF/, ""))
  } catch (e) {
    if (fs.existsSync(path.join(HERE, "settings.json"))) fail(`.designer/settings.json is not valid JSON (${e.message}). In folder paths, write / or \\\\ instead of a single \\.`)
  }
  return {
    appName: s.appName || "the app",
    devCommand: s.devCommand || "npm run dev",
    installCommand: s.installCommand ?? "npm ci",
    appUrl: s.appUrl || "http://localhost:5173",
    openBrowser: s.openBrowser !== false,
    checkCommand: s.checkCommand || "",
    dependencyFiles: s.dependencyFiles || ["package.json", "package-lock.json"],
    startTimeoutSeconds: s.startTimeoutSeconds || 180,
    helperName: s.helperName || "a developer",
  }
}

function fail(msg) {
  console.log("PROBLEM: " + msg)
  process.exit(1)
}

const S = settings()
const NAME = S.appName.charAt(0).toUpperCase() + S.appName.slice(1)
const URL_ = new URL(S.appUrl)
const PORT = Number(URL_.port || (URL_.protocol === "https:" ? 443 : 80))
const HOSTS = URL_.hostname === "localhost" ? ["127.0.0.1", "::1"] : [URL_.hostname]

// ---------------------------------------------------------------- helpers

function portOpen(host, port, ms = 600) {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port })
    const done = (v) => {
      sock.destroy()
      resolve(v)
    }
    sock.setTimeout(ms, () => done(false))
    sock.once("connect", () => done(true))
    sock.once("error", () => done(false))
  })
}
async function running() {
  for (const h of HOSTS) if (await portOpen(h, PORT)) return true
  return false
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE, "utf8"))
  } catch {
    return null
  }
}
function alive(pid) {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e.code === "EPERM"
  }
}

function depsHash() {
  const h = crypto.createHash("sha1")
  for (const f of S.dependencyFiles) {
    const p = path.join(ROOT, f)
    h.update(f + "\0" + (fs.existsSync(p) ? fs.readFileSync(p) : "missing") + "\0")
  }
  return h.digest("hex")
}
function hasDependencies() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"))
    return Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).length > 0
  } catch {
    return false
  }
}
function needsInstall() {
  if (!S.installCommand) return false
  if (!fs.existsSync(path.join(ROOT, "node_modules")) && hasDependencies()) return true
  const old = fs.existsSync(DEPS_HASH) ? fs.readFileSync(DEPS_HASH, "utf8").trim() : ""
  return old !== depsHash()
}

const stripAnsi = (s) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\x1b\][^\x07]*\x07/g, "")

function openBrowser(url) {
  try {
    if (WIN) spawn("cmd.exe", ["/d", "/c", "start", '""', `"${url}"`], { windowsVerbatimArguments: true, detached: true, stdio: "ignore", windowsHide: true }).unref()
    else if (process.platform === "darwin") spawn("open", [url], { detached: true, stdio: "ignore" }).unref()
    else spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).on("error", () => {}).unref()
  } catch {}
}

/** Is this process still one of ours (node or cmd), and not a reused process number? */
function ours(pid) {
  if (!pid || !alive(pid)) return false
  if (!WIN) return true
  const r = spawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], { encoding: "utf8", windowsHide: true })
  return /"(node|cmd)\.exe"/i.test(r.stdout || "")
}

function killTree(pid) {
  if (!pid) return
  if (WIN) spawnSync("taskkill", ["/pid", String(pid), "/t", "/f"], { stdio: "ignore", windowsHide: true })
  else {
    try {
      process.kill(-pid, "SIGTERM")
    } catch {
      try {
        process.kill(pid, "SIGTERM")
      } catch {}
    }
  }
}

// ---------------------------------------------------------------- run (foreground)

async function run() {
  fs.mkdirSync(STATE_DIR, { recursive: true })
  fs.mkdirSync(LOG_DIR, { recursive: true })
  if (await running()) {
    console.log(`${NAME} is already running at ${S.appUrl}. Opening it in the browser.`)
    if (S.openBrowser) openBrowser(S.appUrl)
    process.exitCode = 3
    return
  }
  if (fs.existsSync(LOG)) fs.copyFileSync(LOG, path.join(LOG_DIR, "app.previous.log"))
  const log = fs.createWriteStream(LOG, { flags: "w" })
  let logged = 0
  const write = (chunk, toConsole = true) => {
    if (toConsole) process.stdout.write(chunk)
    const text = stripAnsi(chunk.toString())
    logged += text.length
    if (logged < 20 * 1024 * 1024) log.write(text)
  }
  write(`[${new Date().toLocaleString()}] Starting ${S.appName} in ${ROOT}\n`)

  if (needsInstall()) {
    write(`Installing the app's packages first (${S.installCommand}). This can take a few minutes...\n`)
    const code = await runCommand(S.installCommand, write)
    if (code !== 0) {
      write(`\nInstalling packages failed (exit code ${code}). The lines above say why. Ask ${S.helperName} if it keeps happening.\n`)
      log.end()
      process.exitCode = 1
      return
    }
    fs.writeFileSync(DEPS_HASH, depsHash())
  }

  write(`Running: ${S.devCommand}\n`)
  const child = spawn(S.devCommand, { cwd: ROOT, shell: true, stdio: ["inherit", "pipe", "pipe"], detached: !WIN, env: { ...process.env, FORCE_COLOR: "1" } })
  const state = { runPid: process.pid, childPid: child.pid, url: S.appUrl, started: new Date().toISOString() }
  if (process.env.DESIGNER_WINDOW === "1") state.windowPid = process.ppid
  fs.writeFileSync(STATE, JSON.stringify(state))
  child.stdout.on("data", (d) => write(d))
  child.stderr.on("data", (d) => write(d))

  const stop = () => {
    killTree(child.pid)
    try {
      const st = readState()
      if (st && st.runPid === process.pid) fs.rmSync(STATE, { force: true })
    } catch {}
  }
  process.on("SIGINT", stop)
  process.on("SIGTERM", stop)
  process.on("SIGHUP", stop) // the window was closed

  // open the browser once the app answers
  ;(async () => {
    const until = Date.now() + S.startTimeoutSeconds * 1000
    while (Date.now() < until && child.exitCode === null) {
      if (await running()) {
        write(`\n${NAME} is running at ${S.appUrl}\n(Keep this window open while you work. Closing it stops the app.)\n\n`)
        if (S.openBrowser) openBrowser(S.appUrl)
        return
      }
      await sleep(1000)
    }
    if (child.exitCode === null) write(`\nThe app has not answered at ${S.appUrl} after ${S.startTimeoutSeconds} seconds. Check the lines above.\n`)
  })()

  const code = await new Promise((r) => child.on("exit", (c) => r(c ?? 0)))
  write(`\n[${new Date().toLocaleString()}] The app stopped (exit code ${code}).\n`)
  try {
    const st = readState()
    if (st && st.runPid === process.pid) fs.rmSync(STATE, { force: true })
  } catch {}
  log.end()
}

function runCommand(cmd, write) {
  return new Promise((resolve) => {
    const c = spawn(cmd, { cwd: ROOT, shell: true, stdio: ["ignore", "pipe", "pipe"] })
    c.stdout.on("data", (d) => write(d))
    c.stderr.on("data", (d) => write(d))
    c.on("exit", (code) => resolve(code ?? 1))
    c.on("error", (e) => {
      write(String(e) + "\n")
      resolve(1)
    })
  })
}

// ---------------------------------------------------------------- start / stop (for the AI)

async function start() {
  if (await running()) return console.log(`${NAME} is already running at ${S.appUrl}.`)
  fs.mkdirSync(LOG_DIR, { recursive: true })
  if (WIN) {
    spawn("cmd.exe", ["/d", "/c", "start", '"Design app"', "cmd.exe", "/c", '".designer\\Start app.cmd"'], { cwd: ROOT, windowsVerbatimArguments: true, detached: true, stdio: "ignore" }).unref()
  } else {
    const out = fs.openSync(path.join(LOG_DIR, "background.out"), "a")
    spawn(process.execPath, [path.join(HERE, "app.mjs"), "run"], { cwd: ROOT, detached: true, stdio: ["ignore", out, out], env: { ...process.env, DESIGNER_NO_BROWSER: "" } }).unref()
  }
  const wait = needsInstall() ? S.startTimeoutSeconds + 300 : S.startTimeoutSeconds
  const until = Date.now() + wait * 1000
  // the bash tool stops waiting after a few minutes; report progress instead of hanging
  const limit = Math.min(until, Date.now() + 100 * 1000)
  while (Date.now() < limit) {
    if (await running()) return console.log(`${NAME} is running at ${S.appUrl} (in its own window called "Design app").`)
    await sleep(1500)
  }
  console.log(`${NAME} is still starting (it may be installing packages). It opens in its own window called "Design app". Run "node .designer/app.mjs status" in a minute, or read the log: node .designer/app.mjs log`)
}

async function stop() {
  const st = readState()
  if (!(await running())) {
    fs.rmSync(STATE, { force: true })
    return console.log(`${NAME} was not running.`)
  }
  if (st) {
    if (st.windowPid && ours(st.windowPid)) killTree(st.windowPid)
    else if (ours(st.runPid)) killTree(st.runPid)
    if (ours(st.childPid)) killTree(st.childPid)
  }
  for (let i = 0; i < 20; i++) {
    if (!(await running())) break
    await sleep(500)
  }
  fs.rmSync(STATE, { force: true })
  if (await running()) console.log(`Something is still answering at ${S.appUrl}, but it was not started by "Start app". Close the window that runs the app by hand.`)
  else console.log(st ? `${NAME} is stopped.` : `${NAME} was not running.`)
}

async function status() {
  const st = readState()
  if (await running()) {
    console.log(`${NAME} is running at ${S.appUrl}` + (st ? ` (started ${new Date(st.started).toLocaleString()}).` : "."))
    if (needsInstall()) console.log("The package files changed since the last install. Restart the app so they are installed: node .designer/app.mjs restart")
  } else {
    console.log(`${NAME} is not running. Start it with: node .designer/app.mjs start  (or the designer double-clicks "Start app").`)
  }
}

function showLog(args) {
  if (!fs.existsSync(LOG)) return console.log("No app log yet: the app has not been started with Start app on this computer.")
  const errorsOnly = args.includes("--errors")
  const n = Number(args.find((a) => /^\d+$/.test(a)) || (errorsOnly ? 400 : 80))
  let lines = fs.readFileSync(LOG, "utf8").split(/\r?\n/)
  lines = lines.slice(-n)
  if (errorsOnly) {
    const re = /(error|failed|cannot|can't|exception|not found|unexpected|\bERR\b|✘|×)/i
    const keep = new Set()
    lines.forEach((l, i) => {
      if (re.test(l)) for (let k = i - 1; k <= i + 3; k++) if (k >= 0 && k < lines.length) keep.add(k)
    })
    lines = [...keep].sort((a, b) => a - b).map((i) => lines[i])
    if (!lines.length) return console.log(`No problem lines in the last ${n} lines of the app log.`)
  }
  const mtime = fs.statSync(LOG).mtime
  console.log(`--- app log (last ${lines.length} lines, file updated ${mtime.toLocaleString()}) ---`)
  console.log(lines.join("\n"))
}

function check() {
  if (!S.checkCommand) return console.log('No check command is set in .designer/settings.json ("checkCommand"). Use "node .designer/app.mjs log --errors" to look for problems instead.')
  console.log(`Running: ${S.checkCommand}`)
  const r = spawnSync(S.checkCommand, { cwd: ROOT, shell: true, encoding: "utf8", timeout: 9 * 60 * 1000, maxBuffer: 64 * 1024 * 1024, windowsHide: true })
  const out = stripAnsi((r.stdout || "") + (r.stderr || "")).trim().split(/\r?\n/)
  console.log(out.slice(-120).join("\n"))
  if (r.error && r.error.code === "ETIMEDOUT") return console.log("CHECK: took too long and was stopped.")
  console.log(r.status === 0 ? "CHECK: passed." : `CHECK: found problems (exit code ${r.status}).`)
  if (r.status !== 0) process.exitCode = 1
}

// ---------------------------------------------------------------- main

const [action = "", ...args] = process.argv.slice(2)
if (process.env.DESIGNER_NO_BROWSER !== undefined) S.openBrowser = false
switch (action) {
  case "run":
    await run()
    break
  case "start":
    await start()
    break
  case "stop":
    await stop()
    break
  case "restart":
    await stop()
    process.env.DESIGNER_NO_BROWSER = "1" // the open browser tab reconnects by itself
    await start()
    break
  case "status":
    await status()
    break
  case "log":
    showLog(args)
    break
  case "check":
    check()
    break
  default:
    console.log(`node .designer/app.mjs run | start | stop | restart | status | log [N] [--errors] | check`)
}
