import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

export type RuntimeArtifactExclusionReason = 'type-only' | 'source-map' | 'symlink';

export interface RuntimePackagingIdentity {
  packageName: string;
  packageVersion: string;
  sourceRevision: string;
  generatorVersion: string;
}

export interface RuntimePackagingInput {
  sourceRoot: string;
  runtimeTarget: string;
  identity: RuntimePackagingIdentity;
}

/** Inputs for the one public source-to-bundle packaging seam. */
export interface RuntimePackagingPipelineInput extends RuntimePackagingInput {
  /** Root replaced only after the staged bundle has passed every check. */
  runtimeRoot?: string;
  /** Metadata destinations must remain inside runtimeRoot. */
  integrityTarget?: string;
  receiptTarget?: string;
  /** Source build hook. The pipeline owns when this hook runs. */
  buildSource?: () => void;
}

export interface RuntimeArtifact {
  path: string;
  content: string;
  byte_length: number;
  content_sha256: string;
}

export interface RuntimeArtifactExclusion {
  path: string;
  reason: RuntimeArtifactExclusionReason;
}

export interface RuntimeArtifactManifestEntry {
  path: string;
  byte_length: number;
  content_sha256: string;
}

export interface RuntimeArtifactManifest {
  schema_version: 1;
  package_name: string;
  package_version: string;
  source_revision: string;
  generator_version: string;
  artifacts: RuntimeArtifactManifestEntry[];
  excluded: RuntimeArtifactExclusion[];
}

export interface RuntimePackagingPlan {
  schema_version: 1;
  source_root: string;
  runtime_target: string;
  identity: RuntimePackagingIdentity;
  artifacts: RuntimeArtifact[];
  excluded: RuntimeArtifactExclusion[];
  manifest: RuntimeArtifactManifest;
  manifest_json: string;
  manifest_sha256: string;
}

export interface RuntimePackagingReceiptInput {
  schema_version: 1;
  package_name: string;
  package_version: string;
  source_revision: string;
  generator_version: string;
  manifest_sha256: string;
  manifest: RuntimeArtifactManifest;
  source: { status: 'selected' };
  bundled: { status: 'not_run' };
  installed: { status: 'not_run' };
  native_effectiveness: 'not_run';
}

export interface RuntimePackagingIntegrity {
  schema_version: 1;
  generated_by: string;
  package_name: string;
  package_version: string;
  source_revision: string;
  manifest_sha256: string;
  files: Record<string, string>;
}

export interface RuntimePackagingPipelineReceipt {
  schema_version: 1;
  package_name: string;
  package_version: string;
  source_revision: string;
  generator_version: string;
  manifest_sha256: string;
  integrity_sha256: string;
  source: { status: 'built'; manifest_sha256: string };
  bundled: { status: 'verified'; manifest_sha256: string; integrity_sha256: string };
  installed: { status: 'not_run' };
  native_effectiveness: 'not_run';
}

export interface RuntimePackagingPipelineResult {
  plan: RuntimePackagingPlan;
  bundled: RuntimePackagingPlan;
  integrity: RuntimePackagingIntegrity;
  receipt: RuntimePackagingPipelineReceipt;
}

export type RuntimePackagingErrorCode =
  | 'INVALID_ROOT'
  | 'PATH_CONFLICT'
  | 'INVALID_IDENTITY'
  | 'INVALID_ARTIFACT_PATH'
  | 'UNSUPPORTED_ARTIFACT'
  | 'DUPLICATE_ARTIFACT'
  | 'INVALID_UTF8'
  | 'READ_FAILED'
  | 'BUILD_FAILED'
  | 'MATERIALIZE_FAILED'
  | 'PARITY_FAILED'
  | 'INTEGRITY_FAILED'
  | 'ATOMIC_REPLACE_FAILED';

export class RuntimePackagingError extends Error {
  readonly code: RuntimePackagingErrorCode;
  readonly artifactPath: string | undefined;

