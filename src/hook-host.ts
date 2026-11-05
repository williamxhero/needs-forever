import { spawnSync } from 'node:child_process';
import { canonicalPath, readJson } from './main-session.js';
import { codexCommand } from './transport.js';

export interface HookHost {
  source: 'native-desktop' | 'simulated' | 'unverified';
  desktop_version: string | null;
  cli_version: string | null;
  reason: string;
  desktop_pid?: number;
  desktop_binary?: string;
}
// The host owns the trust decision. This adapter independently checks which
// installed host invoked the packaged handler; it never writes hook trust.
export function inspectHookHost(pluginRoot: string, fixture?: string): HookHost {
  if (fixture) {
    const value = readJson(fixture);
    return { source: 'simulated', desktop_version: String(value.desktop_version ?? 'simulated'), cli_version: String(value.cli_version ?? 'simulated'), reason: 'Explicit external hook-host fixture; not native effectiveness evidence.', ...(Number.isInteger(value.desktop_pid) ? { desktop_pid: value.desktop_pid as number } : {}) };
  }
  const unavailable = (reason: string): HookHost => ({ source: 'unverified', desktop_version: null, cli_version: null, reason });
  if (!process.env.PLUGIN_ROOT) return unavailable('PLUGIN_ROOT missing; this is not an attributable installed-plugin callback.');
  try { if (canonicalPath(process.env.PLUGIN_ROOT) !== canonicalPath(pluginRoot)) return unavailable('Installed plugin root does not match the callback package.'); }
  catch { return unavailable('Installed plugin root is unavailable.'); }
  if (process.platform !== 'win32') return unavailable('Native Desktop provenance is not yet verified on this platform.');
  // Process ids are numeric and the query contains no event data, command line
  // or credentials. Do not use CODEX_THREAD_ID / CODEX_SESSION_ID as identity.
  const query = `$taskPid=${process.ppid}; $taskRows=@(); for($taskN=0; $taskN -lt 12 -and $taskPid -gt 0; $taskN++){ $taskP=Get-CimInstance Win32_Process -Filter "ProcessId=$taskPid"; if(!$taskP){break}; $taskRows += @{pid=[int]$taskP.ProcessId; path=$taskP.ExecutablePath}; $taskPid=[int]$taskP.ParentProcessId }; ConvertTo-Json -InputObject $taskRows -Compress`;
  const probe = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', query], { encoding: 'utf8', windowsHide: true, timeout: 8_000 });
  if (probe.status !== 0) return unavailable('Unable to verify native Desktop callback ancestry.');
  let rows: { pid: number; path: string | null }[];
  try { rows = JSON.parse(probe.stdout); } catch { return unavailable('Invalid native Desktop ancestry receipt.'); }
  const desktop = rows.find((entry) => typeof entry.path === 'string' && /[\\/]OpenAI[\\/]Codex[\\/]bin[\\/][^\\/]+[\\/]codex\.exe$/i.test(entry.path));
  if (!desktop?.path) return unavailable('Callback did not originate under the installed Codex Desktop host.');
  const version = spawnSync(desktop.path, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 5_000 });
  if (version.status !== 0) return unavailable('Desktop binary version could not be verified.');
  const argv = codexCommand();
  const cli = spawnSync(argv[0]!, [...argv.slice(1), '--version'], { encoding: 'utf8', windowsHide: true, timeout: 5_000 });
  return { source: 'native-desktop', desktop_version: version.stdout.trim(), cli_version: cli.status === 0 ? cli.stdout.trim() : null, reason: 'Observed installed-plugin lifecycle callback under the actual Desktop binary.', desktop_pid: desktop.pid, desktop_binary: desktop.path };
}
