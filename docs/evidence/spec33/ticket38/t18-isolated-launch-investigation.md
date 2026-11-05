# T18 alternate Desktop profile investigation

Date: 2026-11-03. Investigation only. The diagnostic script was dry-run without
`--launch`; this agent did not launch or terminate Desktop, change configuration,
copy authentication, copy hook trust, or touch the legacy 0.2 tasks.

## Next diagnostic launch

Proposed script: `t18-diagnostic-launch.py` beside this report.

```powershell
python '.scratch/main-session-supervision/t18-diagnostic-launch.py' --launch
```

Executable:
`C:\Program Files\WindowsApps\OpenAI.Codex_26.928.1915.0_x64__2p2nqsd0c76g0\app\ChatGPT.exe`

Child-only environment:

```text
CODEX_HOME=D:\WILL\TOOLS\needs-forever\.scratch\main-session-supervision\live-desktop\中文 空间验收\Codex Home
CODEX_ELECTRON_USER_DATA_PATH=D:\WILL\TOOLS\needs-forever\.scratch\main-session-supervision\live-desktop\中文 空间验收\Desktop Profile
```

Arguments (each is a distinct argv element):

```text
--user-data-dir=D:\WILL\TOOLS\needs-forever\.scratch\main-session-supervision\live-desktop\中文 空间验收\Desktop Profile
--enable-logging=stderr
```

The script uses a hidden startup window and CREATE_NO_WINDOW. Both output streams
are redirected directly to separate files, allowing capture after the observation
ends without a PowerShell callback/runspace or pipe lifetime problem. After five
seconds it records PID, alive/exit code, profile directory existence, and log sizes.
It never kills the child. It does not print raw logs. It requires `--launch` to
start anything. Review raw logs locally with care before sharing excerpts.

## Findings and limits

1. The previous isolated launch at 2026-11-03T12:19:40.8992040Z used the two
   environment variables but no arguments. PID 33668 exited, no profile appeared,
   and no stderr/exit code was captured. Its exact cause cannot be established.
2. The installed package is Codex despite historical ChatGPT file/display names:
   app.asar identifies `openai-codex-electron`, product Codex, version 26.928.20755.
   The MSIX directory version is 26.928.1915.0. The executable is Owl/Chromium,
   VersionInfo OriginalFilename `chrome.exe`, FileVersion 154.0.8037.57.
3. The observed active app command line has no arguments. Its crashpad child has
   `--user-data-dir=C:\Users\will\AppData\Roaming\Codex\web\Codex`. That native
   Chromium directory has a lockfile. This is evidence for a native profile layer
   that could collide before JavaScript profile override takes effect.
4. The sibling `Codex.exe` has windows-updater-addon/update-trampoline binary
   strings; it is not an alternate application main entry point.
5. Bundle `main-BGDKyzfM.js` contains a macOS-only demo launcher which combines
   CODEX_HOME, CODEX_ELECTRON_USER_DATA_PATH, and `--user-data-dir` pointing to
   the same isolated profile. That provides a concrete next diagnostic pattern,
   not a guarantee of Windows support.
6. Bundle `bootstrap-Bj_1Kfw1.js` resolves the explicit Electron profile, calls
   app.setPath(userData), then requestSingleInstanceLock. Windows packaged builds
   require that lock. A false result logs `Exiting second desktop instance` and
   exits 0.
7. Bundle `early-bootstrap.js` loads `startup-requirements` and awaits
   initializeNodeNetworkPermissions *before* importing the bootstrap containing
   setPath and the JavaScript lock. Early network/policy failure is therefore an
   independent possible explanation for no profile directory. Its catch logs
   `Desktop network requirements prevented startup` and exits 1. Absence of the
   profile is insufficient to attribute the previous exit to singleton locking.
8. CODEX_ELECTRON_CHROMIUM_SWITCHES is a development-build setting and is not a
   production alternative. The installed build flavor is prod.
9. Current shell had none of ELECTRON_RUN_AS_NODE, ELECTRON_NO_ASAR, NODE_OPTIONS,
   NODE_ENV, CODEX_HOME, CODEX_ELECTRON_USER_DATA_PATH, or
   CODEX_ELECTRON_BUILD_FLAVOR set. No run-as-node pollution was observed.

