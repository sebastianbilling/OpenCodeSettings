#!/usr/bin/env node
// verify-conversion.mjs
// Compares the original architecture HTML with its markdown conversion and
// reports headings that went missing and sections that got much shorter.
// Uses only Node's built-in modules: nothing to install.
//
// Usage (from the project root):
//   node tools/verify-conversion.mjs <original.html> <converted.md> [--threshold 0.8]
//
// Writes a readable report next to the markdown file: conversion-report.md

import fs from "node:fs";
import path from "node:path";

// ---------- arguments ----------
const args = process.argv.slice(2);
const positional = args.filter((a) => !a.startsWith("--"));
const thresholdIdx = args.indexOf("--threshold");
const THRESHOLD = thresholdIdx >= 0 ? Number(args[thresholdIdx + 1]) : 0.8;
const MIN_WORDS = 30; // ignore very small sections when comparing length

if (positional.length < 2) {
  console.error("Usage: node tools/verify-conversion.mjs <original.html> <converted.md> [--threshold 0.8]");
  process.exit(1);
}
const [htmlPath, mdPath] = positional;
const html = fs.readFileSync(htmlPath, "utf8");
const md = fs.readFileSync(mdPath, "utf8").replace(/\r\n/g, "\n");

// ---------- helpers ----------
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "-", mdash: "-", hellip: "...", rsquo: "'", lsquo: "'", rdquo: '"', ldquo: '"', aring: "å", auml: "ä", ouml: "ö", Aring: "Å", Auml: "Ä", Ouml: "Ö", eacute: "é", uuml: "ü", Uuml: "Ü", szlig: "ß", copy: "(c)", reg: "(r)", trade: "(tm)", times: "x", rarr: "->", larr: "<-", bull: "*", middot: "*" };

function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&([a-z]+);/gi, (m, n) => (n in ENTITIES ? ENTITIES[n] : m));
}

function htmlToText(fragment) {
  return decodeEntities(
    fragment
      .replace(/<(br|\/p|\/div|\/li|\/tr|\/td|\/th|\/h[1-6]|\/pre)[^>]*>/gi, " ")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/\s+/g, " ")
    .trim();
}

function mdToText(fragment) {
  return fragment
    .replace(/^```.*$/gm, " ") // fence lines
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1") // images -> alt text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // links -> text
    .replace(/<[^>]+>/g, " ") // stray html
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, " ") // heading/quote/list markers
    .replace(/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/gm, " ") // table separator rows
    .replace(/[|*`~]/g, " ")
    .replace(/(^|[\s(])_+|_+(?=[\s).,;:!?]|$)/gm, "$1 ") // _emphasis_ but not snake_case
    .replace(/\s+/g, " ")
    .trim();
}

const countWords = (text) => (text ? text.split(" ").filter((w) => /[\p{L}\p{N}]/u.test(w)).length : 0);

// Normalise heading text so "3.2 Data **Model**" matches "3.2 Data Model"
function norm(s) {
  return decodeEntities(s)
    .replace(/<[^>]+>/g, "")
    .replace(/[*_`#]/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

// ---------- parse HTML into sections ----------
function parseHtml(src) {
  const clean = src
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|noscript|template)[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<head[^>]*>[\s\S]*?<\/head>/i, "");
  const re = /<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi;
  const sections = [];
  let last = { level: 0, title: "(before first heading)", start: 0, bodyStart: 0 };
  let m;
  while ((m = re.exec(clean))) {
    last.body = clean.slice(last.bodyStart, m.index);
    sections.push(last);
    last = { level: Number(m[1]), title: htmlToText(m[2]), start: m.index, bodyStart: re.lastIndex };
  }
  last.body = clean.slice(last.bodyStart);
  sections.push(last);
  for (const s of sections) s.words = countWords(htmlToText(s.body));
  return {
    sections,
    tables: (clean.match(/<table[\s>]/gi) || []).length,
    images: (clean.match(/<img[\s>]/gi) || []).length,
    svgs: (clean.match(/<svg[\s>]/gi) || []).length,
    codeBlocks: (clean.match(/<pre[\s>]/gi) || []).length,
    totalWords: countWords(htmlToText(clean.replace(/^[\s\S]*?<body[^>]*>/i, ""))),
  };
}

// ---------- parse markdown into sections ----------
function parseMd(src) {
  const lines = src.split("\n");
  const sections = [];
  let current = { level: 0, title: "(before first heading)", lines: [] };
  let inFence = false;
  let tables = 0, images = 0, codeBlocks = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s{0,3}(```|~~~)/.test(line)) {
      if (!inFence) codeBlocks++;
      inFence = !inFence;
      current.lines.push(line);
      continue;
    }
    if (!inFence) {
      images += (line.match(/!\[[^\]]*\]\([^)]*\)/g) || []).length + (line.match(/<img[\s>]/gi) || []).length;
      if (/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line)) tables++;
      const atx = line.match(/^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/);
      const next = lines[i + 1] ?? "";
      const setext = line.trim() && !/^\s*[-*+>|]/.test(line) && /^\s{0,3}(=+|-+)\s*$/.test(next) && !/^\s*$/.test(line);
      if (atx || setext) {
        sections.push(current);
        current = atx
          ? { level: atx[1].length, title: atx[2], lines: [] }
          : { level: next.trim().startsWith("=") ? 1 : 2, title: line.trim(), lines: [] };
        if (setext) i++;
        continue;
      }
    }
    current.lines.push(line);
  }
  sections.push(current);
  for (const s of sections) s.words = countWords(mdToText(s.lines.join("\n")));
  return { sections, tables, images, codeBlocks, totalWords: countWords(mdToText(src)) };
}

