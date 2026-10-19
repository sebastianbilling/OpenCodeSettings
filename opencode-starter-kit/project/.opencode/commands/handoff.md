---
description: Write a status note so a fresh session can continue the work
agent: build
---
Write .opencode/handoff.md (replace it if it exists) so that a new session with no memory of this one can continue. Include:

- Task: what we are doing and why. Name the plan file if there is one.
- Done: what is finished and committed.
- Current state: work in progress, uncommitted changes, failing tests.
- Next: the exact next step.
- Learned: decisions and pitfalls from this session that are not written down anywhere else.

At most 300 words. Then tell me to start a new session and type: Read .opencode/handoff.md and continue.
