---
description: "Build one milestone of a split plan, or one plan step of it. Usage: /milestone <plan-name> <milestone> [plan-step]"
agent: build
---
Plan: "$1". Milestone: M$2. Plan step: "$3" (empty means all steps of the milestone).

Build only that milestone, and only that plan step if one is given. Do not put other milestones or steps on your todo list.

1. Read .opencode/plans/$1/00-overview.md. Then read exactly the milestone file named on the M$2 line under "Order and status". Do not open the full plan .opencode/plans/$1.md or any other milestone file.
2. Check that every earlier milestone is ticked as done in the overview. If one is not, stop and tell me.
3. If the milestone's "Open questions" is not "None", ask me and wait. Write my answers under "Notes for later milestones" in the overview.
4. Read the architecture chapters the milestone lists. If it names sections, you may read only those: use grep to find where a section starts, then read from there. If a read result says to continue with offset, keep reading until you have what you need. Then read the code you need.
5. If a plan step is given, do only the "### Plan step $3" section of the milestone file; if the milestone has no such step, stop and tell me. Otherwise do all its steps in order. If the work turns out to be wrong or incomplete, stop and tell me instead of improvising.
6. Run the tests (see Commands in AGENTS.md) and fix failures caused by your change.
7. If you built a single plan step, add one line under "Notes for later milestones": "M$2, plan step $3 done:" followed by what you built and the exact names of new files, classes and endpoints.
8. Tick the milestone only when all its plan steps are done and every "Done when" item is met, and only if you ran the tests in this session and they passed: use the edit tool to change "- [ ]" to "- [x]" on the M$2 line of 00-overview.md only. Do not rewrite the file. Then add 2-5 lines under "Notes for later milestones": what the milestone built, and anything that differs from the plan.
9. Then stop. Do not start another step or milestone, even if you have room left. If the conversation was summarized and you are unsure where you are, re-read 00-overview.md: if the M$2 line is ticked, or this step is noted as done, you are done.
10. Finish with: the files you changed, the test result, the next step or milestone to build, and anything I should check by hand.