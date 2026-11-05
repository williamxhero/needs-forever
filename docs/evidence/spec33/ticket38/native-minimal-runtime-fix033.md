# Native minimal completion after the 0.3.3 runtime correction

Date: 2026-11-03. **The minimal original-A acceptance reached actual DONE. Full SPEC #33 is still incomplete.** Times are UTC; Singapore local time is UTC+8. `native-minimal-runtime-fix033.json` retains sanitized event IDs/source lines, package parity, original contract and artifact values, protected-file hashes, selected final state and actual C policy readback. No controller credentials, protected content, raw status or full user configuration is included.

## Reviewed and installed bytes

The applied implementation is `fc19a1658c524aa56c73a29919255c94e902c75e`, integrated by `93a29a0ab41e004446f536f3fbbbeb5d9f3eae67`. This corrects verification's treatment of configured checkpoint writes while retaining UUID-named business files in the digest. The official same-version update receipt is `live-desktop/candidate-runtime-fix033-update.json`; it reports PASS, preserved legacy0.2 bytes and preserved original project files, with trust_written=false.

Reviewed archive `needs-forever-0.3.3-runtime-fix033-uuid.tar.gz` has SHA256 `03c9813a1bd1d355b399bdee11513c9b840903213c7c6cf74a4d0c07ddc99ac0`, independently matched to `runtime-fix033-uuid-package.json`. All **27 installed plugin files** independently match that receipt. The integration plugin source, stable registered marketplace source and installed cache source each match the same 27 reviewed hashes; exact root aliases and each file comparison are retained in the JSON.

The six hook definitions remain byte-identical to original 0.3.3 (`hooks/hooks.json` SHA256 `ba3f4440160c194bc868500f9f5733350a262e644735d089d2d94d5d0542d49c`). Fresh discovery reports all six enabled/trusted with no errors or warnings. This discovery is separate from the native execution evidence below; it does not itself prove execution. No additional trust edits were made.

## Original A and final native sequence

Original A `01a1a0bf-c5d2-74e0-9eae-cf2d38a20cb7` resumed in its original workspace and checkpoint. The final native turn is `01a1a152-95bd-78f3-9fb6-2a63a992449c`, generation `397a18c7-27bc-49fb-ae02-b381e0c7aa43`. Desktop provenance is `codex-cli 0.159.0`; independent C uses CLI `codex-cli 0.166.0`.

| UTC time | Actual event |
| --- | --- |
| 12:12:26.630 | Fresh native receipt binds the original A; event `f143afa4-7af3-489a-a61a-c60f311a668c`. |
| 12:12:27.440 | B automatically starts; event `2c3cc403-b1d4-4b40-babc-4e4d687030ab`. |
| 12:13:29.968 | Actual A Stop `c3612ee7-b4d4-4175-b0a6-0c5648a76f18` is observed. |
| 12:13:30.805 | Fresh independent C `01a1a154-2c7e-7141-bbe5-f295e3fe5ebe` is created. |
| 12:13:47.274 | C is archived. |
| 12:13:47.275 | C decision DONE; event `5e258d75-57d3-427b-bdae-709767b3aa81`. |
| 12:13:47.497 | Fixed independent verification exits 0, passed=true, workspace_changed=false; event `81d257ef-aa1d-4f05-994e-8e4e1e50b43e`. Output: `All three independent stage checks PASS; the failed first route was attempted.` |
| 12:13:47.540 | B records terminal DONE; event `b58b64f3-fd47-4cd9-94ad-d673c4777b82`. |
| 12:13:47.871 | Original A native turn completes normally. |

Selected final checkpoint is DONE/IDLE, binding RELEASED, controller lifecycle exited, and main_session_id remains the original A. This is persisted completion after the independent check, not merely C's completion wording. The earlier real two same-turn continuations are documented in `native033-observation.md`; they ran before this reviewed runtime correction. This final resumed run validates recovery of the preserved contract/artifacts and the corrected terminal gate, rather than presenting the earlier rejected gate as a pass.

## Preserved contract and results

The original task still requires all three stages, the actual failed first route, the different direct-file route, the marker, protected verifier and all original acceptance items/authorization. Validating the original task file with the project's own pure task validator gives the same canonical contract SHA256 as the saved task: `020df9744d85d9781420a82f40e9dd1de254589c59bcc99d51ffc2210313acf1`. The full original task is retained in the sanitized JSON.

- stage1.json: `{"stage":1,"value":"alpha"}`.
- stage2.json: `{"stage":2,"value":"alpha-beta"}`.
- final.json: `{"stage":3,"value":"alpha-beta-gamma"}`.
- route-attempted.txt still exactly matches `required-first-route-failed`; the prior actual exit23 is documented in the first native report.
- verify.mjs remains SHA256 `67e694431651f1d05641c54bb582a52d955c19caee859bcd4af51bf2f4e7f4cb`.
- unavailable-route.mjs remains SHA256 `6913afee30405571d3e098aca045a61b68b7ae0967afd87bbc6ab8eedcf0add8`.

Both protected hashes were independently recomputed after DONE and equal the original baselines. Fixed verification argv remains the original Node executable plus `verify.mjs`.

## C isolation and evidence limits

The successful C's actual rollout readback was captured before report consolidation: read-only sandbox, approval never, managed filesystem root read access, restricted network, one task start/completion and zero function/custom tool calls. Native feedback log row **184855559** independently shows apps/browser_use/computer_use/hooks/plugins=false, multi_agent_mode/v2=false and web_search flags=false. A's actual final-turn policy remains gpt-6.1-sol/xhigh, approval never and danger-full-access in the original workspace.

During a subsequent exact-path source recheck, the C's archived rollout was no longer present and no matching active-session file was found. The successful first read's selected policy, source SHA256 and read timestamp remain retained; the JSON explicitly records this later source unavailability. This observer did not move, remove, unarchive or modify that source. Do not describe the raw rollout as still available for replay without rechecking.

Minimal T07 is now passed. **Actual T04, T06, T08, T09, T15 and T18 still require their remaining branches.** In particular, the earlier exit0/workspace-change rejection is not a genuine nonzero-verifier test, and the earlier pause happened after the previous C direction returned, so it is not a JUDGE-race pass. Existing T20 evidence still does not contain a complete dynamic A tool inventory. No main merge, push or Issue closure is implied by this minimal acceptance report.
