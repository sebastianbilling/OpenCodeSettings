# Architecture essentials

Rules that apply to every task. Each rule names the chapter with the details.
The chapter files are the source of truth: if this file and a chapter disagree,
follow the chapter and tell the user about the conflict.

## What the system is

<2-4 sentences: purpose, users, main capabilities>

## Main parts and how they talk to each other

- <Part>: <responsibility>. Talks to <part> via <REST / events / shared DB / ...>. (see 0X-....md)

## Non-negotiable rules

1. <Rule as an instruction, e.g. "All database access goes through the repository layer."> (see 0X-....md)

## Technology choices

| Area | Use | Do not use |
| --- | --- | --- |
| <e.g. Logging> | <library> | <alternatives that are not allowed> |

## Naming and structure

- <folder layout and naming conventions the architecture prescribes> (see 0X-....md)

## Never

- <things that are forbidden, e.g. "Never call another module's database directly.">

## Open questions

- <anything unclear or contradictory in the architecture>
