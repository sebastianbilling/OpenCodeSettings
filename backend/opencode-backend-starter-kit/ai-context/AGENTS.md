# Backend workspace

This folder is the **ai-context** repo. The backend's Git repos are cloned into `repos/` (this repo's Git ignores them). Each of them is its own Git repository. Most have one Gradle build at the top; some have several separate builds in subfolders, and the card says which folder each one is run from. Everything an AI needs to find its way lives here: the map, one card per repo, shared conventions, and a code index.

## Find your way first

Do this before you plan, answer a question about the code, or change anything.

1. `context/REPOS.md` (already in your context) lists every repo: its purpose, "go here for", what it uses and what uses it. Pick the repos the task needs from it.
2. Before working in a repo, read its card: `context/cards/<repo>.md`, unless it is already in your context. The card has the repo's conventions and its exact build and test commands.
3. Find code through the index, not by opening files one by one. It covers all repos and answers in under a second:
   - `node tools/find.mjs <ClassName>`: where a class, interface, enum or record is defined. Partial names and capitals work: `OrdSerImpl`.
   - `node tools/find.mjs users <ClassName>`: every file that uses it, grouped by repo.
   - `node tools/find.mjs subtypes <ClassName>`: what extends or implements it (`--deep` for all levels).
   - `node tools/find.mjs method <name> [ClassName]`: methods by name (`place*` for a prefix).
   - `node tools/find.mjs annotated <Annotation> [text]`: for example endpoints (`annotated Path /orders`), entities, listeners, scheduled jobs. Write the annotation without `@`: in PowerShell `@` means something else.
   - Put options at the end: `--repo <name>` keeps results to one repo, `--tests` includes test code.
4. For text (string literals, SQL, property keys, log messages) use the Grep tool, with `path` set to `repos/<repo>` and `include` set to `*.java` or the file type you need.
5. Read files over about 500 lines in parts, with offset and limit. Never read anything in `build/`, `out/` or `.gradle/` folders.
6. For broad questions such as "where is X handled across the repos?", delegate to the `scout` subagent. It searches in its own context and returns only the locations, which keeps this session small.

The facts behind the cards are in `generated/facts/<repo>.md`. The dependency details, including which version of each internal jar every repo uses, are in `context/DEPENDENCIES.md`. If find.mjs says the index is old, tell me; do not run `tools/refresh.mjs` yourself unless I ask, because it takes minutes.

## Working across repos

- A feature usually touches 2 to 5 repos. Change libraries before the repos that use them.
- Before changing a public class or method in a library repo, run `node tools/find.mjs users <Class>` and list every affected repo in your plan or your reply.
- A repo may build against an older version of a library than the library repo holds now (see "Version differences" in `context/DEPENDENCIES.md`). Check the version before relying on a library change.
- Follow the conventions of the repo you are working in, from its card, even where other repos do it differently. `context/CONVENTIONS.md` holds what all repos share; where they differ, the card wins.
- Team decisions are in `context/decisions/` and listed at the end of `context/REPOS.md`. A decision overrides the cards and CONVENTIONS.md.
- Each repo has its own Git. Use `git -C repos/<repo> ...` or set the workdir. Never commit, push, merge, rebase or switch branches unless I ask.
- Never put AI notes, cards or plans inside a repo in `repos/`. They belong in this folder.

## Environment

- Windows. Shell commands run in PowerShell: use `;` between commands, not `&&`, and PowerShell commands such as `Get-ChildItem` and `Remove-Item`, not bash ones.
- To run something in a repo, set the bash tool's `workdir` to the folder the card names (`repos/<repo>`, or a subfolder when the repo has several builds) instead of using `cd`. Example: command `.\gradlew.bat test`, workdir `repos/order-service`.
- Each repo's Java language level is in its card. Do not use newer Java syntax than that level allows.
- No internet. Do not add new external libraries; the internal mirror only has what the builds already use. Ask me first if you think one is needed.

## How to work

- Small steps. After each step, run the tests of the repo you changed and report the result.
- If the request is unclear, or the code contradicts a card, ask one specific question instead of guessing.
- Plans live in `.opencode/plans/`. When you work from a plan, follow it; if it turns out to be wrong, stop and say so.
- If you notice that a card is wrong or misses something important, say so at the end of your reply, with the fix in one line.
