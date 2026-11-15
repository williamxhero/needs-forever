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

export interface RuntimeInstalledVerificationInput {
  /** Plugin root containing the runtime produced by the packaging pipeline. */
  bundledPluginRoot: string;
  /** Plugin root returned by the host after installation. */
  installedPluginRoot: string;
  /** Override the generated receipt location for callers with a staged package. */
  receiptPath?: string;
  /** Override the generated manifest location for callers with a staged package. */
  manifestPath?: string;
  /** Override the generated integrity location for callers with a staged package. */
  integrityPath?: string;
  /** Optional clock injection keeps receipts deterministic in interface tests. */
  now?: () => Date;
}

export interface RuntimeVerificationIssue {
  code: string;
  message: string;
  path?: string;
}

export interface RuntimeInstalledVerificationReceipt {
  schema_version: 1;
  verification_status: 'passed' | 'failed';
  ok: boolean;
  package_name: string | null;
  package_version: string | null;
  source_revision: string | null;
  generator_version: string | null;
  manifest_sha256: string | null;
  integrity_sha256: string | null;
  installed_path: string;
  source: { status: 'built' | 'failed' | 'not_run'; manifest_sha256: string | null };
  bundled: { status: 'verified' | 'failed' | 'not_run'; manifest_sha256: string | null; integrity_sha256: string | null };
  installed: {
    status: 'verified' | 'failed' | 'not_run';
    path: string;
    manifest_sha256: string | null;
    integrity_sha256: string | null;
    file_count: number;
  };
  plugin_metadata: {
    status: 'verified' | 'failed' | 'not_run';
    name: string | null;
    version: string | null;
  };
  verified_at: string;
  native_effectiveness: 'not_run';
  errors: RuntimeVerificationIssue[];
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

interface ParsedPackagingMetadata {
  receipt: RuntimePackagingPipelineReceipt;
  manifest: RuntimeArtifactManifest;
  integrity: RuntimePackagingIntegrity;
  manifestBytes: Buffer;
  integrityBytes: Buffer;
  receiptBytes: Buffer;
  runtimePrefix: string;
  artifactFiles: Map<string, RuntimeArtifactManifestEntry>;
}

interface RuntimeTreeVerification {
  artifactCount: number;
  errors: RuntimeVerificationIssue[];
}

function verificationIssue(code: string, message: string, path?: string): RuntimeVerificationIssue {
  return path === undefined ? { code, message } : { code, message, path };
}

function asVerificationError(error: unknown, fallbackCode = 'READ_FAILED'): RuntimeVerificationIssue {
  if (error instanceof RuntimePackagingError) return verificationIssue(error.code, error.message, error.artifactPath);
  return verificationIssue(fallbackCode, error instanceof Error ? error.message : String(error));
}

function canonicalVerificationRoot(value: string, label: string): string {
  const root = canonicalRoot(value, label === 'bundledPluginRoot' || label === 'installedPluginRoot' ? 'sourceRoot' : 'runtimeTarget');
  let stat;
  try {
    stat = lstatSync(root);
  } catch (error) {
    throw new RuntimePackagingError('READ_FAILED', `${label} is not readable: ${root}.`);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new RuntimePackagingError('READ_FAILED', `${label} must be a real directory: ${root}.`);
  return root;
}

function decodeVerificationText(bytes: Buffer, path: string): string {
  let text: string;
  try {
    text = utf8.decode(bytes);
  } catch {
    throw new RuntimePackagingError('INVALID_UTF8', `File is not valid UTF-8: ${path}.`, path);
  }
  if (text.startsWith('\uFEFF')) throw new RuntimePackagingError('INTEGRITY_FAILED', `File contains a UTF-8 BOM: ${path}.`, path);
  if (text.includes('\r')) throw new RuntimePackagingError('INTEGRITY_FAILED', `File contains non-canonical CRLF/CR line endings: ${path}.`, path);
  return text;
}

function readVerificationFile(path: string, label: string): { bytes: Buffer; text: string } {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    throw new RuntimePackagingError('READ_FAILED', `${label} is missing: ${path}.`, path);
  }
  if (stat.isSymbolicLink()) throw new RuntimePackagingError('READ_FAILED', `${label} must not be a symbolic link: ${path}.`, path);
  if (!stat.isFile()) throw new RuntimePackagingError('READ_FAILED', `${label} must be a regular file: ${path}.`, path);
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (error) {
    throw new RuntimePackagingError('READ_FAILED', `Unable to read ${label}: ${path}.`, path);
  }
  return { bytes, text: decodeVerificationText(bytes, path) };
}

function parseVerificationJson<T>(path: string, label: string): { value: T; bytes: Buffer; text: string } {
  const file = readVerificationFile(path, label);
  try {
    return { ...file, value: JSON.parse(file.text) as T };
  } catch (error) {
    throw new RuntimePackagingError('INTEGRITY_FAILED', `Invalid JSON in ${label}: ${error instanceof Error ? error.message : String(error)}.`, path);
  }
}

function assertVerificationString(value: unknown, field: string, path: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0') || /[\r\n]/.test(value)) throw new RuntimePackagingError('INTEGRITY_FAILED', `${field} must be a non-empty single-line string.`, path);
}

function assertVerificationHash(value: unknown, field: string, path: string): asserts value is string {
  assertVerificationString(value, field, path);
  if (!/^[0-9a-f]{64}$/.test(value)) throw new RuntimePackagingError('INTEGRITY_FAILED', `${field} must be a lowercase SHA-256 hex digest.`, path);
}

function validateVerificationRelativePath(value: unknown, field: string, path: string): string {
  assertVerificationString(value, field, path);
  const candidate = value.replaceAll('\\', '/');
  const segments = candidate.split('/');
  if (candidate !== value || isAbsolute(candidate) || candidate === '.' || candidate === '..' || candidate.startsWith('../') || segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new RuntimePackagingError('INTEGRITY_FAILED', `${field} must be a stable relative path: ${value}.`, path);
  }
  return candidate;
}

function readPackagingMetadata(input: RuntimeInstalledVerificationInput, bundledRuntimeRoot: string): ParsedPackagingMetadata {
  const receiptPath = resolve(input.receiptPath ?? join(bundledRuntimeRoot, 'packaging-receipt.json'));
  const manifestPath = resolve(input.manifestPath ?? join(bundledRuntimeRoot, 'manifest.json'));
  const integrityPath = resolve(input.integrityPath ?? join(bundledRuntimeRoot, 'integrity.json'));
  for (const [label, path] of [['receipt', receiptPath], ['manifest', manifestPath], ['integrity', integrityPath]] as const) {
    if (!pathInside(bundledRuntimeRoot, path)) throw new RuntimePackagingError('PATH_CONFLICT', `${label} path escapes bundled runtime root: ${path}.`, path);
  }
  const parsedReceipt = parseVerificationJson<Partial<RuntimePackagingPipelineReceipt>>(receiptPath, 'packaging receipt');
  const parsedManifest = parseVerificationJson<Partial<RuntimeArtifactManifest>>(manifestPath, 'runtime manifest');
  const parsedIntegrity = parseVerificationJson<Partial<RuntimePackagingIntegrity>>(integrityPath, 'runtime integrity');
  const receipt = parsedReceipt.value;
  const manifest = parsedManifest.value;
  const integrity = parsedIntegrity.value;
  if (receipt.schema_version !== 1 || receipt.source?.status !== 'built' || receipt.bundled?.status !== 'verified' || receipt.installed?.status !== 'not_run' || receipt.native_effectiveness !== 'not_run') throw new RuntimePackagingError('INTEGRITY_FAILED', 'Packaging receipt is not a successful bundled receipt.', receiptPath);
  for (const [field, value] of Object.entries({ package_name: receipt.package_name, package_version: receipt.package_version, source_revision: receipt.source_revision, generator_version: receipt.generator_version, manifest_sha256: receipt.manifest_sha256, integrity_sha256: receipt.integrity_sha256 })) {
    if (field.endsWith('_sha256')) assertVerificationHash(value, `receipt.${field}`, receiptPath);
    else assertVerificationString(value, `receipt.${field}`, receiptPath);
  }
  if (receipt.source.manifest_sha256 !== receipt.manifest_sha256 || receipt.bundled.manifest_sha256 !== receipt.manifest_sha256 || receipt.bundled.integrity_sha256 !== receipt.integrity_sha256) throw new RuntimePackagingError('INTEGRITY_FAILED', 'Packaging receipt references inconsistent metadata digests.', receiptPath);
  if (manifest.schema_version !== 1 || !Array.isArray(manifest.artifacts) || !Array.isArray(manifest.excluded)) throw new RuntimePackagingError('INTEGRITY_FAILED', 'Runtime manifest has an invalid shape.', manifestPath);
  for (const field of ['package_name', 'package_version', 'source_revision', 'generator_version'] as const) assertVerificationString(manifest[field], `manifest.${field}`, manifestPath);
  if (manifest.artifacts.some((entry) => !entry || typeof entry !== 'object')) throw new RuntimePackagingError('INTEGRITY_FAILED', 'Runtime manifest contains an invalid artifact entry.', manifestPath);
  const artifactFiles = new Map<string, RuntimeArtifactManifestEntry>();
  const artifactIdentities = new Map<string, string>();
  for (const rawEntry of manifest.artifacts) {
    const entry = rawEntry as Partial<RuntimeArtifactManifestEntry>;
    const artifactPath = validateVerificationRelativePath(entry.path, 'manifest.artifacts[].path', manifestPath);
    if (!Number.isInteger(entry.byte_length) || (entry.byte_length as number) < 0) throw new RuntimePackagingError('INTEGRITY_FAILED', `Invalid byte length for ${artifactPath}.`, manifestPath);
    assertVerificationHash(entry.content_sha256, `manifest.artifacts[${artifactPath}].content_sha256`, manifestPath);
    if (artifactFiles.has(artifactPath)) throw new RuntimePackagingError('INTEGRITY_FAILED', `Duplicate manifest artifact: ${artifactPath}.`, manifestPath);
    const identityKey = artifactPath.normalize('NFKC').toLowerCase();
    if (artifactIdentities.has(identityKey)) throw new RuntimePackagingError('INTEGRITY_FAILED', `Manifest artifacts collide on Windows path identity: ${artifactIdentities.get(identityKey)} and ${artifactPath}.`, manifestPath);
    artifactIdentities.set(identityKey, artifactPath);
    artifactFiles.set(artifactPath, { path: artifactPath, byte_length: entry.byte_length as number, content_sha256: entry.content_sha256 });
  }
  const excludedIdentities = new Set<string>();
  for (const rawExcluded of manifest.excluded) {
    if (!rawExcluded || typeof rawExcluded !== 'object') throw new RuntimePackagingError('INTEGRITY_FAILED', 'Runtime manifest contains an invalid exclusion entry.', manifestPath);
    const excluded = rawExcluded as Partial<RuntimeArtifactExclusion>;
    const excludedPath = validateVerificationRelativePath(excluded.path, 'manifest.excluded[].path', manifestPath);
    if (excluded.reason !== 'type-only' && excluded.reason !== 'source-map' && excluded.reason !== 'symlink') throw new RuntimePackagingError('INTEGRITY_FAILED', `Invalid exclusion reason for ${excludedPath}.`, manifestPath);
    const identityKey = excludedPath.normalize('NFKC').toLowerCase();
    if (excludedIdentities.has(identityKey)) throw new RuntimePackagingError('INTEGRITY_FAILED', `Duplicate manifest exclusion: ${excludedPath}.`, manifestPath);
    if (artifactIdentities.has(identityKey)) throw new RuntimePackagingError('INTEGRITY_FAILED', `Manifest path is both included and excluded: ${excludedPath}.`, manifestPath);
    excludedIdentities.add(identityKey);
  }
  if (integrity.schema_version !== 1 || !integrity.files || typeof integrity.files !== 'object' || Array.isArray(integrity.files)) throw new RuntimePackagingError('INTEGRITY_FAILED', 'Runtime integrity has an invalid shape.', integrityPath);
  for (const field of ['generated_by', 'package_name', 'package_version', 'source_revision', 'manifest_sha256'] as const) assertVerificationString(integrity[field], `integrity.${field}`, integrityPath);
  assertVerificationHash(integrity.manifest_sha256, 'integrity.manifest_sha256', integrityPath);
  for (const [artifactPath, hash] of Object.entries(integrity.files)) {
    validateVerificationRelativePath(artifactPath, `integrity.files[${artifactPath}].path`, integrityPath);
    assertVerificationHash(hash, `integrity.files[${artifactPath}]`, integrityPath);
  }
  const identities: Array<[string, unknown, unknown]> = [
    ['package_name', receipt.package_name, manifest.package_name],
    ['package_version', receipt.package_version, manifest.package_version],
    ['source_revision', receipt.source_revision, manifest.source_revision],
    ['generator_version', receipt.generator_version, manifest.generator_version],
  ];
  for (const [field, expected, actual] of identities) if (expected !== actual) throw new RuntimePackagingError('INTEGRITY_FAILED', `Packaging metadata ${field} differs between receipt and manifest.`, manifestPath);
  if (integrity.package_name !== receipt.package_name || integrity.package_version !== receipt.package_version || integrity.source_revision !== receipt.source_revision || integrity.generated_by !== receipt.generator_version) throw new RuntimePackagingError('INTEGRITY_FAILED', 'Packaging metadata differs between receipt and integrity.', integrityPath);
  const manifestSha = createHash('sha256').update(parsedManifest.bytes).digest('hex');
  const integritySha = createHash('sha256').update(parsedIntegrity.bytes).digest('hex');
  if (manifestSha !== receipt.manifest_sha256 || integritySha !== receipt.integrity_sha256 || integrity.manifest_sha256 !== receipt.manifest_sha256) throw new RuntimePackagingError('INTEGRITY_FAILED', 'Packaging metadata digest does not match the receipt.', bundledRuntimeRoot);
  const keys = Object.keys(integrity.files).sort(compareStable);
  const prefixes = artifactFiles.size === 0 ? [] : [...artifactFiles.values()].map((entry) => {
    const suffix = `/${entry.path}`;
    const matches = keys.filter((key) => key === entry.path || key.endsWith(suffix));
    if (matches.length !== 1) throw new RuntimePackagingError('INTEGRITY_FAILED', `Integrity metadata does not map exactly one file to ${entry.path}.`, integrityPath);
    const key = matches[0]!;
    return key === entry.path ? '' : key.slice(0, -suffix.length);
  });
  const runtimePrefix = prefixes.length === 0 ? '' : prefixes[0]!;
  if (prefixes.some((prefix) => prefix !== runtimePrefix) || keys.length !== artifactFiles.size) throw new RuntimePackagingError('INTEGRITY_FAILED', 'Integrity file set does not match the runtime manifest.', integrityPath);
  for (const entry of artifactFiles.values()) {
    const key = runtimePrefix ? `${runtimePrefix}/${entry.path}` : entry.path;
    if (integrity.files[key] !== entry.content_sha256) throw new RuntimePackagingError('INTEGRITY_FAILED', `Manifest and integrity hash differ for ${entry.path}.`, integrityPath);
  }
  return { receipt: receipt as RuntimePackagingPipelineReceipt, manifest: manifest as RuntimeArtifactManifest, integrity: integrity as RuntimePackagingIntegrity, manifestBytes: parsedManifest.bytes, integrityBytes: parsedIntegrity.bytes, receiptBytes: parsedReceipt.bytes, runtimePrefix, artifactFiles };
}

function listVerificationTree(root: string): { files: string[]; directories: string[]; errors: RuntimeVerificationIssue[] } {
  const files: string[] = [];
  const directories: string[] = [];
  const errors: RuntimeVerificationIssue[] = [];
  const visit = (directory: string, relativeDirectory: string): void => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true }).sort((left, right) => compareStable(left.name, right.name));
    } catch (error) {
      errors.push(verificationIssue('READ_FAILED', `Unable to enumerate installed runtime directory: ${error instanceof Error ? error.message : String(error)}.`, directory));
      return;
    }
    for (const entry of entries) {
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      const absolutePath = join(directory, entry.name);
      let stat;
      try {
        stat = lstatSync(absolutePath);
      } catch {
        errors.push(verificationIssue('READ_FAILED', `Unable to inspect installed runtime entry: ${relativePath}.`, absolutePath));
        continue;
      }
      if (stat.isSymbolicLink()) {
        errors.push(verificationIssue('SYMLINK', `Installed runtime contains a symbolic link: ${relativePath}.`, absolutePath));
      } else if (stat.isDirectory()) {
        directories.push(relativePath);
        visit(absolutePath, relativePath);
      } else if (stat.isFile()) {
        files.push(relativePath);
      } else {
        errors.push(verificationIssue('READ_FAILED', `Installed runtime contains an unsupported entry: ${relativePath}.`, absolutePath));
      }
    }
  };
  visit(root, '');
  return { files: files.sort(compareStable), directories: directories.sort(compareStable), errors };
}

