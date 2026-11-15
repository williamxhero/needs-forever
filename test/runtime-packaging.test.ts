import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  createPackagingReceiptInput,
  inspectRuntimeArtifacts,
  runRuntimePackaging,
  verifyInstalledRuntime,
  verifyRuntimeParity,
  RuntimePackagingError,
} from '../src/runtime-packaging.js';

function withFixture(run: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'needs-forever-packaging-'));
  try {
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function identity() {
  return {
    packageName: 'needs-forever',
    packageVersion: '0.3.4',
    sourceRevision: 'source-revision-abc123',
    generatorVersion: 'runtime-packaging-contract@1',
  } as const;
}

function errorCode(error: unknown): string {
  assert.ok(error instanceof RuntimePackagingError);
  return error.code;
}

function installedFixture(root: string) {
  const source = join(root, 'source');
  const bundledPluginRoot = join(root, 'bundled-plugin');
  const installedPluginRoot = join(root, 'installed-plugin');
  const runtimeRoot = join(bundledPluginRoot, 'runtime');
  mkdirSync(source, { recursive: true });
  mkdirSync(join(bundledPluginRoot, '.codex-plugin'), { recursive: true });
  writeFileSync(join(source, 'entry.js'), 'export default "ok";\n');
  writeFileSync(join(bundledPluginRoot, '.codex-plugin', 'plugin.json'), JSON.stringify({ name: 'needs-forever', version: '0.3.4' }) + '\n');
  writeFileSync(join(bundledPluginRoot, 'package.json'), JSON.stringify({ name: 'needs-forever-plugin', version: '0.3.4' }) + '\n');
  runRuntimePackaging({
    sourceRoot: source,
    runtimeRoot,
    runtimeTarget: join(runtimeRoot, 'src'),
    identity: { packageName: 'needs-forever', packageVersion: '0.3.4', sourceRevision: 'revision-96', generatorVersion: 'runtime-packaging-pipeline@1' },
  });
  cpSync(bundledPluginRoot, installedPluginRoot, { recursive: true });
  return { bundledPluginRoot, installedPluginRoot, runtimeRoot };
}

function issueCodes(receipt: ReturnType<typeof verifyInstalledRuntime>): string[] {
  return receipt.errors.map((issue) => issue.code);
}

test('runtime packaging contract produces deterministic normalized manifest and receipt input', () => {
  withFixture((root) => {
    const source = join(root, '源 tree with spaces');
    const target = join(root, 'runtime output');
    mkdirSync(join(source, '中文 模块'), { recursive: true });
    mkdirSync(join(source, 'empty directory'));
    writeFileSync(join(source, 'z.js'), '\uFEFFexport default "z";\r\n');
    writeFileSync(join(source, 'a.js'), 'export default "a";\r\n//# sourceMappingURL=a.js.map\r\n');
    writeFileSync(join(source, '中文 模块', 'entry.js'), 'export default "入口";\n');
    writeFileSync(join(source, 'generated.js'), '// GENERATED CODE! DO NOT MODIFY BY HAND!\nexport {};\n');
    writeFileSync(join(source, 'types.d.ts'), 'export type Only = string;\n');
    writeFileSync(join(source, 'entry.js.map'), '{}\n');

    const first = inspectRuntimeArtifacts({ sourceRoot: source, runtimeTarget: target, identity: identity() });
    const second = inspectRuntimeArtifacts({ sourceRoot: source, runtimeTarget: target, identity: identity() });

    assert.deepEqual(first, second);
    assert.deepEqual(first.artifacts.map((artifact) => artifact.path), [
      'a.js',
      'z.js',
      '中文 模块/entry.js',
    ]);
    assert.equal(first.artifacts[0]?.content, 'export default "a";\n');
    assert.equal(first.artifacts[1]?.content, 'export default "z";\n');
    assert.equal(first.artifacts[2]?.content, 'export default "入口";\n');
    assert.deepEqual(first.excluded.find(({ path }) => path === 'generated.js'), { path: 'generated.js', reason: 'type-only' });
    assert.equal(first.manifest.schema_version, 1);
    assert.equal(first.manifest.package_name, identity().packageName);
    assert.equal(first.manifest.package_version, identity().packageVersion);
    assert.equal(first.manifest.source_revision, identity().sourceRevision);
    assert.equal(first.manifest.generator_version, identity().generatorVersion);
    assert.deepEqual(first.manifest.artifacts, first.artifacts.map(({ path, byte_length, content_sha256 }) => ({ path, byte_length, content_sha256 })));
    assert.equal(first.manifest_sha256, createHash('sha256').update(first.manifest_json, 'utf8').digest('hex'));

    const receipt = createPackagingReceiptInput(first);
    assert.deepEqual(receipt, {
      schema_version: 1,
      package_name: identity().packageName,
      package_version: identity().packageVersion,
      source_revision: identity().sourceRevision,
      generator_version: identity().generatorVersion,
      manifest_sha256: first.manifest_sha256,
      manifest: first.manifest,
      source: { status: 'selected' },
      bundled: { status: 'not_run' },
      installed: { status: 'not_run' },
      native_effectiveness: 'not_run',
    });
  });
});

test('runtime packaging contract fail-closes unsupported and duplicate artifacts', () => {
  withFixture((root) => {
    const source = join(root, 'source');
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, 'unsupported.txt'), 'no runtime');
    assert.throws(
      () => inspectRuntimeArtifacts({ sourceRoot: source, runtimeTarget: join(root, 'target'), identity: identity() }),
      (error: unknown) => errorCode(error) === 'UNSUPPORTED_ARTIFACT',
    );
  });

  withFixture((root) => {
    const source = join(root, 'source');
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, 'é.js'), 'export default 1;');
    writeFileSync(join(source, 'é.js'), 'export default 2;');
    assert.throws(
      () => inspectRuntimeArtifacts({ sourceRoot: source, runtimeTarget: join(root, 'target'), identity: identity() }),
      (error: unknown) => errorCode(error) === 'DUPLICATE_ARTIFACT',
    );
  });
});

