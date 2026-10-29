#!/usr/bin/env node
// setup.mjs - one-time setup of the designer's computer. Run it while logged in as the DESIGNER.
//
//   node setup.mjs <project folder> [--name "First Last"] [--email name@company] [--no-shortcut] [--skip-personal]
//   node setup.mjs <project folder> --check        only check, change nothing
//
// What it does (it can be run again safely; it never deletes anything):
//   1. copies designer-folder\ into <project>\.designer\  (settings.json is kept if it already exists)
//   2. hides .designer\ from Git on this computer only (.git\info\exclude)
//   3. turns off pushing for this project copy (push address, push default, pre-push hook)
//   4. sets the name Git records for the designer's saves (if --name/--email given or nothing is set)
//   5. copies the designer agent and commands into C:\Users\<designer>\.config\opencode\
//      (opencode.jsonc is only copied if none exists; otherwise you add the designer lines by hand)
//   6. puts a "Start app" shortcut on the Windows desktop
//   7. runs the checks and shows where the project stands

import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { fileURLToPath } from "node:url"

const KIT = path.dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const flag = (f) => args.includes(f)
const value = (f) => {
  const i = args.indexOf(f)
  return i >= 0 ? args[i + 1] : undefined
}
const positional = args.filter((a, i) => !a.startsWith("--") && !["--name", "--email"].includes(args[i - 1]))
const CHECK = flag("--check")
const WIN = process.platform === "win32"
const results = []
const ok = (m) => results.push(["ok", m])
const bad = (m) => results.push(["!!", m])
const info = (m) => results.push(["  ", m])

function git(cwd, a, allowFail = true) {
  const r = spawnSync("git", a, { cwd, encoding: "utf8", windowsHide: true })
  if (r.error && r.error.code === "ENOENT") {
    console.log("Git is not installed or not on the PATH. Install Git for Windows first.")
    process.exit(1)
  }
  if (r.status !== 0 && !allowFail) {
    console.log(`git ${a.join(" ")} failed:\n${r.stderr}`)
    process.exit(1)
  }
  return { ok: r.status === 0, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() }
}

if (!positional[0]) {
  console.log('Use: node setup.mjs <project folder> [--name "First Last"] [--email name@company] [--check]')
  process.exit(1)
}
const major = Number(process.versions.node.split(".")[0])
if (major < 18) {
  console.log(`Node.js ${process.versions.node} is too old; 18 or newer is needed.`)
  process.exit(1)
}

const PROJECT = path.resolve(positional[0])
const top = git(PROJECT, ["rev-parse", "--show-toplevel"])
if (!top.ok) {
  console.log(`${PROJECT} is not a Git project folder. Clone the project first (see the guide).`)
  process.exit(1)
}
if (path.resolve(top.out).toLowerCase() !== PROJECT.toLowerCase()) {
  console.log(`Give the project's top folder: ${path.resolve(top.out)}`)
  process.exit(1)
}
const DEST = path.join(PROJECT, ".designer")
const HOME_CFG = path.join(os.homedir(), ".config", "opencode")

// ---------------------------------------------------------------- 1. .designer folder
const src = path.join(KIT, "designer-folder")
if (CHECK) {
  for (const f of ["versions.mjs", "app.mjs", "settings.json", "Start app.cmd"]) {
    if (fs.existsSync(path.join(DEST, f))) ok(`.designer\\${f} is in place`)
    else bad(`.designer\\${f} is missing (run setup without --check)`)
  }
  for (const f of ["versions.mjs", "app.mjs"]) {
    const a = path.join(src, f)
    const b = path.join(DEST, f)
    if (fs.existsSync(a) && fs.existsSync(b) && fs.readFileSync(a, "utf8") !== fs.readFileSync(b, "utf8")) bad(`.designer\\${f} differs from the kit (run setup again to update it)`)
  }
} else {
  fs.mkdirSync(DEST, { recursive: true })
  for (const f of fs.readdirSync(src)) {
    const to = path.join(DEST, f)
    if (f === "settings.json" && fs.existsSync(to)) {
      info(".designer\\settings.json already exists: kept as it is")
      continue
    }
    fs.copyFileSync(path.join(src, f), to)
  }
  ok(`Copied the designer tools into ${DEST}`)
}

// ---------------------------------------------------------------- 2+3. exclude + push protection (doctor applies them)
if (!CHECK) {
  const r = spawnSync(process.execPath, [path.join(DEST, "versions.mjs"), "doctor"], { cwd: PROJECT, encoding: "utf8" })
  const text = (r.stdout || "").trim()
  if (r.status === 0) ok("Push protection and the private ignore line are in place" + (text.includes("Fixed:") ? " (just applied)" : ""))
  else bad("versions.mjs doctor reported a problem:\n" + text)
}
{
  const gd = git(PROJECT, ["rev-parse", "--absolute-git-dir"]).out
  const excl = path.join(gd, "info", "exclude")
  if (fs.existsSync(excl) && /^\/\.designer\/$/m.test(fs.readFileSync(excl, "utf8"))) ok(".designer\\ is hidden from Git (only on this computer)")
  else bad(".designer\\ is not hidden from Git yet")
  const st = git(PROJECT, ["status", "--porcelain", "--", ".designer"]).out
  if (st) bad(".designer\\ shows up in git status; check .git\\info\\exclude")
  const pushurl = git(PROJECT, ["config", "--get", "remote.origin.pushurl"]).out
  if (pushurl === "PUSHING-IS-TURNED-OFF-ON-THIS-COMPUTER") ok("Pushing is off: push address blocked")
  else bad("Push address is not blocked (remote.origin.pushurl)")
  if (git(PROJECT, ["config", "--get", "push.default"]).out === "nothing") ok("Pushing is off: push.default = nothing")
  else bad("push.default is not 'nothing'")
  const hooksPath = git(PROJECT, ["config", "--get", "core.hooksPath"]).out
  if (hooksPath) info(`The project uses its own hooks folder (core.hooksPath = ${hooksPath}), so no pre-push hook was added. The push address and the AI's rules still block pushing; a read-only Git account blocks it completely.`)
  else if (fs.existsSync(path.join(gd, "hooks", "pre-push"))) ok("Pushing is off: pre-push hook in place")
  else bad("pre-push hook missing")
  const remote = git(PROJECT, ["remote", "get-url", "origin"])
  if (!remote.ok) bad("The project has no remote called origin, so get-latest cannot download anything. Clone the project from the Git server instead of copying it.")
}