function verifyRuntimeTree(root: string, metadata: ParsedPackagingMetadata, label: string): RuntimeTreeVerification {
  const errors: RuntimeVerificationIssue[] = [];
  let canonicalRootPath: string;
  try {
    canonicalRootPath = canonicalVerificationRoot(root, `${label}RuntimeRoot`);
  } catch (error) {
    return { artifactCount: 0, errors: [asVerificationError(error)] };
  }
  const tree = listVerificationTree(canonicalRootPath);
  errors.push(...tree.errors);
  const expectedArtifacts = [...metadata.artifactFiles.values()].map((entry) => metadata.runtimePrefix ? `${metadata.runtimePrefix}/${entry.path}` : entry.path);
  const expectedFiles = [...expectedArtifacts, 'manifest.json', 'integrity.json', 'packaging-receipt.json'].sort(compareStable);
  const expectedSet = new Set(expectedFiles);
  const actualSet = new Set(tree.files);
  for (const expected of expectedFiles) if (!actualSet.has(expected)) errors.push(verificationIssue('MISSING_FILE', `${label} runtime is missing ${expected}.`, join(canonicalRootPath, ...expected.split('/'))));
  for (const actual of tree.files) if (!expectedSet.has(actual)) errors.push(verificationIssue('EXTRA_FILE', `${label} runtime contains unexpected file ${actual}.`, join(canonicalRootPath, ...actual.split('/'))));
  const expectedDirectories = new Set<string>();
  for (const file of expectedFiles) {
    const segments = file.split('/');
    for (let index = 1; index < segments.length; index += 1) expectedDirectories.add(segments.slice(0, index).join('/'));
  }
  for (const actual of tree.directories) if (!expectedDirectories.has(actual)) errors.push(verificationIssue('EXTRA_PATH', `${label} runtime contains unexpected directory ${actual}.`, join(canonicalRootPath, ...actual.split('/'))));
  const expectedMetadata = new Map<string, Buffer>([
    ['manifest.json', metadata.manifestBytes],
    ['integrity.json', metadata.integrityBytes],
    ['packaging-receipt.json', metadata.receiptBytes],
  ]);
  for (const [relativePath, expectedBytes] of expectedMetadata) {
    if (!actualSet.has(relativePath)) continue;
    try {
      const actual = readVerificationFile(join(canonicalRootPath, ...relativePath.split('/')), `${label} ${relativePath}`);
      if (!actual.bytes.equals(expectedBytes)) errors.push(verificationIssue('HASH_MISMATCH', `${label} ${relativePath} differs from the packaging receipt artifact.`, join(canonicalRootPath, ...relativePath.split('/'))));
    } catch (error) {
      errors.push(asVerificationError(error));
    }
  }
  for (const [artifactPath, entry] of metadata.artifactFiles) {
    const relativePath = metadata.runtimePrefix ? `${metadata.runtimePrefix}/${artifactPath}` : artifactPath;
    const absolutePath = join(canonicalRootPath, ...relativePath.split('/'));
    if (!actualSet.has(relativePath)) continue;
    try {
      const actual = readVerificationFile(absolutePath, `${label} runtime artifact ${relativePath}`);
      const hash = createHash('sha256').update(actual.bytes).digest('hex');
      const integrityKey = relativePath;
      if (actual.bytes.byteLength !== entry.byte_length || hash !== entry.content_sha256 || hash !== metadata.integrity.files[integrityKey]) errors.push(verificationIssue('HASH_MISMATCH', `${label} runtime artifact ${relativePath} differs from the manifest/integrity hash.`, absolutePath));
    } catch (error) {
      errors.push(asVerificationError(error));
    }
  }
  return { artifactCount: metadata.artifactFiles.size, errors };
}