test('runtime packaging contract excludes symlinks and does not follow them', (t) => {
  withFixture((root) => {
    const source = join(root, 'source');
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, 'real.js'), 'export default 1;');
    try {
      symlinkSync(join(source, 'real.js'), join(source, 'linked.js'), 'file');
    } catch (error) {
      t.skip(`symlinks unavailable: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    const plan = inspectRuntimeArtifacts({ sourceRoot: source, runtimeTarget: join(root, 'target'), identity: identity() });
    assert.deepEqual(plan.artifacts.map((artifact) => artifact.path), ['real.js']);
    assert.deepEqual(plan.excluded, [{ path: 'linked.js', reason: 'symlink' }]);
  });
});

test('runtime packaging contract rejects invalid roots, traversal and malformed UTF-8', () => {
  withFixture((root) => {
    const source = join(root, 'source');
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, 'main.js'), 'export default 1;');
    assert.throws(
      () => inspectRuntimeArtifacts({ sourceRoot: 'relative/source', runtimeTarget: join(root, 'target'), identity: identity() }),
      (error: unknown) => errorCode(error) === 'INVALID_ROOT',
    );
    assert.throws(
      () => inspectRuntimeArtifacts({ sourceRoot: source, runtimeTarget: source, identity: identity() }),
      (error: unknown) => errorCode(error) === 'PATH_CONFLICT',
    );
    writeFileSync(join(source, 'broken.js'), Buffer.from([0xc3, 0x28]));
    assert.throws(
      () => inspectRuntimeArtifacts({ sourceRoot: source, runtimeTarget: join(root, 'target'), identity: identity() }),
      (error: unknown) => errorCode(error) === 'INVALID_UTF8',
    );
  });
});

test('runtime packaging receipt input is independent of host absolute paths', () => {
  withFixture((root) => {
    const source = resolve(root, 'source');
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, 'main.js'), 'export default 1;');
    const plan = inspectRuntimeArtifacts({ sourceRoot: source, runtimeTarget: resolve(root, 'target'), identity: identity() });
    const serialized = JSON.stringify(createPackagingReceiptInput(plan));
    assert.equal(serialized.includes(root), false);
    assert.equal(serialized.includes('sourceRoot'), false);
    assert.equal(serialized.includes('runtimeTarget'), false);
    assert.equal(readFileSync(join(source, 'main.js'), 'utf8'), 'export default 1;');
  });
});

test('runtime packaging pipeline builds, materializes, verifies parity, and emits a deterministic receipt', () => {
  withFixture((root) => {
    const source = join(root, 'source');
    const runtimeRoot = join(root, 'bundle');
    const runtimeTarget = join(runtimeRoot, 'src');
    const identity = {
      packageName: 'needs-forever',
      packageVersion: '0.3.4',
      sourceRevision: 'revision-95',
      generatorVersion: 'runtime-packaging-pipeline@1',
    } as const;
    let builds = 0;
    const first = runRuntimePackaging({
      sourceRoot: source,
      runtimeRoot,
      runtimeTarget,
      identity,
      buildSource: () => {
        builds += 1;
        mkdirSync(source, { recursive: true });
        writeFileSync(join(source, 'entry.js'), '\uFEFFexport default "ok";\n');
        writeFileSync(join(source, 'entry.d.ts'), 'export type Entry = string;\n');
      },
    });
    assert.equal(builds, 1);
    assert.equal(first.bundled.artifacts[0]?.content, 'export default "ok";\n');
    assert.equal(first.receipt.source.status, 'built');
    assert.equal(first.receipt.bundled.status, 'verified');
    assert.equal(first.receipt.installed.status, 'not_run');
    assert.equal(first.receipt.native_effectiveness, 'not_run');
    assert.deepEqual(JSON.parse(readFileSync(join(runtimeRoot, 'manifest.json'), 'utf8')), first.plan.manifest);
    assert.deepEqual(JSON.parse(readFileSync(join(runtimeRoot, 'integrity.json'), 'utf8')), first.integrity);
    assert.deepEqual(JSON.parse(readFileSync(join(runtimeRoot, 'packaging-receipt.json'), 'utf8')), first.receipt);
    const receiptBytes = readFileSync(join(runtimeRoot, 'packaging-receipt.json'), 'utf8');
    const second = runRuntimePackaging({ sourceRoot: source, runtimeRoot, runtimeTarget, identity, buildSource: () => { builds += 1; } });
    assert.equal(builds, 2);
    assert.deepEqual(second.receipt, first.receipt);
    assert.equal(readFileSync(join(runtimeRoot, 'packaging-receipt.json'), 'utf8'), receiptBytes);
    assert.equal(JSON.stringify(second.bundled.manifest.artifacts), JSON.stringify(first.bundled.manifest.artifacts));
  });
});

test('runtime packaging pipeline fails closed and keeps the previous verified bundle', () => {
  withFixture((root) => {
    const source = join(root, 'source');
    const runtimeRoot = join(root, 'bundle');
    const runtimeTarget = join(runtimeRoot, 'src');
    const identity = {
      packageName: 'needs-forever',
      packageVersion: '0.3.4',
      sourceRevision: 'revision-95',
      generatorVersion: 'runtime-packaging-pipeline@1',
    } as const;
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, 'entry.js'), 'export default "good";\n');
    runRuntimePackaging({ sourceRoot: source, runtimeRoot, runtimeTarget, identity });
    const oldRuntime = readFileSync(join(runtimeTarget, 'entry.js'), 'utf8');
    const oldReceipt = readFileSync(join(runtimeRoot, 'packaging-receipt.json'), 'utf8');
    writeFileSync(join(source, 'unsupported.txt'), 'must fail');
    assert.throws(
      () => runRuntimePackaging({ sourceRoot: source, runtimeRoot, runtimeTarget, identity }),
      (error: unknown) => errorCode(error) === 'UNSUPPORTED_ARTIFACT',
    );
    assert.equal(readFileSync(join(runtimeTarget, 'entry.js'), 'utf8'), oldRuntime);
    assert.equal(readFileSync(join(runtimeRoot, 'packaging-receipt.json'), 'utf8'), oldReceipt);
    assert.equal(readFileSync(join(runtimeRoot, 'src/entry.js'), 'utf8'), 'export default "good";\n');
  });
});

test('runtime packaging parity interface rejects an extra bundled module', () => {
  withFixture((root) => {
    const source = join(root, 'source');
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, 'entry.js'), 'export default 1;');
    const sourcePlan = inspectRuntimeArtifacts({ sourceRoot: source, runtimeTarget: join(root, 'target'), identity: identity() });
    const bundled = inspectRuntimeArtifacts({ sourceRoot: source, runtimeTarget: join(root, 'target-2'), identity: identity() });
    bundled.manifest.artifacts.push({ path: 'extra.js', byte_length: 0, content_sha256: '0'.repeat(64) });
    assert.throws(() => verifyRuntimeParity(sourcePlan, bundled), (error: unknown) => errorCode(error) === 'PARITY_FAILED');
  });
});

test('installed runtime verification consumes one packaging receipt and emits a readback receipt', () => {
  withFixture((root) => {
    const fixture = installedFixture(root);
    const receipt = verifyInstalledRuntime({
      bundledPluginRoot: fixture.bundledPluginRoot,
      installedPluginRoot: fixture.installedPluginRoot,
      now: () => new Date('2026-11-15T08:00:00.000Z'),
    });
    assert.equal(receipt.ok, true);
    assert.equal(receipt.verification_status, 'passed');
    assert.equal(receipt.source.status, 'built');
    assert.equal(receipt.bundled.status, 'verified');
    assert.equal(receipt.installed.status, 'verified');
    assert.equal(receipt.plugin_metadata.status, 'verified');
    assert.equal(receipt.installed.file_count, 1);
    assert.equal(receipt.native_effectiveness, 'not_run');
    assert.equal(receipt.verified_at, '2026-11-15T08:00:00.000Z');
    const readback = JSON.parse(JSON.stringify(receipt));
    assert.deepEqual(readback, receipt);
  });
});

test('installed runtime verification fails closed for missing, extra, and hash-drifted files', () => {
  withFixture((root) => {
    const fixture = installedFixture(root);
    unlinkFile(join(fixture.installedPluginRoot, 'runtime', 'src', 'entry.js'));
    const missing = verifyInstalledRuntime(fixture);
    assert.equal(missing.ok, false);
    assert.ok(issueCodes(missing).includes('MISSING_FILE'));
  });

  withFixture((root) => {
    const fixture = installedFixture(root);
    writeFileSync(join(fixture.installedPluginRoot, 'runtime', 'src', 'extra.js'), 'export default "extra";\n');
    const extra = verifyInstalledRuntime(fixture);
    assert.equal(extra.ok, false);
    assert.ok(issueCodes(extra).includes('EXTRA_FILE'));
  });

  withFixture((root) => {
    const fixture = installedFixture(root);
    writeFileSync(join(fixture.installedPluginRoot, 'runtime', 'src', 'entry.js'), 'export default "drift";\n');
    const drift = verifyInstalledRuntime(fixture);
    assert.equal(drift.ok, false);
    assert.ok(issueCodes(drift).includes('HASH_MISMATCH'));
  });
});

test('installed runtime verification rejects metadata drift, path escape, and encoding drift', () => {
  withFixture((root) => {
    const fixture = installedFixture(root);
    const plugin = JSON.parse(readFileSync(join(fixture.installedPluginRoot, '.codex-plugin', 'plugin.json'), 'utf8')) as { version: string };
    plugin.version = '9.9.9';
    writeFileSync(join(fixture.installedPluginRoot, '.codex-plugin', 'plugin.json'), JSON.stringify(plugin) + '\n');
    const version = verifyInstalledRuntime(fixture);
    assert.equal(version.ok, false);
    assert.ok(issueCodes(version).includes('VERSION_MISMATCH'));
  });

  withFixture((root) => {
    const fixture = installedFixture(root);
    writeFileSync(join(fixture.installedPluginRoot, '.codex-plugin', 'plugin.json'), JSON.stringify({ name: 'needs-forever', version: '0.3.4', description: 'drift' }) + '\n');
    const metadata = verifyInstalledRuntime(fixture);
    assert.equal(metadata.ok, false);
    assert.ok(issueCodes(metadata).includes('PARITY_FAILED'));
  });

  withFixture((root) => {
    const fixture = installedFixture(root);
    writeFileSync(join(fixture.installedPluginRoot, 'package.json'), JSON.stringify({ name: 'foreign-package', version: '0.3.4' }) + '\n');
    const packageName = verifyInstalledRuntime(fixture);
    assert.equal(packageName.ok, false);
    assert.ok(issueCodes(packageName).includes('PARITY_FAILED'));
  });

  withFixture((root) => {
    const fixture = installedFixture(root);
    const manifestPath = join(fixture.bundledPluginRoot, 'runtime', 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { artifacts: Array<{ path: string }> };
    manifest.artifacts[0]!.path = '../outside.js';
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const pathDrift = verifyInstalledRuntime(fixture);
    assert.equal(pathDrift.ok, false);
    assert.ok(issueCodes(pathDrift).includes('INTEGRITY_FAILED'));
  });

  withFixture((root) => {
    const fixture = installedFixture(root);
    writeFileSync(join(fixture.installedPluginRoot, 'runtime', 'src', 'entry.js'), '\uFEFFexport default "ok";\r\n');
    const encoding = verifyInstalledRuntime(fixture);
    assert.equal(encoding.ok, false);
    assert.ok(issueCodes(encoding).some((code) => code === 'INTEGRITY_FAILED' || code === 'HASH_MISMATCH'));
  });
});

test('installed runtime verification rejects using the bundled directory as the installed copy', () => {
  withFixture((root) => {
    const fixture = installedFixture(root);
    const sameRoot = verifyInstalledRuntime({ ...fixture, installedPluginRoot: fixture.bundledPluginRoot });
    assert.equal(sameRoot.ok, false);
    assert.ok(issueCodes(sameRoot).includes('PATH_CONFLICT'));
  });
});

test('installed runtime verification consumes custom metadata paths from the packaging output', () => {
  withFixture((root) => {
    const source = join(root, 'source');
    const bundledPluginRoot = join(root, 'bundled-plugin');
    const installedPluginRoot = join(root, 'installed-plugin');
    const runtimeRoot = join(bundledPluginRoot, 'runtime');
    mkdirSync(source, { recursive: true });
    mkdirSync(join(bundledPluginRoot, '.codex-plugin'), { recursive: true });
    writeFileSync(join(source, 'entry.js'), 'export default "ok";\n');
    writeFileSync(join(bundledPluginRoot, '.codex-plugin', 'plugin.json'), JSON.stringify({ name: 'needs-forever', version: '0.3.4' }) + '\n');
    writeFileSync(join(bundledPluginRoot, 'package.json'), JSON.stringify({ name: 'needs-forever-plugin', version: '0.3.4' }) + '\n');
    runRuntimePackaging({ sourceRoot: source, runtimeRoot, runtimeTarget: join(runtimeRoot, 'src'), integrityTarget: join(runtimeRoot, 'metadata', 'integrity.json'), receiptTarget: join(runtimeRoot, 'metadata', 'receipt.json'), identity: { packageName: 'needs-forever', packageVersion: '0.3.4', sourceRevision: 'revision-custom-metadata', generatorVersion: 'runtime-packaging-pipeline@1' } });
    cpSync(bundledPluginRoot, installedPluginRoot, { recursive: true });
    const receipt = verifyInstalledRuntime({ bundledPluginRoot, installedPluginRoot, integrityPath: join(runtimeRoot, 'metadata', 'integrity.json'), receiptPath: join(runtimeRoot, 'metadata', 'receipt.json') });
    assert.equal(receipt.ok, true);
  });
});

test('installed runtime verification rejects unreadable or symbolic-link runtime input', (t) => {
  withFixture((root) => {
    const fixture = installedFixture(root);
    unlinkFile(join(fixture.bundledPluginRoot, 'runtime', 'packaging-receipt.json'));
    const unreadable = verifyInstalledRuntime(fixture);
    assert.equal(unreadable.ok, false);
    assert.ok(issueCodes(unreadable).includes('READ_FAILED'));
  });

  withFixture((root) => {
    const fixture = installedFixture(root);
    try {
      symlinkSync(join(fixture.installedPluginRoot, 'runtime', 'src', 'entry.js'), join(fixture.installedPluginRoot, 'runtime', 'src', 'linked.js'), 'file');
    } catch (error) {
      t.skip(`symlinks unavailable: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    const symlink = verifyInstalledRuntime(fixture);
    assert.equal(symlink.ok, false);
    assert.ok(issueCodes(symlink).includes('SYMLINK'));
  });
});

function unlinkFile(path: string): void {
  unlinkSync(path);
}
