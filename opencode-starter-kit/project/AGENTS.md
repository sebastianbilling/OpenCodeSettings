# <Project name>

<One paragraph: what the system does, who uses it, and its current state (for example: "a monolith that will later be split into packages").>

## Architecture first

The architecture lives in `docs/architecture/`. Three of its files are already in your context:
`ESSENTIALS.md` (rules for every task), `GLOSSARY.md` (terms) and `INDEX.md` (map of the chapters).

Before you plan, design or change code:

1. Find the task in `INDEX.md` and read every chapter whose "Read when" matches. Read the chapter files themselves; the index is only a summary.
2. When you rely on the architecture, name the file, for example "per 03-01-autentisering.md".
3. If the request or the existing code conflicts with the architecture, stop and ask. Do not choose a side yourself.
4. If the architecture does not cover something, say so and propose an option. Never invent architecture.
5. Later decisions are in `docs/decisions/`. A decision overrides the chapter it names.

For architecture questions you can delegate to the `architect` subagent. It reads the chapters in its own context and returns a short answer with sources.

## How to work

- Make small changes, one step at a time. Run the tests after each step.
- Change only files the task needs. Do not reformat code you are not changing.
- Do not add dependencies without asking. This machine has no internet, so packages cannot be downloaded.
- Use the terms from `GLOSSARY.md`, with their "Name in code".
- If the request is unclear, ask one specific question instead of guessing.
- Plans live in `.opencode/plans/`. When working from a plan, follow it; if it turns out to be wrong, stop and say so.

## Environment

- Windows. Shell commands run in PowerShell. Use PowerShell syntax: `;` between commands, `Get-ChildItem`, `Remove-Item`. Not bash.
- No internet access. Web fetch and web search are disabled.

## Commands

All tried on this machine. Use exactly these.

| Task | Command |
| --- | --- |
| Install dependencies | `<npm ci>` |
| Build | `<npm run build>` |
| Run all tests | `<npm test>` |
| Run one test file | `<npx vitest run path/to/file.test.ts>` |
| Type check | `<npx tsc --noEmit>` |
| Lint | `<npm run lint>` |
| Start locally | `<npm run dev>` |

## Project structure

- `src/`: <what lives here>
- `tests/`: <what lives here>
- `docs/architecture/`: architecture chapters, INDEX, ESSENTIALS, GLOSSARY
- `docs/decisions/`: decisions made after the architecture document
- `tools/`: helper scripts

## Code conventions

- <Language and version, e.g. TypeScript 5, Node 22, strict mode>
- <Formatting and lint rules, e.g. Prettier defaults, no default exports>
- <Error handling and logging rules>
- <Tests: where they live, naming, what must be tested>

## Definition of done

- Tests pass, and new behaviour has tests.
- No rule in `ESSENTIALS.md` is broken.
- If you made a choice the architecture does not cover, list it at the end of your reply so a decision note can be written.