function verifyPluginMetadata(root: string, metadata: ParsedPackagingMetadata, label: string): { status: 'verified' | 'failed'; name: string | null; version: string | null; pluginBytes?: Buffer; packageBytes?: Buffer; errors: RuntimeVerificationIssue[] } {
  const errors: RuntimeVerificationIssue[] = [];
  let name: string | null = null;
  let version: string | null = null;
  try {
    const plugin = parseVerificationJson<Partial<{ name: string; version: string }>>(join(root, '.codex-plugin', 'plugin.json'), `${label} plugin metadata`);
    const packageJson = parseVerificationJson<Partial<{ name: string; version: string }>>(join(root, 'package.json'), `${label} package metadata`);
    name = typeof plugin.value.name === 'string' ? plugin.value.name : null;
    version = typeof plugin.value.version === 'string' ? plugin.value.version : null;
    if (plugin.value.name !== metadata.receipt.package_name) errors.push(verificationIssue('VERSION_MISMATCH', `${label} plugin name does not match the packaging receipt.`, join(root, '.codex-plugin', 'plugin.json')));
    if (plugin.value.version !== metadata.receipt.package_version || packageJson.value.version !== metadata.receipt.package_version) errors.push(verificationIssue('VERSION_MISMATCH', `${label} plugin version does not match the packaging receipt.`, join(root, '.codex-plugin', 'plugin.json')));
    return { status: errors.length === 0 ? 'verified' : 'failed', name, version, pluginBytes: plugin.bytes, packageBytes: packageJson.bytes, errors };
  } catch (error) {
    errors.push(asVerificationError(error));
  }
  return { status: 'failed', name, version, errors };
}

