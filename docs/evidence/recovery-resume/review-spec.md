# Spec review

Independent agent `recovery_resume_spec`, fixed point `1ac7980ab193970f56d2f7a659df26a9f866ffd5`, reviewed the recovery diff against the user's failed-resume and bounded-recovery requirements on 2026-11-10.

Initial P2: preserve the tool event that establishes recovery. A genuine rebound PreToolUse was accepted for binding but its matching PostToolUse lacked a recorded start, dropping the real result from C's evidence. The test originally asserted only BOUND/WORKER.

Final review: **P2 resolved.** The genuine rebound PreToolUse is recorded before saving; controller startup preserves it, so its matching PostToolUse produces actual evidence. PostToolUse-only recovery creates no synthetic start. The test checks exactly one matching result and its actual response, plus absence of a fabricated Post-only start. Shared isNativeRebindEvent keeps adapter/core eligibility consistent. No new actionable findings. The reviewer did not run tests; root's retained red/green outputs cover the public installed path.

Compatibility limit: the standalone recovery RPC does not forward Desktop dynamic tools or interactive approval/input requests. The delivery note explicitly records this limit and does not claim all Desktop tools are supported. This actual recovery bound the original already-active Desktop worker; the helper did not take its writer.

The daemon dispatch, original-A/generation correlation, native first-Stop delivery and bounded interruption paths otherwise match the supplied requirements. Current live evidence proves native rebinding and B startup. A fresh native Stop→C→continuation is a separately reported observation limit, not inferred from the fixture.
