---
description: Something seems broken or lost? Let the AI check and repair
agent: designer
---
Something seems wrong. What I noticed (may be empty): $ARGUMENTS

1. Run node .designer/versions.mjs doctor and node .designer/app.mjs status.
2. If the app shows an error, an empty window, or no window at all, read node .designer/app.mjs log --errors and fix what you can. If the errors are not from a design change (for example right after getting the team's latest code), run node .designer/app.mjs restart --full.
3. If I lost something, follow "Something is wrong or something is lost" in your instructions.
Tell me in plain words what you found and what you fixed.
