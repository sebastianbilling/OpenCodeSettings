---
description: "Build one milestone of a split plan, then run the tests. Usage: /milestone <plan-name> <number>"
agent: build
---
Build milestone M$2 of the plan "$1".

1. Read .opencode/plans/$1/00-overview.md. Then read exactly the milestone file named on the M$2 line under "Order and status". Do not open the full plan .opencode/plans/$1.md or any other milestone file.
2. Check that every earlier milestone is ticked as done in the overview. If one is not, stop and tell me.
3. If the milestone's "Open questions" is not "None", ask me and wait. Write my answers under "Notes for later milestones" in the overview.
4. Read the architecture chapters the milestone lists. If it names sections, you may read only those: use grep to find where a section starts, then read from there. If a read result says to continue with offset, keep reading until you have what you need. Then read the code you need.
5. Do the steps in order. If the milestone turns out to be wrong or incomplete, stop and tell me instead of improvising.
6. Run the tests (see Commands in AGENTS.md) and fix failures caused by your change.
7. Only if you ran the tests in this session and they passed: use the edit tool to change "- [ ]" to "- [x]" on the M$2 line of 00-overview.md only. Do not rewrite the file. Then add 2-5 lines under "Notes for later milestones": what you built, the exact names of new files, classes and endpoints, and anything that differs from the plan.
8. Finish with: the files you changed, the test result, and anything I should check by hand.
