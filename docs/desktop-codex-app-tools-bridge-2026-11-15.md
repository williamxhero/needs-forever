# Current Desktop recovery route

## Finding

The current Codex CLI is `codex-cli 0.159.0`. Its standalone `app-server` exposes stdio and optional socket transports, but the Desktop-owned app-server is launched as a stdio child of `ChatGPT.exe`; it does not expose a usable TCP listener. The local daemon control socket is stale and refuses connections, so it is not the Desktop thread binding.

The Desktop does expose an authenticated native pipe for its `codex_app` tool host. A live pipe answered `tools/list` with the native app tools, including `read_thread`, `wait_threads`, and `send_message_to_thread`. A direct framed JSON-RPC read returned the target thread `01a1d462-de9b-74e1-8429-b81a13c2770a`, host `local`, and workspace `D:\WILL\STOCK\QuantResearch`.

This gives B a viable host bridge to the original A thread without starting another app-server or guessing a recent thread.

## Implementation

`src/codex-app-control-transport.ts` implements the current Desktop route:

- connects to the existing Windows named pipe with the same 4-byte little-endian framing used by the installed `codex-app-tools` host;
- discovers a live `codex-browser-use-*` pipe by requiring both `read_thread` and `send_message_to_thread` in `tools/list`;
- maps the provider contract to the current host tools;
- reconnects and re-discovers the pipe once after a disconnect;
- reads the original thread and history through `read_thread`;
- derives writer state from the host's current thread status;
- maps recovery send to `send_message_to_thread` on the supplied thread id and host id;
- reconciles a delivery against exact message text before sending, so an inconclusive result remains a no-resend fence.

The transport is exported from `src/index.ts` and is accepted by the existing `DesktopMainSessionProvider`. The provider now also respects the transport's declared provider kind, so this route reports `ui-bridge` rather than pretending to be a shared app-server.

`deliverMainSessionRecoveryPrompt` now tries this bridge first for a live
`native-desktop` checkpoint. If the bridge proves the same thread, B reads the
writer state, reconciles the existing delivery, and sends the recovery prompt
through `send_message_to_thread` only when history proves the exact message is
absent. If the bridge cannot be discovered or cannot prove the target thread,
the old native-receipt wait remains the fail-closed fallback.

## Evidence

The live read-only probe passed with:

```json
{"provider_kind":"ui-bridge","evidence_level":"live","available":true,"attached":true,"same_thread_verified":true,"target_thread_id":"01a1d462-de9b-74e1-8429-b81a13c2770a","snapshot":{"thread_id":"01a1d462-de9b-74e1-8429-b81a13c2770a","status":"idle","writer":"idle"},"history":{"readable":true,"has_more":true}}
```

`npm test` passed 282 tests, including the existing provider and recovery suites. No user-visible message was sent during this investigation.

## Remaining acceptance boundary

The native host bridge has read and write capabilities, but a write creates a visible follow-up message in the original thread. Full production acceptance still needs one authorized end-to-end recovery run that sends a real continuation, then reads the same thread to confirm the new A activity. The implementation keeps that step explicit and does not silently send a probe message.