  constructor(code: RuntimePackagingErrorCode, message: string, artifactPath?: string) {
    super(message);
    this.name = 'RuntimePackagingError';
    this.code = code;
    this.artifactPath = artifactPath;
  }
}

const utf8 = new TextDecoder('utf-8', { fatal: true });

function compareStable(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizeRelativeArtifactPath(sourceRoot: string, absolutePath: string): string {
  const candidate = relative(sourceRoot, absolutePath).replaceAll('\\', '/');
  const segments = candidate.split('/');
  if (!candidate || isAbsolute(candidate) || candidate === '..' || candidate.startsWith('../') || segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new RuntimePackagingError('INVALID_ARTIFACT_PATH', `Artifact path escapes source root: ${candidate || '<empty>'}.`, candidate || undefined);
  }
  return candidate;
}

function validateIdentity(identity: RuntimePackagingIdentity): RuntimePackagingIdentity {
  for (const [field, value] of Object.entries(identity)) {
    if (typeof value !== 'string' || value.length === 0 || value.includes('\0') || /[\r\n]/.test(value)) {
      throw new RuntimePackagingError('INVALID_IDENTITY', `${field} must be a non-empty single-line string.`);
    }
  }
  return { ...identity };
}

function canonicalRoot(value: string, field: 'sourceRoot' | 'runtimeTarget'): string {
  if (typeof value !== 'string' || !isAbsolute(value) || value.includes('\0')) {
    throw new RuntimePackagingError('INVALID_ROOT', `${field} must be an absolute path.`);
  }
  return resolve(value);
}

function normalizeRuntimeText(bytes: Buffer, artifactPath: string): string {
  let text: string;
  try {
    text = utf8.decode(bytes);
  } catch {
    throw new RuntimePackagingError('INVALID_UTF8', `Artifact is not valid UTF-8: ${artifactPath}.`, artifactPath);
  }
  if (text.startsWith('\uFEFF')) text = text.slice(1);
  text = text.replace(/\r\n?/g, '\n');
  text = text.replace(/^\/\/# sourceMappingURL=.*(?:\n|$)/gm, '');
  return text.replace(/\r\n?/g, '\n');
}

function classifyArtifact(path: string): 'runtime' | RuntimeArtifactExclusionReason | 'unsupported' {
  const lower = path.toLowerCase();
  if (lower.endsWith('.d.ts') || lower.endsWith('.d.mts') || lower.endsWith('.d.cts')) return 'type-only';
  if (lower.endsWith('.map') || lower.endsWith('.js.map') || lower.endsWith('.mjs.map') || lower.endsWith('.cjs.map')) return 'source-map';
  if (lower.endsWith('.js') || lower.endsWith('.mjs') || lower.endsWith('.cjs')) return 'runtime';
  return 'unsupported';
}

function isTypeOnlyRuntimeModule(content: string): boolean {
  const withoutComments = content
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .trim();
  return withoutComments === 'export {};';
}

function readRuntimeArtifact(absolutePath: string, path: string): RuntimeArtifact {
  let bytes: Buffer;
  try {
    bytes = readFileSync(absolutePath);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new RuntimePackagingError('READ_FAILED', `Unable to read runtime artifact ${path}: ${detail}`, path);
  }
  const content = normalizeRuntimeText(bytes, path);
  return {
    path,
    content,
    byte_length: Buffer.byteLength(content, 'utf8'),
    content_sha256: createHash('sha256').update(content, 'utf8').digest('hex'),
  };
}

export function inspectRuntimeArtifacts(input: RuntimePackagingInput): RuntimePackagingPlan {
  const sourceRoot = canonicalRoot(input.sourceRoot, 'sourceRoot');
  const runtimeTarget = canonicalRoot(input.runtimeTarget, 'runtimeTarget');
  if (sourceRoot === runtimeTarget) throw new RuntimePackagingError('PATH_CONFLICT', 'sourceRoot and runtimeTarget must be different paths.');
  let sourceStat;
  try {
    sourceStat = lstatSync(sourceRoot);
  } catch {
    throw new RuntimePackagingError('INVALID_ROOT', `sourceRoot does not exist: ${sourceRoot}.`);
  }
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) throw new RuntimePackagingError('INVALID_ROOT', `sourceRoot must be a real directory: ${sourceRoot}.`);
  const identity = validateIdentity(input.identity);
  const artifacts: RuntimeArtifact[] = [];
  const excluded: RuntimeArtifactExclusion[] = [];
  const seen = new Map<string, string>();

  const visit = (directory: string): void => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true }).sort((left, right) => compareStable(left.name, right.name));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new RuntimePackagingError('READ_FAILED', `Unable to enumerate source directory ${directory}: ${detail}.`);
    }
    for (const entry of entries) {
      const absolutePath = join(directory, entry.name);
      const artifactPath = normalizeRelativeArtifactPath(sourceRoot, absolutePath);
      if (entry.isSymbolicLink()) {
        excluded.push({ path: artifactPath, reason: 'symlink' });
        continue;
      }
      if (entry.isDirectory()) {
        visit(absolutePath);
        continue;
      }
      if (!entry.isFile()) throw new RuntimePackagingError('UNSUPPORTED_ARTIFACT', `Unsupported non-file artifact: ${artifactPath}.`, artifactPath);
      const kind = classifyArtifact(artifactPath);
      if (kind === 'type-only' || kind === 'source-map') {
        excluded.push({ path: artifactPath, reason: kind });
        continue;
      }
      if (kind === 'unsupported') throw new RuntimePackagingError('UNSUPPORTED_ARTIFACT', `Unsupported runtime artifact: ${artifactPath}.`, artifactPath);
      const identityKey = artifactPath.normalize('NFKC').toLowerCase();
      const prior = seen.get(identityKey);
      if (prior) throw new RuntimePackagingError('DUPLICATE_ARTIFACT', `Artifacts collide on Windows path identity: ${prior} and ${artifactPath}.`, artifactPath);
      seen.set(identityKey, artifactPath);
      const artifact = readRuntimeArtifact(absolutePath, artifactPath);
      if (isTypeOnlyRuntimeModule(artifact.content)) {
        excluded.push({ path: artifactPath, reason: 'type-only' });
        continue;
      }
      artifacts.push(artifact);
    }
  };
  visit(sourceRoot);
  artifacts.sort((left, right) => compareStable(left.path, right.path));
  excluded.sort((left, right) => compareStable(left.path, right.path));
  const manifest: RuntimeArtifactManifest = {
    schema_version: 1,
    package_name: identity.packageName,
    package_version: identity.packageVersion,
    source_revision: identity.sourceRevision,
    generator_version: identity.generatorVersion,
    artifacts: artifacts.map(({ path, byte_length, content_sha256 }) => ({ path, byte_length, content_sha256 })),
    excluded,
  };
  const manifest_json = JSON.stringify(manifest);
  return {
    schema_version: 1,
    source_root: sourceRoot,
    runtime_target: runtimeTarget,
    identity,
    artifacts,
    excluded,
    manifest,
    manifest_json,
    manifest_sha256: createHash('sha256').update(manifest_json, 'utf8').digest('hex'),
  };
}

