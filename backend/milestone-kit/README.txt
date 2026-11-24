Milestone kit - split big plans into milestones
================================================

See Step 8b in "OpenCode architecture workflow: implementation guide".

Copy the CONTENTS of this folder into your project folder <PROJECT>\ :

    .opencode\agents\milestones.md     the agent that splits a plan
    .opencode\commands\split-plan.md   /split-plan <plan-name> [extra wishes]
    .opencode\commands\milestone.md    /milestone <plan-name> <number>
    tools\check-milestones.mjs         check: no plan step lost, each milestone fits

Then restart OpenCode. "milestones" should appear in `opencode agent list`.

If your model server's real context window is not 262144 tokens, change
DEFAULT_CONTEXT at the top of tools\check-milestones.mjs.

Day to day:
    1. /plan-feature <description>           (planner writes the big plan)
    2. new session: /split-plan <plan-name>  (writes .opencode\plans\<plan-name>\)
    3. new session per milestone: /milestone <plan-name> 1, /arch-review, commit
       then a new session for /milestone <plan-name> 2, and so on.

Tested against OpenCode 1.4.3 and 1.18.19 (2026-11-24).
