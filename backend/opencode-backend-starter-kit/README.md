# Starter kit: OpenCode for the Java backend

Everything here goes with the guide "OpenCode for the Java backend: implementation guide". Follow the guide; this file only says what is where.

```
ai-context\                     becomes your new Git repo; start OpenCode in this folder
  AGENTS.md                     standing orders, loaded in every session
  opencode.jsonc                project settings: always-loaded files, permissions
  .gitignore  .ignore           Git ignores repos\ and generated\; the AI's search still sees repos\
  repos.json                    the list of repos to clone (fill in your own)
  repos\                        the backend repos go here (created by tools\clone-all.mjs)
  context\
    REPOS.md                    the map of all repos (generated, always loaded)
    DEPENDENCIES.md             which repo uses which repo's jars (generated)
    CONVENTIONS.md              shared conventions (drafted by AI, reviewed by you, always loaded)
    GLOSSARY.md                 business terms (drafted by AI, reviewed by you, always loaded)
    card-template.md            the shape of every repo card
    cards\                      one card per repo (written by the cartographer agent)
    decisions\                  team decisions that override cards
  .opencode\
    agents\                     cartographer, scout, planner, reviewer
    commands\                   /find /plan-feature /implement /check-changes /handoff /update-card /draft-conventions /draft-glossary
    plans\                      plans written by /plan-feature
  tools\
    refresh.mjs                 rebuilds index, dependencies, facts and map (no AI)
    find.mjs                    the AI's search: classes, users, subtypes, methods, annotations
    map-all.mjs                 runs the cartographer over many repos (and model bake-offs)
    clone-all.mjs               clones and updates the repos from repos.json
    changed.mjs                 lists uncommitted changes in all repos
    sync-cards.mjs              optional: private copies of the cards inside the repos
    JavaIndexer.java            reads all Java code with the JDK's own parser
    ai-deps.gradle              asks Gradle what each repo builds and depends on
    lib\                        shared code for the scripts
personal\
  opencode.jsonc                your personal config with all five models
                                (goes to C:\Users\<you>\.config\opencode\)
```

Requirements: Git, Node.js 22 or newer, a JDK 17 or newer (21 is fine), OpenCode 1.4.3 CLI or Desktop 1.18.19. Nothing to install from the internet.
