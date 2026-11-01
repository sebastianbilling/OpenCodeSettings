#!/usr/bin/env node
// app.mjs - start, stop and watch the (Electron) app for the designer.
//
//   node .designer/app.mjs start [--full]    start the app and wait until it is up; its own window opens by itself
//   node .designer/app.mjs restart [--full]  stop, then start
//   node .designer/app.mjs stop              stop the app (its window closes)
//   node .designer/app.mjs status            is it running
//   node .designer/app.mjs log [N]           the last N lines the app printed (default 80); --errors for problem lines only
//   node .designer/app.mjs check             run the check command from settings.json (for example a type check)
//   node .designer/app.mjs run [--full]      run the app in the current console (what "start" opens, minimized)
//
// Starting means: the prepare commands (by default "npm install" then "npm run build:dev") when they are
// needed, then the dev command ("npm run dev"), which opens the Electron app's window. The prepare commands
// are needed the first time, whenever a package file changed since they last ran, and always with --full.
// "start" runs all of this in a small minimized console window called "Design app" in the taskbar.
//
// Settings come from .designer/settings.json. Only Node.js built-ins are used.

import { spawn, spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"
import { fileURLToPath } from "node:url"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, "..")
const STATE_DIR = path.join(HERE, "state")
const LOG_DIR = path.join(HERE, "logs")
const LOG = path.join(LOG_DIR, "app.log")
const STATE = path.join(STATE_DIR, "app.json")
const PREPARED = path.join(STATE_DIR, "prepared.txt")
const WIN = process.platform === "win32"
const DEFAULT_PREPARE = ["npm install", "npm run build:dev"]
const QUIET_READY_SECONDS = 10 // without readyText: up this long without stopping counts as started

function settings() {
  let s = {}
  try {
    s = JSON.parse(fs.readFileSync(path.join(HERE, "settings.json"), "utf8").replace(/^﻿/, ""))
  } catch (e) {
    if (fs.existsSync(path.join(HERE, "settings.json"))) fail(`.designer/settings.json is not valid JSON (${e.message}). In folder paths, write / or \\\\ instead of a single \\.`)
  }
  let prepare = DEFAULT_PREPARE
  if (Array.isArray(s.prepareCommands)) prepare = s.prepareCommands
  else if (typeof s.installCommand === "string") prepare = [s.installCommand] // settings from the first kit
  return {
    appName: s.appName || "the app",
    prepareCommands: prepare.filter((c) => typeof c === "string" && c.trim()),
    devCommand: s.devCommand || "npm run dev",
    readyText: typeof s.readyText === "string" ? s.readyText : "",
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

// ---------------------------------------------------------------- helpers

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function alive(pid) {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e.code === "EPERM"
  }
}

/** On Windows, a process number can be reused by another program: only count it if it is node. */
function isNode(pid) {
  if (!WIN) return true
  const r = spawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], { encoding: "utf8", windowsHide: true })
  return /"node\.exe"/i.test(r.stdout || "")
}

/** The state of a run that is alive right now, or null. The run refreshes the file every few seconds,
 *  so an old file (a closed window, a crash) is never mistaken for a live run. */
function liveRun() {
  for (let attempt = 0; attempt < 4; attempt++) {
    if (!fs.existsSync(STATE)) return null
    try {
      const age = Date.now() - fs.statSync(STATE).mtimeMs
      const st = JSON.parse(fs.readFileSync(STATE, "utf8"))
      return age < 20000 && alive(st.runPid) && isNode(st.runPid) ? st : null
    } catch {
      // caught the file halfway through a rewrite: wait a moment and read again
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60)
    }
  }
  return null
}

/** Replace a file in one step, so a reader never sees it half-written. */
function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, text)
  try {
    fs.renameSync(tmp, file)
  } catch {
    fs.writeFileSync(file, text) // Windows can refuse while another process reads it
    fs.rmSync(tmp, { force: true })
  }
}

function prepareHash() {
  const h = crypto.createHash("sha1")
  h.update(JSON.stringify(S.prepareCommands) + "\0")
  for (const f of S.dependencyFiles) {
    const p = path.join(ROOT, f)
    h.update(f + "\0" + (fs.existsSync(p) ? fs.readFileSync(p) : "missing") + "\0")
  }
  return h.digest("hex")
}
function needsPrepare() {
  if (!S.prepareCommands.length) return false
  const old = fs.existsSync(PREPARED) ? fs.readFileSync(PREPARED, "utf8").trim() : ""
  return old !== prepareHash()
}