/** Verify an installed plugin against the exact runtime packaging receipt that produced it. */
export function verifyInstalledRuntime(input: RuntimeInstalledVerificationInput): RuntimeInstalledVerificationReceipt {
  const verifiedAt = (() => {
    try {
      const value = input.now?.() ?? new Date();
      return value.toISOString();
    } catch {
      return new Date().toISOString();
    }
  })();
  let bundledPluginRoot = '';
  let installedPluginRoot = '';
  const errors: RuntimeVerificationIssue[] = [];
  let metadata: ParsedPackagingMetadata | undefined;
  let installedArtifactCount = 0;
  let sourceStatus: RuntimeInstalledVerificationReceipt['source']['status'] = 'not_run';
  let bundledStatus: RuntimeInstalledVerificationReceipt['bundled']['status'] = 'not_run';
  let installedStatus: RuntimeInstalledVerificationReceipt['installed']['status'] = 'not_run';
  let pluginMetadataStatus: RuntimeInstalledVerificationReceipt['plugin_metadata']['status'] = 'not_run';
  let packageName: string | null = null;
  let packageVersion: string | null = null;
  let sourceRevision: string | null = null;
  let generatorVersion: string | null = null;
  let manifestSha256: string | null = null;
  let integritySha256: string | null = null;
  let pluginName: string | null = null;
  let pluginVersion: string | null = null;
  try {
    bundledPluginRoot = canonicalVerificationRoot(input.bundledPluginRoot, 'bundledPluginRoot');
    installedPluginRoot = canonicalVerificationRoot(input.installedPluginRoot, 'installedPluginRoot');
    const bundledRuntimeRoot = join(bundledPluginRoot, 'runtime');
    metadata = readPackagingMetadata(input, canonicalVerificationRoot(bundledRuntimeRoot, 'bundledRuntimeRoot'));
    ({ package_name: packageName, package_version: packageVersion, source_revision: sourceRevision, generator_version: generatorVersion, manifest_sha256: manifestSha256, integrity_sha256: integritySha256 } = metadata.receipt);
    sourceStatus = 'built';
    const bundledTree = verifyRuntimeTree(bundledRuntimeRoot, metadata, 'bundled');
    const installedTree = verifyRuntimeTree(join(installedPluginRoot, 'runtime'), metadata, 'installed');
    errors.push(...bundledTree.errors, ...installedTree.errors);
    installedArtifactCount = installedTree.artifactCount;
    bundledStatus = bundledTree.errors.length === 0 ? 'verified' : 'failed';
    installedStatus = installedTree.errors.length === 0 ? 'verified' : 'failed';
    const bundledMetadata = verifyPluginMetadata(bundledPluginRoot, metadata, 'bundled');
    const installedMetadata = verifyPluginMetadata(installedPluginRoot, metadata, 'installed');
    errors.push(...bundledMetadata.errors, ...installedMetadata.errors);
    if (bundledMetadata.pluginBytes && installedMetadata.pluginBytes && !bundledMetadata.pluginBytes.equals(installedMetadata.pluginBytes)) errors.push(verificationIssue('PARITY_FAILED', 'Installed plugin metadata differs from the bundled plugin metadata.', join(installedPluginRoot, '.codex-plugin', 'plugin.json')));
    if (bundledMetadata.packageBytes && installedMetadata.packageBytes && !bundledMetadata.packageBytes.equals(installedMetadata.packageBytes)) errors.push(verificationIssue('PARITY_FAILED', 'Installed package metadata differs from the bundled package metadata.', join(installedPluginRoot, 'package.json')));
    pluginMetadataStatus = bundledMetadata.errors.length === 0 && installedMetadata.errors.length === 0 ? 'verified' : 'failed';
    pluginName = installedMetadata.name ?? bundledMetadata.name;
    pluginVersion = installedMetadata.version ?? bundledMetadata.version;
  } catch (error) {
    errors.push(asVerificationError(error));
    if (metadata) {
      packageName ??= metadata.receipt.package_name;
      packageVersion ??= metadata.receipt.package_version;
      sourceRevision ??= metadata.receipt.source_revision;
      generatorVersion ??= metadata.receipt.generator_version;
      manifestSha256 ??= metadata.receipt.manifest_sha256;
      integritySha256 ??= metadata.receipt.integrity_sha256;
    }
  }
  if (errors.length > 0) {
    sourceStatus = sourceStatus === 'not_run' ? 'failed' : sourceStatus;
    bundledStatus = bundledStatus === 'not_run' ? 'failed' : bundledStatus;
    installedStatus = installedStatus === 'not_run' ? 'failed' : installedStatus;
    pluginMetadataStatus = pluginMetadataStatus === 'not_run' ? 'failed' : pluginMetadataStatus;
  }
  return {
    schema_version: 1,
    verification_status: errors.length === 0 ? 'passed' : 'failed',
    ok: errors.length === 0,
    package_name: packageName,
    package_version: packageVersion,
    source_revision: sourceRevision,
    generator_version: generatorVersion,
    manifest_sha256: manifestSha256,
    integrity_sha256: integritySha256,
    installed_path: installedPluginRoot || (typeof input.installedPluginRoot === 'string' ? resolve(input.installedPluginRoot) : ''),
    source: { status: sourceStatus, manifest_sha256: manifestSha256 },
    bundled: { status: bundledStatus, manifest_sha256: manifestSha256, integrity_sha256: integritySha256 },
    installed: { status: installedStatus, path: installedPluginRoot || (typeof input.installedPluginRoot === 'string' ? resolve(input.installedPluginRoot) : ''), manifest_sha256: manifestSha256, integrity_sha256: integritySha256, file_count: installedArtifactCount },
    plugin_metadata: { status: pluginMetadataStatus, name: pluginName, version: pluginVersion },
    verified_at: verifiedAt,
    native_effectiveness: 'not_run',
    errors,
  };
}

/** Compatibility alias for callers that name the installed artifact explicitly. */
export const verifyInstalledArtifact = verifyInstalledRuntime;
