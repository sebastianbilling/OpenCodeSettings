#!/usr/bin/env node
// check-milestones.mjs
// Checks a plan that was split into milestones by the milestones agent:
//   1. Every step of the original plan is in a milestone: none lost, none twice.
//   2. Each milestone fits in one fresh session: the files that are always
//      loaded, the overview, the milestone file and the architecture chapters
//      it names stay under a share of the model's context window. The rest of
//      the window is left for code, test output and the model's own thinking.
// Uses only Node's built-in modules: nothing to install.
//
// Usage (from the project root):
//   node tools/check-milestones.mjs <plan-name> [--context 262144] [--share 0.35]
//
//   <plan-name>   the plan file name without .md: password-reset for
//                 .opencode/plans/password-reset.md, whose milestones are in
//                 .opencode/plans/password-reset/
//   --context     the model's real context window in tokens
//   --share       how much of it the reading may use
//
// Exit code 0 = OK (warnings allowed), 1 = problems to fix.

import fs from "node:fs";
import path from "node:path";

// ---------- settings: change these two to fit your model server ----------
const DEFAULT_CONTEXT = 262144; // the real context window of the model that builds, in tokens
const DEFAULT_SHARE = 0.35; // share of it for reading; the rest is for code, test output and thinking

// ---------- other settings ----------
const PLANS = path.join(".opencode", "plans");
const ARCH = path.join("docs", "architecture");
const DECISIONS = path.join("docs", "decisions");
const ALWAYS = ["AGENTS.md", path.join(ARCH, "ESSENTIALS.md"), path.join(ARCH, "GLOSSARY.md"), path.join(ARCH, "INDEX.md")];
// OpenCode's own instructions and tool descriptions, sent with every request.
// Measured for the Build agent: about 12.4k on 1.4.3 and 8.6k on 1.18.19.
const OPENCODE_OVERHEAD = 13000;
const MAX_STEPS = 5; // more plan steps than this in one milestone gives a warning
const MAX_MILESTONE_TOKENS = 4000; // a bigger milestone file gives a warning

// A step label: 3, 3.1, 3.1.2, 3a
const ID = String.raw`(\d+(?:\.\d+)*[a-z]?)`;

// ---------- arguments ----------
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] !== undefined ? Number(args[i + 1]) : fallback;
};
const nameArg = args.find((a, i) => !a.startsWith("--") && !["--context", "--share"].includes(args[i - 1]));
if (!nameArg) {
  console.error("Usage: node tools/check-milestones.mjs <plan-name> [--context 262144] [--share 0.35]");
  process.exit(1);
}
const CONTEXT = opt("--context", DEFAULT_CONTEXT);
const SHARE = opt("--share", DEFAULT_SHARE);
const BUDGET = Math.floor(CONTEXT * SHARE);
const name = path.basename(nameArg.replace(/\\/g, "/")).replace(/\.md$/i, "");
const planPath = path.join(PLANS, `${name}.md`);
const dir = path.join(PLANS, name);

