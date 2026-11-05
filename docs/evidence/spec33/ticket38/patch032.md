# Candidate patch 0.3.2: explicit human opt-in

The skill description and first execution gate now permit start/resume (including internal prepare) only when the user explicitly invokes this skill to execute a task or explicitly asks to enable/resume Needs Forever supervision. Installation/trust, an ordinary long task or automatic-progress request, mentioning/reading the plugin, and status queries do not grant activation. Explicit query/pause requests perform only that management action. The canonical SPEC records this human policy.

A checks the human authorization before running the control command. The native hook still proves only the actual control invocation and native receipt association with A; it cannot verify that a user invoked a skill in the UI. No runtime or hook claims otherwise.

Parent confirmed independent Standards and Spec reviews of the instruction-only diff both passed with zero findings before packaging. This patch then updates core/lockfile/plugin/hidden-manifest metadata to 0.3.2 and the current README candidate version. All prior candidate archives and evidence are preserved.

`npm run plugin:build` passed (17 modules). `patch032-packaging-checks.txt` records **2/2 passing** executable-core/version contract and isolated installed-package discovery checks. Discovery uses the replacement install host and does not establish native Desktop effectiveness. Runtime regression was not repeated because every executable runtime, script and hook byte matches the already-reviewed 0.3.1 candidate.

`patch032-package.json` records archive path, SHA256, the 28 installed-package file hashes and successful extraction/source parity. SHA256: `ff330da0b14972a1fcfad3ce5a70983f3864658003774118c73e80ff9358f5d0`. Complete comparison against `patch031-package.json` confirms only plugin package metadata, hidden manifest metadata, and `skills/supervise/SKILL.md` changed in the archive; executable runtime/scripts/hooks and other resources are byte-identical.

No global installation, trust change, chat/model creation or actual Desktop acceptance occurred in this patch. Parent owns activation and the required native acceptance.
