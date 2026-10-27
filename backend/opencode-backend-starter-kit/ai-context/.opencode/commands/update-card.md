---
description: "Update one repo's card after it changed. Usage: /update-card <repo>"
agent: cartographer
---
Update the card of repo $1.

- Card path: context/cards/$1.md
- Facts file: generated/facts/$1.md
- Model: the model selected in this session
!`node tools/changed.mjs --card $1`

Read the existing card first and change only what the facts or the code show is out of date. Mention in your reply what you changed.