// ---------- helpers ----------
// Rough token estimate, on the safe side: 3.5 characters per token.
const tokens = (text) => Math.ceil(text.length / 3.5);
const k = (n) => (n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(n));
const read = (p) => (fs.existsSync(p) ? fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n") : null);
const problems = [];
const warnings = [];

// The text of the "## <title>" sections whose title matches, up to the next "## ".
function sections(text, titleRe) {
  const out = [];
  let take = false;
  for (const line of text.split("\n")) {
    const h = line.match(/^##\s+(.*)$/);
    if (h) take = titleRe.test(h[1]);
    else if (take) out.push(line);
  }
  return out.join("\n");
}

// Find the step labels in the original plan, in order. Understands:
//   headings     "### Step 4: ...", "### Steg 3.1", "### Plan step 2"
//   bold lines   "**Step 4:** ...", "**Steg 4.**"
//   numbered     "### 4. Title" or "4. Title" under a "Steps"/"Steg" heading or line
function planSteps(text) {
  const named = [];
  const numberedHeadings = [];
  const numbered = [];
  let inFence = false;
  let stepsLevel = 0; // level of the "Steps" heading we are under, 0 = not in it
  let stepsLine = false; // under a "Steps:" line that is not a heading
  for (const line of text.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const h = line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (h) {
      const level = h[1].length;
      const title = h[2].replace(/[*_`]/g, "").trim();
      const n = title.match(new RegExp(String.raw`^(?:plan\s*)?(?:step|steg)\s+${ID}(?![\w.]*\d)`, "i"));
      if (n) named.push(n[1].toLowerCase());
      if (stepsLevel && level > stepsLevel) {
        const m = title.match(new RegExp(String.raw`^${ID}[.):]?\s`, "i"));
        if (m && !n) numberedHeadings.push(m[1].toLowerCase());
        continue;
      }
      stepsLevel = /^(?:\d+[.)]\s*)?(steps|steg)\b/i.test(title) ? level : 0;
      stepsLine = false;
      continue;
    }
    const bold = line.match(new RegExp(String.raw`^\s*\*\*\s*(?:plan\s*)?(?:step|steg)\s+${ID}\b`, "i"));
    if (bold) {
      named.push(bold[1].toLowerCase());
      continue;
    }
    if (/^\s*(\*\*)?(steps|steg)(\*\*)?\s*:?\s*(\*\*)?\s*:?\s*$/i.test(line)) {
      stepsLine = true;
      continue;
    }
    if (stepsLevel || stepsLine) {
      const m = line.match(new RegExp(String.raw`^(?:\*\*)?${ID}[.)]\s`, "i"));
      if (m) numbered.push(m[1].toLowerCase());
    }
  }
  if (named.length) {
    // Sub-step headings ("#### 3.1 ...") under a named step count too.
    const subs = numberedHeadings.filter((id) => ancestors(id).some((a) => named.includes(a)));
    return { ids: [...named, ...subs], how: "step headings" };
  }
  if (numberedHeadings.length) return { ids: numberedHeadings, how: "numbered headings under Steps" };
  if (numbered.length) return { ids: numbered, how: "numbered list under Steps" };
  return null;
}

// "3.1" -> ["3"], "3.1.2" -> ["3", "3.1"], "3a" -> ["3"]
function ancestors(id) {
  const out = [];
  const letter = id.match(/^(.*\d)[a-z]$/);
  if (letter) out.push(letter[1]);
  const base = letter ? letter[1] : id;
  const parts = base.split(".");
  for (let i = parts.length - 1; i > 0; i--) out.push(parts.slice(0, i).join("."));
  return out;
}

// ---------- read the files ----------
const plan = read(planPath);
if (plan === null) problems.push(`The plan file ${planPath} was not found.`);
if (!fs.existsSync(dir)) {
  console.error(`The milestone folder ${dir} was not found. Run /split-plan ${name} first.`);
  process.exit(1);
}
const overview = read(path.join(dir, "00-overview.md"));
if (overview === null) problems.push(`00-overview.md is missing in ${dir}.`);

const files = fs
  .readdirSync(dir)
  .filter((f) => /^\d{2}-.+\.md$/i.test(f) && f.toLowerCase() !== "00-overview.md")
  .sort();
if (!files.length) problems.push(`No milestone files (01-....md, 02-....md) in ${dir}.`);

// Architecture chapters and decision notes that exist, by file name
const known = new Map();
for (const folder of [ARCH, DECISIONS]) {
  if (!fs.existsSync(folder)) continue;
  for (const f of fs.readdirSync(folder)) {
    if (f.toLowerCase().endsWith(".md")) known.set(f.toLowerCase(), path.join(folder, f));
  }
}
const alwaysNames = new Set(ALWAYS.map((p) => path.basename(p).toLowerCase()));
const alwaysParts = ALWAYS.map((p) => ({ p, t: tokens(read(p) ?? "") }));
const alwaysTokens = OPENCODE_OVERHEAD + alwaysParts.reduce((s, x) => s + x.t, 0);
const overviewTokens = overview === null ? 0 : tokens(overview);

// ---------- check each milestone ----------
const found = new Map(); // step label -> [{ file, part, of }]
const rows = [];
const stepRe = new RegExp(String.raw`^#{2,5}\s*\**\s*(?:plan\s*step|plansteg)\s+${ID}(?![\w.]*\d)([^\n]*)$`, "gim");
for (const file of files) {
  const text = read(path.join(dir, file));
  const own = tokens(text);
  const steps = [...text.matchAll(stepRe)];
  for (const m of steps) {
    const id = m[1].toLowerCase();
    const part = m[2].match(/\(\s*(?:part|del)\s+(\d+)\s+(?:of|av)\s+(\d+)\s*\)/i);
    if (!found.has(id)) found.set(id, []);
    found.get(id).push({ file, part: part ? Number(part[1]) : 0, of: part ? Number(part[2]) : 0 });
  }

  // Chapters count only where the milestone tells the builder to read them.
  let reading = sections(text, /before you start|architecture rules/i);
  if (!reading.trim()) reading = text.replace(/^##\s+not in this milestone[\s\S]*?(?=^##\s|(?![\s\S]))/im, "");
  const chapters = new Set();
  for (const m of reading.matchAll(/[\w.-]+\.md\b/gi)) {
    const key = m[0].toLowerCase();
    if (known.has(key) && !alwaysNames.has(key)) chapters.add(known.get(key));
  }
  const toRead = reading.match(/^\s*-\s*architecture chapters to read:\s*(.*)$/im);
  if (toRead && !chapters.size && !/^\s*(none\b|nothing\b|-|—|$)/i.test(toRead[1])) {
    problems.push(`${file}: "Architecture chapters to read" names no existing chapter file. Use exact file names, for example 03-01-authentication.md.`);
  }
  const chapterTokens = [...chapters].reduce((s, p) => s + tokens(read(p) ?? ""), 0);
  const total = alwaysTokens + overviewTokens + own + chapterTokens;
  rows.push({ file, steps: steps.length, own, chapters: chapters.size, chapterTokens, total });

  if (!steps.length) problems.push(`${file}: no "### Plan step <number>: ..." headings.`);
  if (steps.length > MAX_STEPS) warnings.push(`${file}: ${steps.length} plan steps; consider splitting it.`);
  if (own > MAX_MILESTONE_TOKENS) warnings.push(`${file}: the file itself is about ${k(own)} tokens; check it copies only what this milestone needs.`);
  if (total > BUDGET) {
    problems.push(
      `${file}: reading load about ${k(total)} tokens, over the budget of ${k(BUDGET)}. ` +
        `Split it, or name fewer chapters (it names ${chapters.size}, about ${k(chapterTokens)} tokens).`
    );
  }
}

// ---------- step coverage ----------
const planned = plan === null ? null : planSteps(plan);
const planIds = planned ? planned.ids : [];
const planSet = new Set(planIds);

// The plan itself must not use the same label twice.
const seen = new Set();
const twiceInPlan = new Set();
for (const id of planIds) (seen.has(id) ? twiceInPlan : seen).add(id);
if (twiceInPlan.size) {
  problems.push(
    `The plan uses the same step number more than once (${[...twiceInPlan].join(", ")}), for example because numbering restarts in each phase. ` +
      `Ask the user to renumber the plan so every step has its own number.`
  );
}

// Each label in the milestones: once, or as a complete set of parts 1..Y.
for (const [id, occ] of found) {
  if (occ.length === 1 && !occ[0].part) continue;
  const parted = occ.every((o) => o.part);
  const of = occ[0].of;
  const nums = occ.map((o) => o.part).sort((a, b) => a - b);
  const complete = parted && occ.every((o) => o.of === of) && nums.length === of && nums.every((n, i) => n === i + 1);
  if (!complete) {
    if (!parted) problems.push(`Plan step ${id} is in more than one milestone (${occ.map((o) => o.file).join(", ")}).`);
    else problems.push(`Plan step ${id} is split into parts, but not as a complete set "(part 1 of ${of})" to "(part ${of} of ${of})" (found: ${occ.map((o) => `part ${o.part} of ${o.of} in ${o.file}`).join("; ")}).`);
  }
}

if (planned) {
  // A plan step is covered by itself, by a parent step (3 covers 3.1),
  // or by all of its own sub-steps (3.1 and 3.2 cover 3).
  const covered = (id) =>
    found.has(id) ||
    ancestors(id).some((a) => found.has(a)) ||
    (() => {
      const kids = planIds.filter((p) => ancestors(p)[0] === id);
      return kids.length > 0 && kids.every(covered);
    })();
  const missing = [...planSet].filter((id) => !covered(id));
  if (missing.length) problems.push(`Plan step(s) not in any milestone: ${missing.join(", ")}.`);
  // A label the plan does not have is wrong, except a parent of plan sub-steps.
  const extra = [...found.keys()].filter((id) => !planSet.has(id) && !planIds.some((p) => ancestors(p).includes(id)));
  if (extra.length) problems.push(`Milestones name plan step(s) that the plan does not have: ${extra.join(", ")}.`);
} else if (plan !== null) {
  warnings.push(`Could not find numbered steps in ${planPath}, so coverage was NOT checked. Compare the plan's steps with the milestones by hand.`);
}

// ---------- report ----------
const planKB = plan === null ? 0 : Math.ceil(Buffer.byteLength(plan, "utf8") / 1024);
console.log(`Plan: ${planPath}  (${planKB} KB, ${planned ? `${planSet.size} steps, from ${planned.how}` : "steps not found"})`);
console.log(`Budget per milestone: ${k(BUDGET)} tokens = ${Math.round(SHARE * 100)}% of a ${k(CONTEXT)} context`);
console.log(`Always loaded: about ${k(alwaysTokens)} (OpenCode ${k(OPENCODE_OVERHEAD)}, ${alwaysParts.map((x) => `${path.basename(x.p)} ${k(x.t)}`).join(", ")})`);
console.log(`Overview: about ${k(overviewTokens)}`);
console.log("");
console.log("Milestone".padEnd(44) + "Steps" + "  File".padStart(8) + "  Chapters".padStart(16) + "   Total" + "  OK?");
for (const r of rows) {
  console.log(
    r.file.padEnd(44) +
      String(r.steps).padStart(5) +
      k(r.own).padStart(8) +
      `${r.chapters} = ${k(r.chapterTokens)}`.padStart(16) +
      k(r.total).padStart(8) +
      (r.total > BUDGET ? "  TOO BIG" : "  ok")
  );
}
console.log("");
for (const w of warnings) console.log(`Warning: ${w}`);
for (const p of problems) console.log(`PROBLEM: ${p}`);
if (problems.length) {
  console.log(`\nResult: ${problems.length} problem(s) to fix.`);
  process.exit(1);
}
const coverage = planned ? "every plan step covered" : "plan steps NOT checked";
console.log(`\nResult: OK. ${rows.length} milestones, ${coverage}, each fits the budget${warnings.length ? ` (${warnings.length} warning(s) above)` : ""}.`);
