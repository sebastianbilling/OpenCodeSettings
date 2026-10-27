# <repo name>

## Map entry
- Kind: <library | application | batch job | test support | tool | other: ...>
- Purpose: <one sentence: what the repo does for the business, not how it does it>
- Go here for: <5 to 10 comma-separated topics in the words a developer would use, e.g. "placing orders, order status, cancelling orders, order numbers">
- Key packages: <2 to 5 packages that hold most of the logic>

## What it does
<3 to 6 sentences: the business purpose, the main flows, who or what calls it (other repos, users, schedules, queues), and what it calls. Only what the code shows.>

## Where things live
| Package or folder | What is there |
| --- | --- |
| <package> | <one line> |

## Conventions in this repo
Follow these when changing code here, even where other repos do it differently.
- Naming: <e.g. interfaces OrderService, implementations OrderServiceImpl, data access classes end in Dao>
- Layers: <e.g. resource -> service -> dao; which may call which>
- Errors: <e.g. throw subclasses of AcmeException; never catch Exception>
- Logging: <e.g. private static final Logger LOG = LoggerFactory.getLogger(X.class)>
- Tests: <framework, class and method naming, where tests live, what gets mocked>
- Java level: <e.g. 11: no records, no switch expressions>
- Other: <anything a newcomer would get wrong>

## Build and test
Run in repos\<repo name> (PowerShell). From OpenCode: bash tool with workdir repos/<repo name>.
| Task | Command |
| --- | --- |
| Build | `.\gradlew.bat build` |
| All tests | `.\gradlew.bat test` |
| One test class | `.\gradlew.bat test --tests "<package.ClassName>"` |

## Depends on and used by
- Uses: <repos, and what this repo uses them for>
- Used by: <repos, and what they use from this one>

## Watch out
- <generated code, legacy parts not to touch, very large files, surprising behaviour>

## Card info
- Written by: <agent and model>, <date>
- From commit: <short commit id>
- Reviewed by: not yet
