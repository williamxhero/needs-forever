# Ticket #101: native rebind live acceptance

Date: 2026-11-15 (UTC)

The installed `needs-forever-local@0.3.4` copy was refreshed from commit `0a8d84e73c458d0e077c4e6f2816da45d1aeb4eb`. Installed runtime verification then reported 44/44 files with manifest SHA256 `835a002718741010249582fc727e72ec1c59003c5f4690b2e45faa98cecf300e` and integrity SHA256 `5b98e8b5e73508f4fe83997e95055ac9f43ee51a28d7abe4473b10aa0b46d9bb`.

The live task was `quantresearch-792-supervise-20261113` in `D:\WILL\STOCK\QuantResearch`.

| UTC | Event | Evidence |
| --- | --- | --- |
| 13:10:30.811 | `main_session_rebind_receipt` | native Desktop receipt; A session `01a1d462-de9b-74e1-8429-b81a13c2770a`; generation `b37e630b-d4a6-416a-b62d-da172096caff`; occurrence `4497248a-5efd-42d6-8517-32e122e3dadd` |
| 13:10:33.409 | `main_session_controller_started` | controller started once for the bound original A |
| 13:10:46.270 | `main_tool_result` | same A session and generation; real Desktop tool result |
| 13:15:23.995 | `main_session_rebind_receipt` | post-install native Desktop receipt; generation `26cfc3c9-3203-4023-a070-59c1ae87f15b`; callback bundle integrity matched the installed runtime |
| 13:26:34.750 | `main_session_stop_observed` | native Desktop Stop; same A session and generation; occurrence `87d56deb-707c-4231-a7ec-ad3b8768c3a6` |
| 13:27:46.594 | `supervision_round_delivery_recorded` | delivery `a0a57877-5994-4ce5-8d41-abd895b94838`; same generation and Stop occurrence |
| 13:28:13.603 | `main_session_continuation_confirmed` | real A tool result confirmed the delivery on the original thread |
| 13:28:56.725 | `main_session_stop_observed` | a second native Desktop Stop; same A session and generation; occurrence `e2ab4590-8ef2-43cb-9673-a7a9937a39e8` |

The final state readback retained task version 15, contract SHA256 `df6836df109a70dd4b12b59187108a9b55940ffe8882de39812f764b5f3a2b77`, the same original A session, one running controller, and `BOUND` status. No simulated receipt or second worker was used. The second Stop had already entered a new supervision round when this report was written; its C outcome is not required for this ticket's rebind acceptance.
