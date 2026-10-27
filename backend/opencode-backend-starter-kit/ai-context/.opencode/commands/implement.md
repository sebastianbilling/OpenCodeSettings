---
description: "Build one step of a plan, then run that repo's tests. Usage: /implement <plan-name> <step>"
agent: build
---
Implement step $2 of the plan in .opencode/plans/$1.md

1. Read the plan file, and the card (context/cards/<repo>.md) of the repo this step works in.
2. Do only this step, and only in the repo it names. If the plan turns out to be wrong or incomplete, stop and tell me instead of improvising.
3. Follow the conventions in the card. Do not use newer Java syntax than the repo's Java level.
4. Run the repo's tests with the command from its card (bash tool, workdir repos/<repo>). Fix failures your change caused.
5. Finish with: the files you changed per repo, the test result, anything I should check by hand, and whether the plan needs updating.
