---
description: "Build one step of a plan, then run the tests. Usage: /implement <plan-name> <step>"
agent: build
---
Implement step $2 of the plan in .opencode/plans/$1.md

1. Read the plan file and the architecture chapters it lists before writing code.
2. Do only this step. If the plan turns out to be wrong or incomplete, stop and tell me instead of improvising.
3. Run the tests (see Commands in AGENTS.md) and fix failures caused by your change.
4. Finish with: the files you changed, the test result, anything I should check by hand, and whether the plan needs updating.
