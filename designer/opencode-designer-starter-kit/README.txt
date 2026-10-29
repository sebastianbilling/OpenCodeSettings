OpenCode designer starter kit
=============================

Lets a UI/UX designer who does not code try design concepts in the real app with
OpenCode Desktop: the AI changes the code, and the designer saves, opens and
compares versions in plain words. Nothing is ever pushed. Follow the guide
"OpenCode for the designer: implementation guide" step by step.

What is in here
---------------
setup.mjs                  One-time setup of the designer's PC. Run it logged in as the designer:
                             node setup.mjs <project folder> --name "First Last" --email name@company
                           Check later without changing anything:
                             node setup.mjs <project folder> --check

designer-folder\           Copied by setup.mjs into <project>\.designer\ (hidden from Git on that PC only)
  versions.mjs             Ideas, versions, the team's code, backups, repairs (the AI runs it)
  app.mjs                  Start, stop and watch the app (the AI runs it; "Start app.cmd" uses it)
  Start app.cmd            What the designer double-clicks; setup puts a shortcut on the desktop
  settings.json            YOUR SETTINGS: dev command, app address, branch, helper name

personal\                  Copied by setup.mjs into C:\Users\<designer>\.config\opencode\
  opencode.jsonc           Personal OpenCode config for the designer (replace the <...> placeholders)
  agents\designer.md       The designer's AI partner: how it talks, what it may do
  commands\*.md            /save-version /versions /open-version /new-idea /get-latest /update-idea
                           /discard-changes /where-am-i /team-code /start-app /fix-problems /help-me

cheat-sheet\               Two printable pages for the designer (HTML and PDF)

Requirements on the designer's PC: Git for Windows, Node.js 18 or newer, OpenCode Desktop,
ripgrep (rg.exe) on the PATH, a clone of the project, and npm access to your internal mirror.

Tested 2026-10-29: versions.mjs, app.mjs and setup.mjs with Node.js 22 and Git 2.43 against a
simulated Git server, developer and designer (84 checks); the agent, the commands and the
permission rules with OpenCode 1.4.3 and 1.18.19 and a stand-in model server. An independent
code review found 11 problems; all were fixed and retested.