// ---------- compare ----------
const H = parseHtml(html);
const M = parseMd(md);

// Match headings in order: for each HTML heading, take the first unused
// markdown heading with the same normalised text.
const mdPool = M.sections.slice(1).map((s, i) => ({ ...s, key: norm(s.title), used: false, idx: i }));
const missing = [];
const shorter = [];
const levelChanged = [];
for (const hs of H.sections.slice(1)) {
  const key = norm(hs.title);
  if (!key) continue;
  const match = mdPool.find((p) => !p.used && p.key === key);
  if (!match) {
    missing.push(hs);
    continue;
  }
  match.used = true;
  if (match.level !== hs.level) levelChanged.push({ title: hs.title, html: hs.level, md: match.level });
  if (hs.words >= MIN_WORDS && match.words < hs.words * THRESHOLD) {
    shorter.push({ title: hs.title, html: hs.words, md: match.words, pct: Math.round((match.words / hs.words) * 100) });
  }
}
const extra = mdPool.filter((p) => !p.used && p.key);

// ---------- report ----------
const pct = (a, b) => (b ? Math.round((a / b) * 100) + "%" : "-");
const out = [];
out.push(`# Conversion report`);
out.push("");
out.push(`- Original: \`${htmlPath}\``);
out.push(`- Converted: \`${mdPath}\``);
out.push(`- Generated: ${new Date().toISOString().slice(0, 16).replace("T", " ")}`);
out.push("");
out.push(`## Totals`);
out.push("");
out.push(`| What | HTML | Markdown | Markdown as % of HTML |`);
out.push(`| --- | ---: | ---: | ---: |`);
out.push(`| Words | ${H.totalWords} | ${M.totalWords} | ${pct(M.totalWords, H.totalWords)} |`);
out.push(`| Headings | ${H.sections.length - 1} | ${M.sections.length - 1} | ${pct(M.sections.length - 1, H.sections.length - 1)} |`);
out.push(`| Tables | ${H.tables} | ${M.tables} | ${pct(M.tables, H.tables)} |`);
out.push(`| Images | ${H.images} | ${M.images} | ${pct(M.images, H.images)} |`);
out.push(`| Inline SVG diagrams | ${H.svgs} | - | - |`);
out.push(`| Code blocks | ${H.codeBlocks} | ${M.codeBlocks} | ${pct(M.codeBlocks, H.codeBlocks)} |`);
out.push("");
out.push(`## Headings missing from the markdown (${missing.length})`);
out.push("");
out.push(missing.length ? missing.map((s) => `- H${s.level} ${s.title} (${s.words} words in HTML)`).join("\n") : "None. Good.");
out.push("");
out.push(`## Sections that got shorter than ${Math.round(THRESHOLD * 100)}% (${shorter.length})`);
out.push("");
out.push(
  shorter.length
    ? ["| Section | HTML words | Markdown words | Kept |", "| --- | ---: | ---: | ---: |", ...shorter.map((s) => `| ${s.title} | ${s.html} | ${s.md} | ${s.pct}% |`)].join("\n")
    : "None. Good."
);
out.push("");
out.push(`## Headings only in the markdown (${extra.length})`);
out.push("");
out.push(extra.length ? extra.map((s) => `- H${s.level} ${s.title}`).join("\n") : "None.");
out.push("");
out.push(`## Heading level changed (${levelChanged.length})`);
out.push("");
out.push(levelChanged.length ? levelChanged.map((s) => `- ${s.title}: H${s.html} in HTML, H${s.md} in markdown`).join("\n") : "None.");
out.push("");
out.push(`## What to do`);
out.push("");
out.push(`- Missing headings and much shorter sections: compare those parts by hand and paste in what was lost.`);
out.push(`- Tables or images lower than the HTML: find them in the HTML and fix the markdown.`);
out.push(`- Images and SVG diagrams: the AI cannot see pictures. Add a short written description under each important diagram.`);
out.push(`- Small word differences (90-100%) are normal: menus, footers and link text disappear in conversion.`);

const reportPath = path.join(path.dirname(mdPath), "conversion-report.md");
fs.writeFileSync(reportPath, out.join("\n") + "\n", "utf8");

console.log(`Words:    HTML ${H.totalWords}  markdown ${M.totalWords}  (${pct(M.totalWords, H.totalWords)})`);
console.log(`Headings: HTML ${H.sections.length - 1}  markdown ${M.sections.length - 1}`);
console.log(`Tables:   HTML ${H.tables}  markdown ${M.tables}`);
console.log(`Images:   HTML ${H.images} (+${H.svgs} inline SVG)  markdown ${M.images}`);
console.log(`Missing headings: ${missing.length}   Much shorter sections: ${shorter.length}`);
console.log(`Full report: ${reportPath}`);
