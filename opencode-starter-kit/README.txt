OpenCode architecture workflow - starter kit
============================================

Follow the guide "OpenCode architecture workflow: implementation guide".
This kit holds every file from it, so you can copy instead of typing.

personal-config\opencode.jsonc
    -> C:\Users\<you>\.config\opencode\opencode.jsonc      (guide step 0.3)

project\  -> copy the CONTENTS into your project folder <PROJECT>\
    AGENTS.md                         step 6 (template: fill in the <...> parts)
    opencode.jsonc                    step 5
    .ignore                           step 1
    gitignore-lines.txt               add these lines to <PROJECT>\.gitignore, then delete this file
    tools\verify-conversion.mjs       step 1
    tools\split-architecture.mjs      step 2
    docs\architecture\ESSENTIALS.md   step 4 (skeleton)
    docs\architecture\GLOSSARY.md     step 4 (skeleton)
    docs\architecture-source\         put architecture.html and architecture.md here (step 1)
    docs\decisions\0000-template.md   step 9
    .opencode\agents\                 step 7: architect.md, reviewer.md, planner.md
    .opencode\commands\               step 8: arch, plan-feature, implement, arch-review, handoff
    .opencode\plans\                  plans are written here

Replace these placeholders everywhere:
    <LLM_URL>     your model server address ending in /v1
    <GLM_ID>      GLM model name as the server reports it
    <MINIMAX_ID>  MiniMax model name as the server reports it

Files starting with a dot (.ignore, .opencode) are hidden in some Windows
Explorer views. Turn on "Hidden items" under View if you do not see them.

Tested against OpenCode 1.4.3 and 1.18.19 (2026-10-16).
