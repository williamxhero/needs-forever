# Standards review

Independent agent `recovery_resume_standards`, fixed point `1ac7980ab193970f56d2f7a659df26a9f866ffd5`, reviewed the uncommitted recovery diff on 2026-11-10.

Hard documented-standard violations: none found. Reviewed AGENTS.md, domain guidance, README.md, and main-session architecture; no GLOSSARY.md, ADR, CONTRIBUTING.md, or CODING_STANDARDS.md exists.

Optional heuristic: Possible Duplicated Code — the adapter and core independently repeated the eligible native-rebind event list. This could drift and strand recovery. Final repair exports `isNativeRebindEvent` and imports it in the adapter, removing the duplicate list.

No confirmed introduced lease, redaction, host-isolation, or false-readiness violation. Event errors pass through Store.event redaction; recovery prompt acknowledgement remains distinct from native binding and controller readiness.

Result: **0 hard violations; 1 optional smell, subsequently addressed.** Generated runtime parity is checked separately by the build and package hash receipt.