Bundle extraction and hashes are in `desktop-profile-readonly-evidence.json`.
Update trampoline strings are in `t18-codex-native-launcher-strings.json`.
Prior attempt receipt is in `live-desktop/unicode-profile-launch.json`.

## Same-profile per-plugin path alternative

Pinned upstream source inspected:
`official-codex-0159`, rust-v0.159.0,
commit `687a119f0fcaace47e1f1abcc77cec6c813fd6da`.

No supported per-plugin runtime cache-root/direct-load setting was found in these
paths. This is a source-backed bounded finding, not a universal claim about future
Codex releases.

* `codex-rs/config/src/types.rs:1004`: PluginConfig has enabled and mcp_servers;
  no path or cache-root field.
* `codex-rs/core-plugins/src/store.rs:84`: PluginStore::try_new fixes its root at
  codex_home.join(PLUGINS_CACHE_DIR), and plugin_root appends marketplace, plugin,
  and version.
* `codex-rs/core-plugins/src/loader.rs:822`: load_plugin obtains runtime root from
  store.active_plugin_installation and returns `plugin is not installed` without
  that installation. Runtime hooks share this actual plugin installation root.
* `codex-rs/core-plugins/src/loader.rs:662`: non-curated refresh materializes a
  configured source and calls store.install_with_version. A local marketplace
  located under a Chinese path still copies the runtime artifact into the store.
* `codex-rs/core-plugins/src/marketplace.rs:152`: Local is excluded from
  is_install_materialized. In `manager.rs:2631`, plugin details can therefore read
  local source directly. This is details/inventory behavior, not proof that hook
  execution bypasses the installed store.
* `codex-rs/core-plugins/src/marketplace_policy.rs:293`: plugin configuration is
  deserialized into the same PluginConfig structure.

Changing CODEX_HOME moves all store roots for that app-server/profile and would
affect the default profile's whole plugin set. No same-profile workaround was
applied. Junctions, copied trust, private config bypasses, and editing runtime
installation metadata were not proposed.

## Remaining acceptance boundary

The script is a diagnostic next step, not T18 acceptance evidence. A running
isolated app must still be observed to use the intended CODEX_HOME and actual
Chinese/space plugin root, authenticate through its normal flow as needed, let
the user review hook trust, and execute the real native lifecycle. Shell fixture
tests do not establish this final native-path gate.

## Parent-executed diagnostic result

The parent executed the diagnostic launcher after this proposal was delivered.
Receipt: `t18-diagnostic-20261103T124717038877Z/receipt.json`.
PID 54080 survived the initial observation and created the intended profile.
This investigator subsequently performed read-only process/log/source inspection.

Observed child processes of PID 54080 include gpu, utility, and renderer processes
with the intended Chinese/space `--user-data-dir`, app-server `codex.exe` PID 49768,
and `codex-computer-use-swift.exe`. The isolated Chromium profile has its own
lockfile, Default, Crashpad, and standard profile directories.

Safe exact-string evidence from its own stderr is captured in
`t18-postlaunch-readonly-evidence.json`, produced by
`t18-postlaunch-readonly-probe.py`. At that observation:

* `Sign in to ChatGPT to start a durable thread.`: 55 occurrences.
* `Sign in to ChatGPT to check remote control authorization.`: 4 occurrences.
* `rendererWindowVisible=true`: 13 occurrences.
* `Exiting second desktop instance`: 0 occurrences.
* `Desktop network requirements prevented startup`: 0 occurrences.

The separate profile therefore passed initial native/JavaScript/UI startup and
has a normal authentication requirement. Hidden startup did not leave all windows
reported invisible by the application's own renderer logs. A computer-use window
inventory that does not list it is not evidence of application startup failure.
No authentication files or credential contents were inspected.

For window activation, the actual bundle exposes the normal second-instance
handler: bootstrap offset 2202166 listens for second-instance and forwards argv;
main offset 3691711 routes even an invocation without a deep link to the existing
primary window and restores/shows/focuses it. A parent may invoke the exact same
exe, two isolated environment variables, and `--user-data-dir` again to request
activation of that existing isolated instance. This follows its built-in startup
path and remains an unverified suggestion. Using the system `codex://` handler
instead would select the system default app/profile and is unsuitable for targeting
this specific isolated profile.