export function createPackagingReceiptInput(plan: RuntimePackagingPlan): RuntimePackagingReceiptInput {
  return {
    schema_version: 1,
    package_name: plan.manifest.package_name,
    package_version: plan.manifest.package_version,
    source_revision: plan.manifest.source_revision,
    generator_version: plan.manifest.generator_version,
    manifest_sha256: plan.manifest_sha256,
    manifest: plan.manifest,
    source: { status: 'selected' },
    bundled: { status: 'not_run' },
    installed: { status: 'not_run' },
    native_effectiveness: 'not_run',
  };
}

function stableJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function pathInside(root: string, candidate: string): boolean {
  const rootRelative = relative(root, candidate);
  return rootRelative === '' || (!isAbsolute(rootRelative) && rootRelative !== '..' && !rootRelative.startsWith('../') && !rootRelative.startsWith('..\\'));
}

function canonicalMetadataPath(value: string | undefined, root: string, defaultName: string): string {
  const candidate = canonicalRoot(value ?? join(root, defaultName), 'runtimeTarget');
  if (!pathInside(root, candidate) || candidate === root) {
    throw new RuntimePackagingError('PATH_CONFLICT', `Metadata path must be inside runtimeRoot: ${candidate}.`);
  }
  return candidate;
}

function compareManifestArtifacts(left: RuntimeArtifactManifestEntry[], right: RuntimeArtifactManifestEntry[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Verify source/runtime parity at the packaging interface boundary. */
export function verifyRuntimeParity(source: RuntimePackagingPlan, bundled: RuntimePackagingPlan): void {
  const sameIdentity = source.manifest.package_name === bundled.manifest.package_name
    && source.manifest.package_version === bundled.manifest.package_version
    && source.manifest.source_revision === bundled.manifest.source_revision
    && source.manifest.generator_version === bundled.manifest.generator_version;
  if (!sameIdentity || !compareManifestArtifacts(source.manifest.artifacts, bundled.manifest.artifacts) || bundled.manifest.excluded.length !== 0) {
    throw new RuntimePackagingError('PARITY_FAILED', 'Source and bundled runtime manifests differ.');
  }
}

function createIntegrity(plan: RuntimePackagingPlan, generatorVersion: string, runtimePrefix: string): RuntimePackagingIntegrity {
  const files: Record<string, string> = {};
  for (const artifact of plan.artifacts) files[`${runtimePrefix}/${artifact.path}`] = artifact.content_sha256;
  return {
    schema_version: 1,
    generated_by: generatorVersion,
    package_name: plan.manifest.package_name,
    package_version: plan.manifest.package_version,
    source_revision: plan.manifest.source_revision,
    manifest_sha256: plan.manifest_sha256,
    files,
  };
}

function readIntegrity(value: string, path: string): RuntimePackagingIntegrity {
  try {
    const parsed = JSON.parse(value) as Partial<RuntimePackagingIntegrity>;
    if (parsed.schema_version !== 1 || typeof parsed.generated_by !== 'string' || typeof parsed.package_name !== 'string' || typeof parsed.package_version !== 'string' || typeof parsed.source_revision !== 'string' || typeof parsed.manifest_sha256 !== 'string' || !parsed.files || typeof parsed.files !== 'object' || Array.isArray(parsed.files)) throw new Error('invalid integrity shape');
    return parsed as RuntimePackagingIntegrity;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new RuntimePackagingError('INTEGRITY_FAILED', `Invalid integrity metadata ${path}: ${detail}.`, path);
  }
}

function materializePlan(plan: RuntimePackagingPlan, stageTarget: string): void {
  try {
    mkdirSync(stageTarget, { recursive: true });
    for (const artifact of plan.artifacts) {
      const destination = join(stageTarget, ...artifact.path.split('/'));
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, artifact.content, 'utf8');
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new RuntimePackagingError('MATERIALIZE_FAILED', `Unable to materialize runtime: ${detail}.`);
  }
}

function replaceDirectoryAtomically(stagingRoot: string, runtimeRoot: string): string | undefined {
  const backupRoot = `${runtimeRoot}.previous-${randomUUID()}`;
  let movedPrevious = false;
  try {
    if (lstatSync(runtimeRoot, { throwIfNoEntry: false })) {
      renameSync(runtimeRoot, backupRoot);
      movedPrevious = true;
    }
    renameSync(stagingRoot, runtimeRoot);
    return movedPrevious ? backupRoot : undefined;
  } catch (error) {
    try {
      if (lstatSync(runtimeRoot, { throwIfNoEntry: false })) rmSync(runtimeRoot, { recursive: true, force: true });
      if (movedPrevious && lstatSync(backupRoot, { throwIfNoEntry: false })) renameSync(backupRoot, runtimeRoot);
      if (lstatSync(stagingRoot, { throwIfNoEntry: false })) rmSync(stagingRoot, { recursive: true, force: true });
    } catch {
      // Preserve the original failure; the caller receives a fail-closed error.
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new RuntimePackagingError('ATOMIC_REPLACE_FAILED', `Unable to atomically replace runtime bundle: ${detail}.`);
  }
}

/**
 * Build, materialize, verify and publish one runtime bundle.
 *
 * The caller supplies only the source and destination identities plus an
 * optional build hook. All generated metadata is deterministic and excludes
 * host paths and timestamps, which makes the receipt safe to compare across
 * Windows machines.
 */
export function runRuntimePackaging(input: RuntimePackagingPipelineInput): RuntimePackagingPipelineResult {
  const runtimeTarget = canonicalRoot(input.runtimeTarget, 'runtimeTarget');
  const runtimeRoot = canonicalRoot(input.runtimeRoot ?? dirname(runtimeTarget), 'runtimeTarget');
  if (!pathInside(runtimeRoot, runtimeTarget) || runtimeTarget === runtimeRoot) throw new RuntimePackagingError('PATH_CONFLICT', 'runtimeTarget must be a child of runtimeRoot.');
  const sourceRoot = canonicalRoot(input.sourceRoot, 'sourceRoot');
  if (pathInside(sourceRoot, runtimeRoot) || pathInside(runtimeRoot, sourceRoot)) throw new RuntimePackagingError('PATH_CONFLICT', 'sourceRoot and runtimeRoot must be separate trees.');
  const integrityTarget = canonicalMetadataPath(input.integrityTarget, runtimeRoot, 'integrity.json');
  const receiptTarget = canonicalMetadataPath(input.receiptTarget, runtimeRoot, 'packaging-receipt.json');
  const manifestTarget = join(runtimeRoot, 'manifest.json');
  if (pathInside(runtimeTarget, integrityTarget) || pathInside(runtimeTarget, receiptTarget) || integrityTarget === receiptTarget || manifestTarget === integrityTarget || manifestTarget === receiptTarget) throw new RuntimePackagingError('PATH_CONFLICT', 'Runtime metadata must be separate from runtime modules and each other.');

  try {
    input.buildSource?.();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new RuntimePackagingError('BUILD_FAILED', `Source build failed: ${detail}.`);
  }

  const plan = inspectRuntimeArtifacts({ sourceRoot, runtimeTarget, identity: input.identity });
  const parent = dirname(runtimeRoot);
  const stagingRoot = join(parent, `.${runtimeRoot.split(/[\\/]/).at(-1) ?? 'runtime'}.staging-${randomUUID()}`);
  const stageTarget = join(stagingRoot, relative(runtimeRoot, runtimeTarget));
  const stageIntegrity = join(stagingRoot, relative(runtimeRoot, integrityTarget));
  const stageReceipt = join(stagingRoot, relative(runtimeRoot, receiptTarget));
  let backupRoot: string | undefined;
  let published = false;

  try {
    mkdirSync(stagingRoot, { recursive: true });
    materializePlan(plan, stageTarget);
    const bundledBeforeMetadata = inspectRuntimeArtifacts({ sourceRoot: stageTarget, runtimeTarget: join(stagingRoot, '.parity-target'), identity: input.identity });
    verifyRuntimeParity(plan, bundledBeforeMetadata);
    const runtimePrefix = relative(runtimeRoot, runtimeTarget).replaceAll('\\', '/');
    const integrity = createIntegrity(plan, input.identity.generatorVersion, runtimePrefix);
    const integrityJson = stableJson(integrity);
    const integritySha = createHash('sha256').update(integrityJson, 'utf8').digest('hex');
    const manifestPath = join(stagingRoot, 'manifest.json');
    mkdirSync(dirname(stageIntegrity), { recursive: true });
    writeFileSync(manifestPath, plan.manifest_json, 'utf8');
    writeFileSync(stageIntegrity, integrityJson, 'utf8');
    const receipt: RuntimePackagingPipelineReceipt = {
      schema_version: 1,
      package_name: plan.manifest.package_name,
      package_version: plan.manifest.package_version,
      source_revision: plan.manifest.source_revision,
      generator_version: plan.manifest.generator_version,
      manifest_sha256: plan.manifest_sha256,
      integrity_sha256: integritySha,
      source: { status: 'built', manifest_sha256: plan.manifest_sha256 },
      bundled: { status: 'verified', manifest_sha256: plan.manifest_sha256, integrity_sha256: integritySha },
      installed: { status: 'not_run' },
      native_effectiveness: 'not_run',
    };
    mkdirSync(dirname(stageReceipt), { recursive: true });
    writeFileSync(stageReceipt, stableJson(receipt), 'utf8');
    const readBackIntegrity = readIntegrity(readFileSync(stageIntegrity, 'utf8'), integrityTarget);
    if (JSON.stringify(readBackIntegrity) !== JSON.stringify(integrity)) throw new RuntimePackagingError('INTEGRITY_FAILED', 'Integrity metadata changed while staging.');
    if (readFileSync(manifestPath, 'utf8') !== plan.manifest_json) throw new RuntimePackagingError('INTEGRITY_FAILED', 'Runtime manifest changed while staging.');
    const readBackReceipt = JSON.parse(readFileSync(stageReceipt, 'utf8')) as RuntimePackagingPipelineReceipt;
    if (JSON.stringify(readBackReceipt) !== JSON.stringify(receipt)) throw new RuntimePackagingError('INTEGRITY_FAILED', 'Packaging receipt changed while staging.');
    backupRoot = replaceDirectoryAtomically(stagingRoot, runtimeRoot);
    published = true;
    const finalBundled = inspectRuntimeArtifacts({ sourceRoot: resolve(runtimeTarget), runtimeTarget: join(runtimeRoot, '.parity-target'), identity: input.identity });
    verifyRuntimeParity(plan, finalBundled);
    const finalIntegrity = readIntegrity(readFileSync(integrityTarget, 'utf8'), integrityTarget);
    if (JSON.stringify(finalIntegrity) !== JSON.stringify(integrity)) throw new RuntimePackagingError('INTEGRITY_FAILED', 'Published integrity metadata does not match the staged artifact.');
    if (readFileSync(manifestTarget, 'utf8') !== plan.manifest_json) throw new RuntimePackagingError('INTEGRITY_FAILED', 'Published runtime manifest does not match the staged artifact.');
    const finalReceipt = JSON.parse(readFileSync(receiptTarget, 'utf8')) as RuntimePackagingPipelineReceipt;
    if (JSON.stringify(finalReceipt) !== JSON.stringify(receipt)) throw new RuntimePackagingError('INTEGRITY_FAILED', 'Published packaging receipt does not match the staged artifact.');
    if (backupRoot) rmSync(backupRoot, { recursive: true, force: true });
    return { plan, bundled: finalBundled, integrity, receipt };
  } catch (error) {
    if (lstatSync(stagingRoot, { throwIfNoEntry: false })) rmSync(stagingRoot, { recursive: true, force: true });
    if (backupRoot && lstatSync(backupRoot, { throwIfNoEntry: false })) {
      if (lstatSync(runtimeRoot, { throwIfNoEntry: false })) rmSync(runtimeRoot, { recursive: true, force: true });
      renameSync(backupRoot, runtimeRoot);
    } else if (published && lstatSync(runtimeRoot, { throwIfNoEntry: false })) {
      rmSync(runtimeRoot, { recursive: true, force: true });
    }
    if (error instanceof RuntimePackagingError) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    throw new RuntimePackagingError('MATERIALIZE_FAILED', `Runtime packaging failed: ${detail}.`);
  }
}
