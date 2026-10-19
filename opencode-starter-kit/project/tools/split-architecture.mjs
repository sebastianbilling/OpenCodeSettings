#!/usr/bin/env node
// split-architecture.mjs
// Cuts the big architecture markdown file into one file per chapter, so the AI
// can read the 10 pages it needs instead of all 200. Chapters that are too long
// are split again at the next heading level.
// Uses only Node's built-in modules: nothing to install.
//
// Usage (from the project root):
//   node tools/split-architecture.mjs <architecture.md> [options]
//
// Options:
//   --out <folder>     where to write chapter files (default: docs/architecture)
//   --level <1-3>      heading level that starts a chapter (default: automatic)
//   --max-words <n>    split chapters longer than this again (default: 6000, about 12 pages)
//   --dry-run          only show what would be written
//   --force            overwrite existing chapter files (INDEX.md, ESSENTIALS.md
//                      and GLOSSARY.md are never touched)

import fs from "node:fs";
import path from "node:path";

// ---------- arguments ----------
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const flag = (name) => args.includes(name);
const input = args.find((a, i) => !a.startsWith("--") && !["--out", "--level", "--max-words"].includes(args[i - 1]));
if (!input) {
  console.error("Usage: node tools/split-architecture.mjs <architecture.md> [--out docs/architecture] [--level 1] [--max-words 6000] [--dry-run] [--force]");
  process.exit(1);
}
const OUT = opt("--out", path.join("docs", "architecture"));
const MAX_WORDS = Number(opt("--max-words", 6000));
const DRY = flag("--dry-run");
const FORCE = flag("--force");
const KEEP = new Set(["INDEX.md", "ESSENTIALS.md", "GLOSSARY.md"]);

const lines = fs.readFileSync(input, "utf8").replace(/\r\n/g, "\n").split("\n");

// ---------- find headings (ignoring ``` code blocks) ----------
const headings = [];
let inFence = false;
for (let i = 0; i < lines.length; i++) {
  if (/^\s{0,3}(```|~~~)/.test(lines[i])) inFence = !inFence;
  if (inFence) continue;
  const m = lines[i].match(/^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/);
  if (m) headings.push({ line: i, level: m[1].length, title: m[2] });
}
if (!headings.length) {
  console.error("No markdown headings (# ...) found. Is this the converted file?");
  process.exit(1);
}

// ---------- choose the chapter level ----------
// If there is exactly one top-level heading (the document title),
// chapters start one level below it.
let LEVEL = Number(opt("--level", 0));
if (!LEVEL) {
  const top = Math.min(...headings.map((h) => h.level));
  const topCount = headings.filter((h) => h.level === top).length;
  LEVEL = topCount === 1 && headings.some((h) => h.level === top + 1) ? top + 1 : top;
}
if (!headings.some((h) => h.level === LEVEL)) {
  console.error(`No level-${LEVEL} headings found. Try a different --level.`);
  process.exit(1);
}

// ---------- helpers ----------
const words = (text) => (text.match(/[\p{L}\p{N}][\p{L}\p{N}_'’-]*/gu) || []).length;
const plain = (t) => t.replace(/[*_`]/g, "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").trim();
function slug(title) {
  return plain(title)
    .replace(/^(chapter|kapitel|section|avsnitt)\s+/i, "")
    .replace(/^[\d.\s]+(?=\p{L})/u, "") // drop leading numbering like "3.2 "
    .replace(/æ/gi, "ae").replace(/ø/gi, "o").replace(/ß/g, "ss")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50)
    .replace(/-+$/, "") || "section";
}
const pad = (n) => String(n).padStart(2, "0");
const sliceText = (from, to) => lines.slice(from, to).join("\n").trim() + "\n";

// ---------- build the list of files ----------
const chapterStarts = headings.filter((h) => h.level <= LEVEL);
const files = [];

// Anything before the first chapter (document title, intro, table of contents)
const firstChapter = chapterStarts.find((h) => h.level === LEVEL);
if (firstChapter.line > 0) {
  const text = sliceText(0, firstChapter.line);
  if (words(text) > 0) files.push({ name: "00-front-matter.md", title: "Front matter", text, from: 0, to: firstChapter.line });
}

