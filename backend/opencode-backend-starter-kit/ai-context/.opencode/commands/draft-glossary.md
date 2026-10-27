---
description: Draft context/GLOSSARY.md, the business terms used in the code (review the result)
agent: cartographer
---
Draft context/GLOSSARY.md: the business terms a developer meets in this code base.

1. Read generated/overview.md. Its "Main classes" lines list the most used classes of every repo, with their Javadoc summary. Also read the "What it does" sections of the cards in context/cards/ (use grep on that folder).
2. Keep business words only (Order, Invoice, Policy, Claim), not technical ones (Service, Dao, Util, Config).
3. When a term is unclear, look at its main class briefly: node tools/find.mjs <Name>, then read the class's Javadoc and first lines.
4. One table row per term: | Term | Meaning (one line) | Name in code | Main repo |. If the business word and the class name differ (for example a Swedish word and an English class name), put both.
5. At most about 80 terms, sorted alphabetically. Leave out terms you could not work out.
6. Write the file with the write tool, then reply with the terms you were least sure about.
