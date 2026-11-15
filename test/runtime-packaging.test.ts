import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  createPackagingReceiptInput,
  inspectRuntimeArtifacts,
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

test('runtime packaging contract produces deterministic normalized manifest and receipt input', () => {
  withFixture((root) => {
    const source = join(root, '源 tree with spaces');
    const target = join(root, 'runtime output');
    mkdirSync(join(source, '中文 模块'), { recursive: true });
    mkdirSync(join(source, 'empty directory'));
    writeFileSync(join(source, 'z.js'), '\uFEFFexport default "z";\r\n');
    writeFileSync(join(source, 'a.js'), 'export default "a";\r\n//# sourceMappingURL=a.js.map\r\n');
    writeFileSync(join(source, '中文 模块', 'entry.js'), 'export default "入口";\n');
    writeFileSync(join(source, 'types.d.ts'), 'export type Only = string;\r\n');
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
