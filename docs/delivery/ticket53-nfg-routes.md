# Ticket #53: NFG route audit

Parent: [SPEC #49](https://github.com/williamxhero/needs-forever/issues/49).
Branch: `codex/spec49-ticket53`, based on integration `096ff8c`.

NFG keeps the existing WORKER 发出 / SUPERVISOR 判断 / WORKER 收到 round
format and Chinese title/status text. Beneath the supervisor judgment, one
collapsed route line shows the selected route ID, operation title and diagnosis.
The existing click-to-expand control reveals diagnosis evidence, selection and
single-route rationale, all candidates, their status, resource, hypothesis,
actions, expected evidence/signal, evidence references, risk, fallback,
discriminating check and the plan's success/stop conditions. It does not add
candidate routes to the worker's received prompt.

## Read-only HTTP projection

`TaskRecord.rounds[].routeAudit` is a display projection of the round's latest
decision, independent of later delivery or verification events. Its `kind` is
`c2` or `legacy`; terminal decisions have no route audit. C2 fields are read
from the persisted diagnosis and route plan. Unknown status values are displayed
as unknown. Observed means 已观测; candidate means 候选（未验证）. No state is
described as an available provider by the UI.

A historical CONTINUE without a route plan receives a virtual single-route
display: `legacy-next-message`, status `unknown`, with its original continuation
text. Missing historical conditions are explicitly marked 旧版未记录. The
projection does not insert a plan into the decision or change saved events,
Task, catalog or ledger. It grants no execution authority and makes no provider
capability claim.

## Browser behavior

Route details use the same folded one-line control as judgment, Stop reason and
worker prompt. `aria-expanded` follows the visual state. Expansion keys include
task ID and the stable round ID; route keys additionally include plan ID. Timer
refreshes preserve expansion after preceding rounds are inserted and isolate
different Stops even when a plan ID is reused. A replacement plan starts folded.
The existing copy-ID, auto-refresh, pause/resume and delete controls remain.

Every model-originated value is escaped before insertion into markup, including
route IDs, plan IDs in attributes, diagnosis, resource names, hypotheses, actions,
evidence references, fallback and conditions. No model string is interpolated
into the served JavaScript source.

## Verification

The approved seams are NFG HTTP/API and rendered client behavior. New tests
execute the complete served inline script in a Node VM with a small DOM adapter;
they use the real loopback server and its fixture files, invoke wired buttons and
the actual timer callback, then inspect rendered output and expansion state.
They do not assert implementation source or invoke rendering helpers directly.

Red stages observed a missing HTTP route projection, missing rendered route
control and missing legacy projection. Green coverage includes full audit fields,
the three core lines, candidate status honesty, copied ID/current title/status,
legacy readability and unchanged historical event bytes, timer refresh after
round insertion, replacement-plan isolation, disabled auto refresh, hostile text
and attribute keys, and retained expansion with hostile plan IDs.

- `npm run plugin:build`: passed; 32 standalone runtime modules generated.
- `node --test dist/test/web.test.js`: 16 passed.
- `git diff --check`: passed.

These tests verify script syntax, real HTTP data and client wiring. The SPEC
integration owner performs the final full suite, independent review, actual
browser layout inspection and installed-runtime/deployment acceptance.
