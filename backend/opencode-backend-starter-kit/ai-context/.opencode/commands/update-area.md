---
description: "Write or update the note of one area of a repo. Usage: /update-area <repo> <area>"
agent: surveyor
---
Update the area note of area $2 in repo $1.

- Note path: context/areas/$1/$2.md
- Facts file: generated/areas/$1/$2.md
- Card: context/cards/$1.md
- Model: the model selected in this session
!`node tools/changed.mjs --area $1 $2`

If the note exists, read it first and change only what the facts or the code show is out of date or missing. Mention in your reply what you changed.
