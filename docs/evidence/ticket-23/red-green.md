# Observed red/green journal for #23

Each numbered cycle used the actual command `npm test` from this worktree. It compiles with `tsc`, then Node's test runner spawns the real CLI as a separate process connected to a separate JSONL fixture process. Only one new behavior was introduced per cycle. The excerpts below were copied from observed tool output; they are not claimed to be complete raw logs.

| Cycle | New public behavior | Actual RED | Next GREEN |
| --- | --- | --- | --- |
| 1 | Initial start/status and fixed external wait | 0 pass / 1 fail; `Cannot find module ... dist\\src\\cli.js`, `MODULE_NOT_FOUND`; exit 1 | 1 pass / 0 fail; exit 0 |
| 2 | Reject expanded returned writable roots | 1 pass / 1 fail; `An expanded writable root must fail startup.`, `0 !== 1`; unsafe server was incorrectly accepted | 2 pass / 0 fail; exit 0 |
| 3 | Task exclusivity independent of state filename | 2 pass / 1 fail; second CLI entered active worker and timed out; `null !== 1` after 15 seconds | 3 pass / 0 fail; exit 0 |
| 4 | Credential redaction before saved judge evidence | 3 pass / 1 fail; `Saved judge input must not contain an API token.` | 4 pass / 0 fail; exit 0 |
| 5 | Exact inherited MCP names safely disabled | Actual no-model preflight first failed with `invalid transport in mcp_servers."mempalace"`; then CLI regression produced 4 pass / 1 fail, `app-server exited (1)` | 5 pass / 0 fail; exit 0; actual no-model preflight then succeeded with 4 disabled inherited servers |
| 6 | Foreground worker output | 5 pass / 1 fail; output contained only `SIMULATED` and `WAIT_EXTERNAL`, not `Worker produced the first stage artifact` | 6 pass / 0 fail; exit 0 |
| 7 | External turn ID cannot escape snapshot directory | 6 pass / 1 fail; malicious turn `../escaped` created `escaped.json` outside snapshots; `true !== false` | 7 pass / 0 fail; exit 0 |
| 8 | Atomic state replacement survives a brief Windows sharing conflict | Final verification intermittently failed 6 pass / 1 fail on `EPERM` renaming the new checkpoint over `state.json`; full observed output is in `windows-rename-red.txt` | Retry the same atomic rename for a bounded 1-second local sharing-conflict window; 7 pass / 0 fail |

Cycle 1 introduced the six responsibility boundaries needed for the first vertical slice. Subsequent fixes implemented policy return checks, a canonical-task lock, evidence redaction, the actual CLI-compatible TOML override, foreground output, and locally generated snapshot UUIDs respectively. Additional handshake order/ID assertions extended the already green initial behavior.

The original generated `runs/ticket23/*` directories were retained for inspection. `sample/` preserves one successful public demo invocation, while `green.txt` is the final test command output saved after all fixes, with carriage returns normalized to LF. The sharing-conflict failure was observed on the same CLI test seam; it was intermittent, so the subsequent green run does not prove resilience to indefinite or permanent filesystem denial. Failed replacement never unlinks the existing state.