let n = 0;
chapterStarts.forEach((ch, idx) => {
  if (ch.line < firstChapter.line) return; // already in the front matter
  n++;
  const end = chapterStarts.find((c, j) => j > idx)?.line ?? lines.length;
  const text = sliceText(ch.line, end);
  const title = plain(ch.title);

  if (words(text) <= MAX_WORDS) {
    files.push({ name: `${pad(n)}-${slug(ch.title)}.md`, title, text, from: ch.line, to: end });
    return;
  }

  // Too long: split again at the next heading level inside this chapter
  const subs = headings.filter((h) => h.line > ch.line && h.line < end && h.level === LEVEL + 1);
  if (!subs.length) {
    files.push({ name: `${pad(n)}-${slug(ch.title)}.md`, title, text, from: ch.line, to: end, long: true });
    return;
  }
  const intro = sliceText(ch.line, subs[0].line);
  files.push({ name: `${pad(n)}-00-${slug(ch.title)}.md`, title: `${title} (introduction)`, text: intro, from: ch.line, to: subs[0].line });
  subs.forEach((s, k) => {
    const sEnd = subs[k + 1]?.line ?? end;
    const crumb = `> Part of chapter ${n}: ${title}\n\n`;
    const sText = crumb + sliceText(s.line, sEnd);
    files.push({ name: `${pad(n)}-${pad(k + 1)}-${slug(s.title)}.md`, title: `${title} › ${plain(s.title)}`, text: sText, from: s.line, to: sEnd, long: words(sText) > MAX_WORDS });
  });
});

// ---------- safety check: nothing lost ----------
const srcLines = lines.filter((l) => l.trim()).length;
const outLines = files.reduce((sum, f) => sum + lines.slice(f.from, f.to).filter((l) => l.trim()).length, 0);
if (outLines !== srcLines) {
  console.error(`Safety check failed: ${srcLines - outLines} non-empty line(s) would be lost. Nothing written.`);
  process.exit(1);
}

// ---------- write ----------
const existing = fs.existsSync(OUT) ? fs.readdirSync(OUT).filter((f) => f.endsWith(".md") && !KEEP.has(f)) : [];
if (existing.length && !FORCE && !DRY) {
  console.error(`${OUT} already contains ${existing.length} chapter file(s). Nothing written.`);
  console.error(`Run again with --force to replace them (INDEX.md, ESSENTIALS.md and GLOSSARY.md are kept).`);
  process.exit(1);
}
if (!DRY) {
  fs.mkdirSync(OUT, { recursive: true });
  for (const f of existing) fs.unlinkSync(path.join(OUT, f));
  for (const f of files) fs.writeFileSync(path.join(OUT, f.name), f.text, "utf8");
}

// INDEX.md skeleton, only if there is none yet
const indexPath = path.join(OUT, "INDEX.md");
let indexWritten = false;
if (!DRY && !fs.existsSync(indexPath)) {
  const rows = files.map((f) => {
    const subs = headings
      .filter((h) => h.line > f.from && h.line < f.to && h.level <= LEVEL + 2 && h.level > LEVEL)
      .map((h) => plain(h.title))
      .slice(0, 12);
    return [
      `### ${f.name}`,
      `- **Title:** ${f.title}`,
      `- **Covers:** TODO (1-2 lines)`,
      `- **Read when:** TODO (which tasks need this chapter)`,
      subs.length ? `- **Sections:** ${subs.join("; ")}` : null,
    ].filter(Boolean).join("\n");
  });
  const indexText = [
    "# Architecture index",
    "",
    "Map of the architecture chapters in this folder. Use it to decide which chapter files to read for a task.",
    "Always read the chapter itself before relying on it; this index is only a summary.",
    "",
    ...rows.flatMap((r) => [r, ""]),
  ].join("\n");
  fs.writeFileSync(indexPath, indexText, "utf8");
  indexWritten = true;
}

// ---------- summary ----------
const estTokens = (t) => Math.round(t.length / 4);
console.log(`Chapter level: H${LEVEL}   Files: ${files.length}   Output: ${OUT}${DRY ? "   (dry run, nothing written)" : ""}`);
console.log("");
console.log("File".padEnd(60) + "Words".padStart(7) + "  ~Pages" + "  ~Tokens");
for (const f of files) {
  const w = words(f.text);
  console.log((f.name + (f.long ? "  <- still long" : "")).padEnd(60) + String(w).padStart(7) + String(Math.max(1, Math.round(w / 500))).padStart(8) + String(estTokens(f.text)).padStart(9));
}
const total = files.reduce((s, f) => s + f.text.length, 0);
console.log("");
console.log(`Whole document: about ${Math.round(total / 4).toLocaleString("en")} tokens.`);
if (indexWritten) console.log(`Created ${indexPath} with TODOs for step 3.`);
if (!DRY && !indexWritten) console.log(`${indexPath} already existed and was not changed. Update it if chapter files changed.`);
if (files.some((f) => f.long)) console.log(`Files marked "still long" have no smaller headings to split on. They work as they are; split them by hand only if the AI struggles with them.`);