const stripAnsi = (s) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\x1b\][^\x07]*\x07/g, "")

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

function runCommand(cmd, write) {
  return new Promise((resolve) => {
    const c = spawn(cmd, { cwd: ROOT, shell: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, FORCE_COLOR: "1" } })
    c.stdout.on("data", (d) => write(d))
    c.stderr.on("data", (d) => write(d))
    c.on("exit", (code) => resolve(code ?? 1))
    c.on("error", (e) => {
      write(String(e) + "\n")
      resolve(1)
    })
  })
}

// ---------------------------------------------------------------- run (in the current console)

async function run(full) {
  fs.mkdirSync(STATE_DIR, { recursive: true })
  fs.mkdirSync(LOG_DIR, { recursive: true })
  process.title = "Design app"
  if (liveRun()) {
    console.log(`${NAME} is already running.`)
    process.exitCode = 3
    return
  }
  if (fs.existsSync(LOG)) fs.copyFileSync(LOG, path.join(LOG_DIR, "app.previous.log"))
  const log = fs.createWriteStream(LOG, { flags: "w" })
  let logged = 0
  let seenText = ""
  const write = (chunk) => {
    process.stdout.write(chunk)
    const text = stripAnsi(chunk.toString())
    logged += text.length
    if (logged < 20 * 1024 * 1024) log.write(text)
    if (S.readyText && state.phase === "starting") {
      seenText = (seenText + text).slice(-4000)
      if (seenText.includes(S.readyText)) markRunning()
    }
  }
  const state = { runPid: process.pid, childPid: 0, started: new Date().toISOString(), phase: "preparing" }
  const saveState = () => {
    try {
      writeAtomic(STATE, JSON.stringify(state))
    } catch {}
  }
  const markRunning = () => {
    if (state.phase === "running") return
    state.phase = "running"
    saveState()
    write(`\n${NAME} is running. This console only runs it; the app has its own window.\n\n`)
  }
  saveState()
  const heartbeat = setInterval(saveState, 5000)
  heartbeat.unref()
  let stopping = false
  let child = null
  const stop = () => {
    stopping = true
    if (child) killTree(child.pid)
    clearInterval(heartbeat)
    fs.rmSync(STATE, { force: true })
  }
  process.on("SIGINT", stop)
  process.on("SIGTERM", stop)
  process.on("SIGHUP", stop) // the console window was closed

  write(`[${new Date().toLocaleString()}] Starting ${S.appName} in ${ROOT}\n`)
  write(`This console runs the app. Closing it stops the app.\n\n`)

  if (full || needsPrepare()) {
    write(full ? "Full start: installing and building everything again.\n" : "The app's packages changed (or this is the first start), so it is installed and built first.\n")
    write("This can take a few minutes.\n")
    for (const cmd of S.prepareCommands) {
      write(`\n> ${cmd}\n`)
      const code = await runCommand(cmd, write)
      if (stopping) return
      if (code !== 0) {
        write(`\n"${cmd}" failed (exit code ${code}); the app was not started. The lines above say why. Ask ${S.helperName} if it keeps happening.\n`)
        log.end()
        stop()
        process.exitCode = 1
        return
      }
    }
    fs.writeFileSync(PREPARED, prepareHash())
  }

  write(`\n> ${S.devCommand}\n`)
  child = spawn(S.devCommand, { cwd: ROOT, shell: true, stdio: ["inherit", "pipe", "pipe"], detached: !WIN, env: { ...process.env, FORCE_COLOR: "1" } })
  state.childPid = child.pid
  state.phase = "starting"
  saveState()
  child.stdout.on("data", (d) => write(d))
  child.stderr.on("data", (d) => write(d))

  // Without a readyText, still running after a few seconds counts as started.
  if (!S.readyText) setTimeout(() => child.exitCode === null && !stopping && markRunning(), QUIET_READY_SECONDS * 1000).unref()
  else
    setTimeout(() => {
      if (child.exitCode === null && state.phase === "starting") write(`\nThe text "${S.readyText}" (readyText) has not appeared after ${S.startTimeoutSeconds} seconds. Check the lines above.\n`)
    }, S.startTimeoutSeconds * 1000).unref()

  const code = await new Promise((r) => child.on("exit", (c) => r(c ?? 0)))
  write(`\n[${new Date().toLocaleString()}] The app stopped (exit code ${code}).\n`)
  clearInterval(heartbeat)
  fs.rmSync(STATE, { force: true })
  log.end()
}

