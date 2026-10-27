---
description: Draft context/CONVENTIONS.md from all cards (review the result line by line)
agent: cartographer
---
Draft context/CONVENTIONS.md: the conventions that hold across the repos.

1. Read generated/overview.md. It has the counted naming, logging, exception and test patterns of every repo, a few lines each.
2. Read the "Conventions in this repo" section of the cards in context/cards/ (use grep on that folder rather than reading every whole card). The repo names are in context/REPOS.md.
3. Write only what most repos share, and say how many repos follow it, for example "Logger field named LOG (31 of 45 repos)". Where repos split into groups, describe the groups, and name the style new code should use only if the cards say which one is newer. Otherwise put it under "Open questions".
4. Sections: Naming, Packages and layers, Errors, Logging, Tests, Java level, Build, Commit messages, Open questions.
5. At most 3 pages. Every session reads this file, so every line must be worth it.
6. Write the file with the write tool. Then reply with the five rules you are least sure about.
