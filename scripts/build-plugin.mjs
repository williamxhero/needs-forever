import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const root = fileURLToPath(new URL('../', import.meta.url));
const plugin = resolve(root, 'plugins/needs-forever');
// Desktop 0.159 deliberately skips hooks for the AgentPlugin root format.
if (existsSync(resolve(plugin, 'plugin.json'))) throw new Error('Keep the hook-enabled .codex-plugin/plugin.json format; root plugin.json suppresses native hooks.');
const pluginManifest = JSON.parse(readFileSync(resolve(plugin, '.codex-plugin/plugin.json'), 'utf8'));
if (pluginManifest.version !== JSON.parse(readFileSync(resolve(plugin, 'package.json'), 'utf8')).version) throw new Error('Plugin package and manifest versions must match.');
const source = resolve(root, 'dist/src');
const target = resolve(root, 'plugins/needs-forever/runtime/src');
if (!existsSync(source)) {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const build = spawnSync(npm, ['run', 'build'], { cwd: root, stdio: 'inherit', windowsHide: true });
  if (build.status !== 0) throw new Error(`Source build failed with status ${build.status ?? 'unknown'}.`);
}
const { inspectRuntimeArtifacts, runRuntimePackaging } = await import(new URL('../dist/src/runtime-packaging.js', import.meta.url));
const revisionProbe = inspectRuntimeArtifacts({
  sourceRoot: source,
  runtimeTarget: resolve(root, '.runtime-packaging-probe'),
  identity: { packageName: pluginManifest.name, packageVersion: pluginManifest.version, sourceRevision: 'probe', generatorVersion: 'runtime-packaging-pipeline@1' },
});
const revision = `content-${createHash('sha256').update(JSON.stringify(revisionProbe.manifest.artifacts), 'utf8').digest('hex')}`;
const result = runRuntimePackaging({
  sourceRoot: source,
  runtimeRoot: resolve(plugin, 'runtime'),
  runtimeTarget: target,
  identity: {
    packageName: pluginManifest.name,
    packageVersion: pluginManifest.version,
    sourceRevision: revision,
    generatorVersion: 'runtime-packaging-pipeline@1',
  },
});
console.log(`Built and verified self-contained plugin runtime (${result.bundled.artifacts.length} modules, manifest ${result.receipt.manifest_sha256}).`);