// ---------------------------------------------------------------- 4. identity
{
  const name = value("--name")
  const email = value("--email")
  if (!CHECK && name) git(PROJECT, ["config", "user.name", name], false)
  if (!CHECK && email) git(PROJECT, ["config", "user.email", email], false)
  const n = git(PROJECT, ["config", "user.name"]).out
  const e = git(PROJECT, ["config", "user.email"]).out
  if (n && e) ok(`Saves are recorded as ${n} <${e}>`)
  else info('No Git name/e-mail set; saves are recorded as "Designer". Add --name and --email to set them.')
}

// ---------------------------------------------------------------- 5. personal OpenCode files
if (!flag("--skip-personal")) {
  const psrc = path.join(KIT, "personal")
  if (!CHECK) {
    for (const sub of ["agents", "commands"]) {
      fs.mkdirSync(path.join(HOME_CFG, sub), { recursive: true })
      for (const f of fs.readdirSync(path.join(psrc, sub))) fs.copyFileSync(path.join(psrc, sub, f), path.join(HOME_CFG, sub, f))
    }
    ok(`Copied the designer agent and ${fs.readdirSync(path.join(psrc, "commands")).length} commands into ${HOME_CFG}`)
  }
  if (fs.existsSync(path.join(HOME_CFG, "agents", "designer.md"))) ok("designer agent is in the personal OpenCode folder")
  else bad("designer agent is missing from the personal OpenCode folder")
  const cfgFile = ["opencode.jsonc", "opencode.json"].map((f) => path.join(HOME_CFG, f)).find((f) => fs.existsSync(f))
  if (!cfgFile) {
    if (!CHECK) {
      fs.copyFileSync(path.join(psrc, "opencode.jsonc"), path.join(HOME_CFG, "opencode.jsonc"))
      info(`Copied a personal opencode.jsonc to ${HOME_CFG}. Replace <LLM_URL>, <GLM_ID> and <MINIMAX_ID> in it.`)
    } else bad("No personal opencode.jsonc yet")
  } else {
    const text = fs.readFileSync(cfgFile, "utf8")
    if (/<LLM_URL>|<GLM_ID>|<MINIMAX_ID>/.test(text)) bad(`${cfgFile} still has placeholders (<LLM_URL>, <GLM_ID> or <MINIMAX_ID>)`)
    if (/"default_agent"\s*:\s*"designer"/.test(text)) ok(`${path.basename(cfgFile)} starts every chat with the designer agent`)
    else bad(`${cfgFile} exists but has no "default_agent": "designer". Add the designer lines from the kit's personal\\opencode.jsonc.`)
  }
}

// ---------------------------------------------------------------- 6. desktop shortcut
if (WIN && !CHECK && !flag("--no-shortcut")) {
  const target = path.join(DEST, "Start app.cmd")
  const ps = `$d=[Environment]::GetFolderPath('Desktop'); $s=(New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $d 'Start app.lnk')); $s.TargetPath='${target.replace(/'/g, "''")}'; $s.WorkingDirectory='${PROJECT.replace(/'/g, "''")}'; $s.Description='Start the app for design work'; $s.Save()`
  const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { encoding: "utf8", windowsHide: true })
  if (r.status === 0) ok('Put a "Start app" shortcut on the desktop')
  else info('Could not create the desktop shortcut. Right-click .designer\\Start app.cmd > Show more options > Send to > Desktop (create shortcut).')
}

// ---------------------------------------------------------------- 7. tools work?
{
  const v = spawnSync(process.execPath, [path.join(DEST, "versions.mjs"), "status"], { cwd: PROJECT, encoding: "utf8" })
  if (v.status === 0) ok("versions.mjs runs")
  else bad("versions.mjs status failed:\n" + (v.stdout || v.stderr))
  const a = spawnSync(process.execPath, [path.join(DEST, "app.mjs"), "status"], { cwd: PROJECT, encoding: "utf8" })
  if (a.status === 0) ok("app.mjs runs")
  else bad("app.mjs status failed:\n" + (a.stdout || a.stderr))
  if (v.status === 0) info("\nWhere the project stands:\n" + v.stdout.trim().split("\n").map((l) => "     " + l).join("\n"))
}

console.log(`\n${CHECK ? "Check" : "Setup"} of ${PROJECT}\n`)
for (const [k, m] of results) console.log(`[${k}] ${m}`)
const problems = results.filter((r) => r[0] === "!!").length
console.log(problems ? `\n${problems} thing(s) need attention (marked !!).` : "\nAll good.")
process.exit(problems ? 1 : 0)
