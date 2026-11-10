import { spawnSync } from 'node:child_process';

/** Real local probe; the replacement host/model remain simulated. */
export function transportProof(workspace: string): Record<string, unknown> {
  const argv = ['-e', "console.log(JSON.stringify({fixture_workspace:require('node:fs').statSync('.').isDirectory(),fixture_external_input:require('node:fs').existsSync('fixture-external-input')}))"];
  const result = spawnSync(process.execPath, argv, { cwd: workspace, encoding: 'utf8', timeout: 5_000, windowsHide: true });
  if (result.status !== 0) throw new Error(`Fixture probe failed: ${result.stderr}`);
  return { type: 'commandExecution', id: 'transport-local-probe', command: JSON.stringify([process.execPath, ...argv]), status: 'completed', exitCode: result.status, aggregatedOutput: result.stdout };
}
