---
description: Review uncommitted changes in all repos against their cards and conventions
agent: reviewer
subtask: true
---
Review the uncommitted changes. $ARGUMENTS

Repos with changes:
!`node tools/changed.mjs`