// ---------------------------------------------------------------- start / stop (for the AI)

function logTail(n = 15) {
  return fs.existsSync(LOG) ? fs.readFileSync(LOG, "utf8").split(/\r?\n/).slice(-n).join("\n") : ""
}

async function start(full) {
  const now = liveRun()
  if (now) return console.log(now.phase === "running" ? `${NAME} is already running.` : `${NAME} is already starting. Run "node .designer/app.mjs status" in a minute.`)
  fs.mkdirSync(LOG_DIR, { recursive: true })
  const preparing = full || needsPrepare()
  const runArgs = ["run", ...(full ? ["--full"] : [])]
  if (WIN) {
    // A minimized console window titled "Design app" in the taskbar runs node directly; the app opens its own window.
    spawn("cmd.exe", ["/d", "/c", "start", '"Design app"', "/min", `"${process.execPath}"`, ".designer\\app.mjs", ...runArgs], { cwd: ROOT, windowsVerbatimArguments: true, detached: true, stdio: "ignore" }).unref()
  } else {
    const out = fs.openSync(path.join(LOG_DIR, "background.out"), "a")
    spawn(process.execPath, [path.join(HERE, "app.mjs"), ...runArgs], { cwd: ROOT, detached: true, stdio: ["ignore", out, out] }).unref()
  }
  // The AI's shell gives up after a couple of minutes; report progress instead of waiting longer.
  const begun = Date.now()
  const limit = begun + 100 * 1000
  let seen = false
  while (Date.now() < limit) {
    await sleep(1500)
    const live = liveRun()
    if (live) seen = true
    if (live && live.phase === "running") return console.log(`${NAME} is running. Its window opens by itself (it can take a few seconds). A minimized "Design app" window in the taskbar keeps it running.`)
    // stopped after it began, or never began within 30 seconds (a slow PC can take a while)
    if (!live && (seen || Date.now() > begun + 30 * 1000)) return console.log(`PROBLEM: ${NAME} stopped while starting. The last lines it printed:\n${logTail()}`)
  }
  console.log(
    preparing
      ? `${NAME} is still being installed and built (this can take several minutes). Run "node .designer/app.mjs status" in a minute or two.`
      : `${NAME} is still starting. Run "node .designer/app.mjs status" in a minute, or read the log: node .designer/app.mjs log`,
  )
}

async function stop() {
  const st = liveRun()
  if (st) {
    killTree(st.runPid)
    if (st.childPid && alive(st.childPid)) killTree(st.childPid)
    for (let i = 0; i < 20 && alive(st.runPid); i++) await sleep(500)
  }
  fs.rmSync(STATE, { force: true })
  console.log(st ? `${NAME} is stopped; its window closed.` : `${NAME} was not running.`)
}

function status() {
  const st = liveRun()
  if (!st) return console.log(`${NAME} is not running. Start it with: node .designer/app.mjs start`)
  if (st.phase === "preparing") return console.log(`${NAME} is being installed and built (started ${new Date(st.started).toLocaleString()}). Check again in a minute.`)
  if (st.phase === "starting") return console.log(`${NAME} is starting. Check again in a moment.`)
  console.log(`${NAME} is running (started ${new Date(st.started).toLocaleString()}).`)
  if (needsPrepare()) console.log("The package files changed since the app was last installed and built. Restart it: node .designer/app.mjs restart")
}

function showLog(args) {
  if (!fs.existsSync(LOG)) return console.log("No app log yet: the app has not been started with app.mjs on this computer.")
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
const full = args.includes("--full")
switch (action) {
  case "run":
    await run(full)
    break
  case "start":
    await start(full)
    break
  case "stop":
    await stop()
    break
  case "restart":
    await stop()
    await start(full)
    break
  case "status":
    status()
    break
  case "log":
    showLog(args)
    break
  case "check":
    check()
    break
  default:
    console.log(`node .designer/app.mjs start [--full] | restart [--full] | stop | status | log [N] [--errors] | check | run [--full]`)
}
