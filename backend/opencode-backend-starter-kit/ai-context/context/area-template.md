# <repo> / <area>

## Read when
- <5 to 10 topics in the words a developer would use, on one line, e.g. "cancelling orders, refunds, order status changes, the nightly order clean-up">

## What this area does
<3 to 6 sentences: the business purpose, who or what starts the work (users, other repos, queues, schedules), and what comes out (data saved, messages sent, answers returned). Only what the code shows.>

## Main flows
### <Flow name, e.g. "Cancel an order">
1. Starts at: <entry point, e.g. POST /orders/{id}/cancel -> OrderResource.cancel, or queue ORDERS.IN -> OrderListener.onMessage>
2. <Class.method>: <what happens here>
3. <Class.method>: <what happens; which rule is checked; what can go wrong>
4. Ends in: <table written, message sent, file produced, answer returned>

<2 to 6 flows, the most important first. Every step names a real class and method.>

## Business concepts and rules
- <Concept>: <what it means in this code>. States: <NEW -> PAID -> SHIPPED> (enum <Name>, changed in <Class.method>).
- Rule: <the rule in plain words> (checked in <Class.method>; error: <Exception "message">).

## Data
| Table or entity | Class | What it holds | Written by | Read by |
| --- | --- | --- | --- | --- |
| <ORDERS> | <Order> | <one line> | <Class.method> | <Class.method> |

## Integrations
| Kind | Name (queue, topic, URL, system) | In or out | Class | Config key |
| --- | --- | --- | --- | --- |
| <JMS> | <ORDERS.OUT> | <out> | <OrderPublisher> | <order.queue.name> |

## Configuration
| Key | What it controls | Read in |
| --- | --- | --- |
| <order.cancel.max-days> | <one line> | <Class> |

## Watch out
- <surprising behaviour, duplicated logic, legacy paths, code that looks unused but is called by name or by another repo>

## Note info
- Written by: <agent and model>, <date>
- From commit: <short commit id>
- Reviewed by: not yet
