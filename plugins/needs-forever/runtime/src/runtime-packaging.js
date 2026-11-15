import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
export class RuntimePackagingError extends Error {
    code;
    artifactPath;
    constructor(code, message, artifactPath) {
        super(message);
        this.name = 'RuntimePackagingError';
        this.code = code;
        this.artifactPath = artifactPath;
    }
}
const utf8 = new TextDecoder('utf-8', { fatal: true });
function compareStable(left, right) {
    return left < right ? -1 : left > right ? 1 : 0;
}
function normalizeRelativeArtifactPath(sourceRoot, absolutePath) {
    const candidate = relative(sourceRoot, absolutePath).replaceAll('\\', '/');
    const segments = candidate.split('/');
    if (!candidate || isAbsolute(candidate) || candidate === '..' || candidate.startsWith('../') || segments.some((segment) => !segment || segment === '.' || segment === '..')) {
        throw new RuntimePackagingError('INVALID_ARTIFACT_PATH', `Artifact path escapes source root: ${candidate || '<empty>'}.`, candidate || undefined);
    }
    return candidate;
}
function validateIdentity(identity) {
    for (const [field, value] of Object.entries(identity)) {
        if (typeof value !== 'string' || value.length === 0 || value.includes('\0') || /[\r\n]/.test(value)) {
            throw new RuntimePackagingError('INVALID_IDENTITY', `${field} must be a non-empty single-line string.`);
        }
    }
    return { ...identity };
}
function canonicalRoot(value, field) {
    if (typeof value !== 'string' || !isAbsolute(value) || value.includes('\0')) {
        throw new RuntimePackagingError('INVALID_ROOT', `${field} must be an absolute path.`);
    }
    return resolve(value);
}
function normalizeRuntimeText(bytes, artifactPath) {
    let text;
    try {
        text = utf8.decode(bytes);
    }
    catch {
        throw new RuntimePackagingError('INVALID_UTF8', `Artifact is not valid UTF-8: ${artifactPath}.`, artifactPath);
    }
    if (text.startsWith('\uFEFF'))
        text = text.slice(1);
    text = text.replace(/\r\n?/g, '\n');
    text = text.replace(/^\/\/# sourceMappingURL=.*(?:\n|$)/gm, '');
    return text.replace(/\r\n?/g, '\n');
}
function classifyArtifact(path) {
    const lower = path.toLowerCase();
    if (lower.endsWith('.d.ts') || lower.endsWith('.d.mts') || lower.endsWith('.d.cts'))
        return 'type-only';
    if (lower.endsWith('.map') || lower.endsWith('.js.map') || lower.endsWith('.mjs.map') || lower.endsWith('.cjs.map'))
        return 'source-map';
    if (lower.endsWith('.js') || lower.endsWith('.mjs') || lower.endsWith('.cjs'))
        return 'runtime';
    return 'unsupported';
}
function isTypeOnlyRuntimeModule(content) {
    const withoutComments = content
        .replace(/^\s*\/\/.*$/gm, '')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .trim();
    return withoutComments === 'export {};';
}
function readRuntimeArtifact(absolutePath, path) {
    let bytes;
    try {
        bytes = readFileSync(absolutePath);
    }
    catch (error) {
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
export function inspectRuntimeArtifacts(input) {
    const sourceRoot = canonicalRoot(input.sourceRoot, 'sourceRoot');
    const runtimeTarget = canonicalRoot(input.runtimeTarget, 'runtimeTarget');
    if (sourceRoot === runtimeTarget)
        throw new RuntimePackagingError('PATH_CONFLICT', 'sourceRoot and runtimeTarget must be different paths.');
    let sourceStat;
    try {
        sourceStat = lstatSync(sourceRoot);
    }
    catch {
        throw new RuntimePackagingError('INVALID_ROOT', `sourceRoot does not exist: ${sourceRoot}.`);
    }
    if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink())
        throw new RuntimePackagingError('INVALID_ROOT', `sourceRoot must be a real directory: ${sourceRoot}.`);
    const identity = validateIdentity(input.identity);
    const artifacts = [];
    const excluded = [];
    const seen = new Map();
    const visit = (directory) => {
        let entries;
        try {
            entries = readdirSync(directory, { withFileTypes: true }).sort((left, right) => compareStable(left.name, right.name));
        }
        catch (error) {
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
            if (!entry.isFile())
                throw new RuntimePackagingError('UNSUPPORTED_ARTIFACT', `Unsupported non-file artifact: ${artifactPath}.`, artifactPath);
            const kind = classifyArtifact(artifactPath);
            if (kind === 'type-only' || kind === 'source-map') {
                excluded.push({ path: artifactPath, reason: kind });
                continue;
            }
            if (kind === 'unsupported')
                throw new RuntimePackagingError('UNSUPPORTED_ARTIFACT', `Unsupported runtime artifact: ${artifactPath}.`, artifactPath);
            const identityKey = artifactPath.normalize('NFKC').toLowerCase();
            const prior = seen.get(identityKey);
            if (prior)
                throw new RuntimePackagingError('DUPLICATE_ARTIFACT', `Artifacts collide on Windows path identity: ${prior} and ${artifactPath}.`, artifactPath);
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
    const manifest = {
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
export function createPackagingReceiptInput(plan) {
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
function stableJson(value) {
    return `${JSON.stringify(value, null, 2)}\n`;
}
function pathInside(root, candidate) {
    const rootRelative = relative(root, candidate);
    return rootRelative === '' || (!isAbsolute(rootRelative) && rootRelative !== '..' && !rootRelative.startsWith('../') && !rootRelative.startsWith('..\\'));
}
function canonicalMetadataPath(value, root, defaultName) {
    const candidate = canonicalRoot(value ?? join(root, defaultName), 'runtimeTarget');
    if (!pathInside(root, candidate) || candidate === root) {
        throw new RuntimePackagingError('PATH_CONFLICT', `Metadata path must be inside runtimeRoot: ${candidate}.`);
    }
    return candidate;
}
function compareManifestArtifacts(left, right) {
    return JSON.stringify(left) === JSON.stringify(right);
}
/** Verify source/runtime parity at the packaging interface boundary. */
export function verifyRuntimeParity(source, bundled) {
    const sameIdentity = source.manifest.package_name === bundled.manifest.package_name
        && source.manifest.package_version === bundled.manifest.package_version
        && source.manifest.source_revision === bundled.manifest.source_revision
        && source.manifest.generator_version === bundled.manifest.generator_version;
    if (!sameIdentity || !compareManifestArtifacts(source.manifest.artifacts, bundled.manifest.artifacts) || bundled.manifest.excluded.length !== 0) {
        throw new RuntimePackagingError('PARITY_FAILED', 'Source and bundled runtime manifests differ.');
    }
}
function createIntegrity(plan, generatorVersion, runtimePrefix) {
    const files = {};
    for (const artifact of plan.artifacts)
        files[`${runtimePrefix}/${artifact.path}`] = artifact.content_sha256;
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
function readIntegrity(value, path) {
    try {
        const parsed = JSON.parse(value);
        if (parsed.schema_version !== 1 || typeof parsed.generated_by !== 'string' || typeof parsed.package_name !== 'string' || typeof parsed.package_version !== 'string' || typeof parsed.source_revision !== 'string' || typeof parsed.manifest_sha256 !== 'string' || !parsed.files || typeof parsed.files !== 'object' || Array.isArray(parsed.files))
            throw new Error('invalid integrity shape');
        return parsed;
    }
    catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new RuntimePackagingError('INTEGRITY_FAILED', `Invalid integrity metadata ${path}: ${detail}.`, path);
    }
}
function materializePlan(plan, stageTarget) {
    try {
        mkdirSync(stageTarget, { recursive: true });
        for (const artifact of plan.artifacts) {
            const destination = join(stageTarget, ...artifact.path.split('/'));
            mkdirSync(dirname(destination), { recursive: true });
            writeFileSync(destination, artifact.content, 'utf8');
        }
    }
    catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new RuntimePackagingError('MATERIALIZE_FAILED', `Unable to materialize runtime: ${detail}.`);
    }
}
function replaceDirectoryAtomically(stagingRoot, runtimeRoot) {
    const backupRoot = `${runtimeRoot}.previous-${randomUUID()}`;
    let movedPrevious = false;
    try {
        if (lstatSync(runtimeRoot, { throwIfNoEntry: false })) {
            renameSync(runtimeRoot, backupRoot);
            movedPrevious = true;
        }
        renameSync(stagingRoot, runtimeRoot);
        return movedPrevious ? backupRoot : undefined;
    }
    catch (error) {
        try {
            if (lstatSync(runtimeRoot, { throwIfNoEntry: false }))
                rmSync(runtimeRoot, { recursive: true, force: true });
            if (movedPrevious && lstatSync(backupRoot, { throwIfNoEntry: false }))
                renameSync(backupRoot, runtimeRoot);
            if (lstatSync(stagingRoot, { throwIfNoEntry: false }))
                rmSync(stagingRoot, { recursive: true, force: true });
        }
        catch {
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
export function runRuntimePackaging(input) {
    const runtimeTarget = canonicalRoot(input.runtimeTarget, 'runtimeTarget');
    const runtimeRoot = canonicalRoot(input.runtimeRoot ?? dirname(runtimeTarget), 'runtimeTarget');
    if (!pathInside(runtimeRoot, runtimeTarget) || runtimeTarget === runtimeRoot)
        throw new RuntimePackagingError('PATH_CONFLICT', 'runtimeTarget must be a child of runtimeRoot.');
    const sourceRoot = canonicalRoot(input.sourceRoot, 'sourceRoot');
    if (pathInside(sourceRoot, runtimeRoot) || pathInside(runtimeRoot, sourceRoot))
        throw new RuntimePackagingError('PATH_CONFLICT', 'sourceRoot and runtimeRoot must be separate trees.');
    const integrityTarget = canonicalMetadataPath(input.integrityTarget, runtimeRoot, 'integrity.json');
    const receiptTarget = canonicalMetadataPath(input.receiptTarget, runtimeRoot, 'packaging-receipt.json');
    const manifestTarget = join(runtimeRoot, 'manifest.json');
    if (pathInside(runtimeTarget, integrityTarget) || pathInside(runtimeTarget, receiptTarget) || integrityTarget === receiptTarget || manifestTarget === integrityTarget || manifestTarget === receiptTarget)
        throw new RuntimePackagingError('PATH_CONFLICT', 'Runtime metadata must be separate from runtime modules and each other.');
    try {
        input.buildSource?.();
    }
    catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new RuntimePackagingError('BUILD_FAILED', `Source build failed: ${detail}.`);
    }
    const plan = inspectRuntimeArtifacts({ sourceRoot, runtimeTarget, identity: input.identity });
    const parent = dirname(runtimeRoot);
    const stagingRoot = join(parent, `.${runtimeRoot.split(/[\\/]/).at(-1) ?? 'runtime'}.staging-${randomUUID()}`);
    const stageTarget = join(stagingRoot, relative(runtimeRoot, runtimeTarget));
    const stageIntegrity = join(stagingRoot, relative(runtimeRoot, integrityTarget));
    const stageReceipt = join(stagingRoot, relative(runtimeRoot, receiptTarget));
    let backupRoot;
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
        const receipt = {
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
        if (JSON.stringify(readBackIntegrity) !== JSON.stringify(integrity))
            throw new RuntimePackagingError('INTEGRITY_FAILED', 'Integrity metadata changed while staging.');
        if (readFileSync(manifestPath, 'utf8') !== plan.manifest_json)
            throw new RuntimePackagingError('INTEGRITY_FAILED', 'Runtime manifest changed while staging.');
        const readBackReceipt = JSON.parse(readFileSync(stageReceipt, 'utf8'));
        if (JSON.stringify(readBackReceipt) !== JSON.stringify(receipt))
            throw new RuntimePackagingError('INTEGRITY_FAILED', 'Packaging receipt changed while staging.');
        backupRoot = replaceDirectoryAtomically(stagingRoot, runtimeRoot);
        published = true;
        const finalBundled = inspectRuntimeArtifacts({ sourceRoot: resolve(runtimeTarget), runtimeTarget: join(runtimeRoot, '.parity-target'), identity: input.identity });
        verifyRuntimeParity(plan, finalBundled);
        const finalIntegrity = readIntegrity(readFileSync(integrityTarget, 'utf8'), integrityTarget);
        if (JSON.stringify(finalIntegrity) !== JSON.stringify(integrity))
            throw new RuntimePackagingError('INTEGRITY_FAILED', 'Published integrity metadata does not match the staged artifact.');
        if (readFileSync(manifestTarget, 'utf8') !== plan.manifest_json)
            throw new RuntimePackagingError('INTEGRITY_FAILED', 'Published runtime manifest does not match the staged artifact.');
        const finalReceipt = JSON.parse(readFileSync(receiptTarget, 'utf8'));
        if (JSON.stringify(finalReceipt) !== JSON.stringify(receipt))
            throw new RuntimePackagingError('INTEGRITY_FAILED', 'Published packaging receipt does not match the staged artifact.');
        if (backupRoot)
            rmSync(backupRoot, { recursive: true, force: true });
        return { plan, bundled: finalBundled, integrity, receipt };
    }
    catch (error) {
        if (lstatSync(stagingRoot, { throwIfNoEntry: false }))
            rmSync(stagingRoot, { recursive: true, force: true });
        if (backupRoot && lstatSync(backupRoot, { throwIfNoEntry: false })) {
            if (lstatSync(runtimeRoot, { throwIfNoEntry: false }))
                rmSync(runtimeRoot, { recursive: true, force: true });
            renameSync(backupRoot, runtimeRoot);
        }
        else if (published && lstatSync(runtimeRoot, { throwIfNoEntry: false })) {
            rmSync(runtimeRoot, { recursive: true, force: true });
        }
        if (error instanceof RuntimePackagingError)
            throw error;
        const detail = error instanceof Error ? error.message : String(error);
        throw new RuntimePackagingError('MATERIALIZE_FAILED', `Runtime packaging failed: ${detail}.`);
    }
}
function verificationIssue(code, message, path) {
    return path === undefined ? { code, message } : { code, message, path };
}
function asVerificationError(error, fallbackCode = 'READ_FAILED') {
    if (error instanceof RuntimePackagingError)
        return verificationIssue(error.code, error.message, error.artifactPath);
    return verificationIssue(fallbackCode, error instanceof Error ? error.message : String(error));
}
function canonicalVerificationRoot(value, label) {
    const root = canonicalRoot(value, label === 'bundledPluginRoot' || label === 'installedPluginRoot' ? 'sourceRoot' : 'runtimeTarget');
    let stat;
    try {
        stat = lstatSync(root);
    }
    catch (error) {
        throw new RuntimePackagingError('READ_FAILED', `${label} is not readable: ${root}.`);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new RuntimePackagingError('READ_FAILED', `${label} must be a real directory: ${root}.`);
    return root;
}
function decodeVerificationText(bytes, path) {
    let text;
    try {
        text = utf8.decode(bytes);
    }
    catch {
        throw new RuntimePackagingError('INVALID_UTF8', `File is not valid UTF-8: ${path}.`, path);
    }
    if (text.startsWith('\uFEFF'))
        throw new RuntimePackagingError('INTEGRITY_FAILED', `File contains a UTF-8 BOM: ${path}.`, path);
    if (text.includes('\r'))
        throw new RuntimePackagingError('INTEGRITY_FAILED', `File contains non-canonical CRLF/CR line endings: ${path}.`, path);
    return text;
}
function readVerificationFile(path, label) {
    let stat;
    try {
        stat = lstatSync(path);
    }
    catch {
        throw new RuntimePackagingError('READ_FAILED', `${label} is missing: ${path}.`, path);
    }
    if (stat.isSymbolicLink())
        throw new RuntimePackagingError('READ_FAILED', `${label} must not be a symbolic link: ${path}.`, path);
    if (!stat.isFile())
        throw new RuntimePackagingError('READ_FAILED', `${label} must be a regular file: ${path}.`, path);
    let bytes;
    try {
        bytes = readFileSync(path);
    }
    catch (error) {
        throw new RuntimePackagingError('READ_FAILED', `Unable to read ${label}: ${path}.`, path);
    }
    return { bytes, text: decodeVerificationText(bytes, path) };
}
function parseVerificationJson(path, label) {
    const file = readVerificationFile(path, label);
    try {
        return { ...file, value: JSON.parse(file.text) };
    }
    catch (error) {
        throw new RuntimePackagingError('INTEGRITY_FAILED', `Invalid JSON in ${label}: ${error instanceof Error ? error.message : String(error)}.`, path);
    }
}
function assertVerificationString(value, field, path) {
    if (typeof value !== 'string' || value.length === 0 || value.includes('\0') || /[\r\n]/.test(value))
        throw new RuntimePackagingError('INTEGRITY_FAILED', `${field} must be a non-empty single-line string.`, path);
}
function assertVerificationHash(value, field, path) {
    assertVerificationString(value, field, path);
    if (!/^[0-9a-f]{64}$/.test(value))
        throw new RuntimePackagingError('INTEGRITY_FAILED', `${field} must be a lowercase SHA-256 hex digest.`, path);
}
function validateVerificationRelativePath(value, field, path) {
    assertVerificationString(value, field, path);
    const candidate = value.replaceAll('\\', '/');
    const segments = candidate.split('/');
    if (candidate !== value || isAbsolute(candidate) || candidate === '.' || candidate === '..' || candidate.startsWith('../') || segments.some((segment) => !segment || segment === '.' || segment === '..')) {
        throw new RuntimePackagingError('INTEGRITY_FAILED', `${field} must be a stable relative path: ${value}.`, path);
    }
    return candidate;
}
function readPackagingMetadata(input, bundledRuntimeRoot) {
    const receiptPath = resolve(input.receiptPath ?? join(bundledRuntimeRoot, 'packaging-receipt.json'));
    const manifestPath = resolve(input.manifestPath ?? join(bundledRuntimeRoot, 'manifest.json'));
    const integrityPath = resolve(input.integrityPath ?? join(bundledRuntimeRoot, 'integrity.json'));
    for (const [label, path] of [['receipt', receiptPath], ['manifest', manifestPath], ['integrity', integrityPath]]) {
        if (!pathInside(bundledRuntimeRoot, path))
            throw new RuntimePackagingError('PATH_CONFLICT', `${label} path escapes bundled runtime root: ${path}.`, path);
    }
    const parsedReceipt = parseVerificationJson(receiptPath, 'packaging receipt');
    const parsedManifest = parseVerificationJson(manifestPath, 'runtime manifest');
    const parsedIntegrity = parseVerificationJson(integrityPath, 'runtime integrity');
    const receipt = parsedReceipt.value;
    const manifest = parsedManifest.value;
    const integrity = parsedIntegrity.value;
    if (receipt.schema_version !== 1 || receipt.source?.status !== 'built' || receipt.bundled?.status !== 'verified' || receipt.installed?.status !== 'not_run' || receipt.native_effectiveness !== 'not_run')
        throw new RuntimePackagingError('INTEGRITY_FAILED', 'Packaging receipt is not a successful bundled receipt.', receiptPath);
    for (const [field, value] of Object.entries({ package_name: receipt.package_name, package_version: receipt.package_version, source_revision: receipt.source_revision, generator_version: receipt.generator_version, manifest_sha256: receipt.manifest_sha256, integrity_sha256: receipt.integrity_sha256 })) {
        if (field.endsWith('_sha256'))
            assertVerificationHash(value, `receipt.${field}`, receiptPath);
        else
            assertVerificationString(value, `receipt.${field}`, receiptPath);
    }
    if (receipt.source.manifest_sha256 !== receipt.manifest_sha256 || receipt.bundled.manifest_sha256 !== receipt.manifest_sha256 || receipt.bundled.integrity_sha256 !== receipt.integrity_sha256)
        throw new RuntimePackagingError('INTEGRITY_FAILED', 'Packaging receipt references inconsistent metadata digests.', receiptPath);
    if (manifest.schema_version !== 1 || !Array.isArray(manifest.artifacts) || !Array.isArray(manifest.excluded))
        throw new RuntimePackagingError('INTEGRITY_FAILED', 'Runtime manifest has an invalid shape.', manifestPath);
    for (const field of ['package_name', 'package_version', 'source_revision', 'generator_version'])
        assertVerificationString(manifest[field], `manifest.${field}`, manifestPath);
    if (manifest.artifacts.some((entry) => !entry || typeof entry !== 'object'))
        throw new RuntimePackagingError('INTEGRITY_FAILED', 'Runtime manifest contains an invalid artifact entry.', manifestPath);
    const artifactFiles = new Map();
    const artifactIdentities = new Map();
    for (const rawEntry of manifest.artifacts) {
        const entry = rawEntry;
        const artifactPath = validateVerificationRelativePath(entry.path, 'manifest.artifacts[].path', manifestPath);
        if (!Number.isInteger(entry.byte_length) || entry.byte_length < 0)
            throw new RuntimePackagingError('INTEGRITY_FAILED', `Invalid byte length for ${artifactPath}.`, manifestPath);
        assertVerificationHash(entry.content_sha256, `manifest.artifacts[${artifactPath}].content_sha256`, manifestPath);
        if (artifactFiles.has(artifactPath))
            throw new RuntimePackagingError('INTEGRITY_FAILED', `Duplicate manifest artifact: ${artifactPath}.`, manifestPath);
        const identityKey = artifactPath.normalize('NFKC').toLowerCase();
        if (artifactIdentities.has(identityKey))
            throw new RuntimePackagingError('INTEGRITY_FAILED', `Manifest artifacts collide on Windows path identity: ${artifactIdentities.get(identityKey)} and ${artifactPath}.`, manifestPath);
        artifactIdentities.set(identityKey, artifactPath);
        artifactFiles.set(artifactPath, { path: artifactPath, byte_length: entry.byte_length, content_sha256: entry.content_sha256 });
    }
    const excludedIdentities = new Set();
    for (const rawExcluded of manifest.excluded) {
        if (!rawExcluded || typeof rawExcluded !== 'object')
            throw new RuntimePackagingError('INTEGRITY_FAILED', 'Runtime manifest contains an invalid exclusion entry.', manifestPath);
        const excluded = rawExcluded;
        const excludedPath = validateVerificationRelativePath(excluded.path, 'manifest.excluded[].path', manifestPath);
        if (excluded.reason !== 'type-only' && excluded.reason !== 'source-map' && excluded.reason !== 'symlink')
            throw new RuntimePackagingError('INTEGRITY_FAILED', `Invalid exclusion reason for ${excludedPath}.`, manifestPath);
        const identityKey = excludedPath.normalize('NFKC').toLowerCase();
        if (excludedIdentities.has(identityKey))
            throw new RuntimePackagingError('INTEGRITY_FAILED', `Duplicate manifest exclusion: ${excludedPath}.`, manifestPath);
        if (artifactIdentities.has(identityKey))
            throw new RuntimePackagingError('INTEGRITY_FAILED', `Manifest path is both included and excluded: ${excludedPath}.`, manifestPath);
        excludedIdentities.add(identityKey);
    }
    if (integrity.schema_version !== 1 || !integrity.files || typeof integrity.files !== 'object' || Array.isArray(integrity.files))
        throw new RuntimePackagingError('INTEGRITY_FAILED', 'Runtime integrity has an invalid shape.', integrityPath);
    for (const field of ['generated_by', 'package_name', 'package_version', 'source_revision', 'manifest_sha256'])
        assertVerificationString(integrity[field], `integrity.${field}`, integrityPath);
    assertVerificationHash(integrity.manifest_sha256, 'integrity.manifest_sha256', integrityPath);
    for (const [artifactPath, hash] of Object.entries(integrity.files)) {
        validateVerificationRelativePath(artifactPath, `integrity.files[${artifactPath}].path`, integrityPath);
        assertVerificationHash(hash, `integrity.files[${artifactPath}]`, integrityPath);
    }
    const identities = [
        ['package_name', receipt.package_name, manifest.package_name],
        ['package_version', receipt.package_version, manifest.package_version],
        ['source_revision', receipt.source_revision, manifest.source_revision],
        ['generator_version', receipt.generator_version, manifest.generator_version],
    ];
    for (const [field, expected, actual] of identities)
        if (expected !== actual)
            throw new RuntimePackagingError('INTEGRITY_FAILED', `Packaging metadata ${field} differs between receipt and manifest.`, manifestPath);
    if (integrity.package_name !== receipt.package_name || integrity.package_version !== receipt.package_version || integrity.source_revision !== receipt.source_revision || integrity.generated_by !== receipt.generator_version)
        throw new RuntimePackagingError('INTEGRITY_FAILED', 'Packaging metadata differs between receipt and integrity.', integrityPath);
    const manifestSha = createHash('sha256').update(parsedManifest.bytes).digest('hex');
    const integritySha = createHash('sha256').update(parsedIntegrity.bytes).digest('hex');
    if (manifestSha !== receipt.manifest_sha256 || integritySha !== receipt.integrity_sha256 || integrity.manifest_sha256 !== receipt.manifest_sha256)
        throw new RuntimePackagingError('INTEGRITY_FAILED', 'Packaging metadata digest does not match the receipt.', bundledRuntimeRoot);
    const keys = Object.keys(integrity.files).sort(compareStable);
    const prefixes = artifactFiles.size === 0 ? [] : [...artifactFiles.values()].map((entry) => {
        const suffix = `/${entry.path}`;
        const matches = keys.filter((key) => key === entry.path || key.endsWith(suffix));
        if (matches.length !== 1)
            throw new RuntimePackagingError('INTEGRITY_FAILED', `Integrity metadata does not map exactly one file to ${entry.path}.`, integrityPath);
        const key = matches[0];
        return key === entry.path ? '' : key.slice(0, -suffix.length);
    });
    const runtimePrefix = prefixes.length === 0 ? '' : prefixes[0];
    if (prefixes.some((prefix) => prefix !== runtimePrefix) || keys.length !== artifactFiles.size)
        throw new RuntimePackagingError('INTEGRITY_FAILED', 'Integrity file set does not match the runtime manifest.', integrityPath);
    for (const entry of artifactFiles.values()) {
        const key = runtimePrefix ? `${runtimePrefix}/${entry.path}` : entry.path;
        if (integrity.files[key] !== entry.content_sha256)
            throw new RuntimePackagingError('INTEGRITY_FAILED', `Manifest and integrity hash differ for ${entry.path}.`, integrityPath);
    }
    return { receipt: receipt, manifest: manifest, integrity: integrity, manifestBytes: parsedManifest.bytes, integrityBytes: parsedIntegrity.bytes, receiptBytes: parsedReceipt.bytes, runtimePrefix, artifactFiles };
}
function listVerificationTree(root) {
    const files = [];
    const directories = [];
    const errors = [];
    const visit = (directory, relativeDirectory) => {
        let entries;
        try {
            entries = readdirSync(directory, { withFileTypes: true }).sort((left, right) => compareStable(left.name, right.name));
        }
        catch (error) {
            errors.push(verificationIssue('READ_FAILED', `Unable to enumerate installed runtime directory: ${error instanceof Error ? error.message : String(error)}.`, directory));
            return;
        }
        for (const entry of entries) {
            const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
            const absolutePath = join(directory, entry.name);
            let stat;
            try {
                stat = lstatSync(absolutePath);
            }
            catch {
                errors.push(verificationIssue('READ_FAILED', `Unable to inspect installed runtime entry: ${relativePath}.`, absolutePath));
                continue;
            }
            if (stat.isSymbolicLink()) {
                errors.push(verificationIssue('SYMLINK', `Installed runtime contains a symbolic link: ${relativePath}.`, absolutePath));
            }
            else if (stat.isDirectory()) {
                directories.push(relativePath);
                visit(absolutePath, relativePath);
            }
            else if (stat.isFile()) {
                files.push(relativePath);
            }
            else {
                errors.push(verificationIssue('READ_FAILED', `Installed runtime contains an unsupported entry: ${relativePath}.`, absolutePath));
            }
        }
    };
    visit(root, '');
    return { files: files.sort(compareStable), directories: directories.sort(compareStable), errors };
}
function verifyRuntimeTree(root, metadata, label) {
    const errors = [];
    let canonicalRootPath;
    try {
        canonicalRootPath = canonicalVerificationRoot(root, `${label}RuntimeRoot`);
    }
    catch (error) {
        return { artifactCount: 0, errors: [asVerificationError(error)] };
    }
    const tree = listVerificationTree(canonicalRootPath);
    errors.push(...tree.errors);
    const expectedArtifacts = [...metadata.artifactFiles.values()].map((entry) => metadata.runtimePrefix ? `${metadata.runtimePrefix}/${entry.path}` : entry.path);
    const expectedFiles = [...expectedArtifacts, 'manifest.json', 'integrity.json', 'packaging-receipt.json'].sort(compareStable);
    const expectedSet = new Set(expectedFiles);
    const actualSet = new Set(tree.files);
    for (const expected of expectedFiles)
        if (!actualSet.has(expected))
            errors.push(verificationIssue('MISSING_FILE', `${label} runtime is missing ${expected}.`, join(canonicalRootPath, ...expected.split('/'))));
    for (const actual of tree.files)
        if (!expectedSet.has(actual))
            errors.push(verificationIssue('EXTRA_FILE', `${label} runtime contains unexpected file ${actual}.`, join(canonicalRootPath, ...actual.split('/'))));
    const expectedDirectories = new Set();
    for (const file of expectedFiles) {
        const segments = file.split('/');
        for (let index = 1; index < segments.length; index += 1)
            expectedDirectories.add(segments.slice(0, index).join('/'));
    }
    for (const actual of tree.directories)
        if (!expectedDirectories.has(actual))
            errors.push(verificationIssue('EXTRA_PATH', `${label} runtime contains unexpected directory ${actual}.`, join(canonicalRootPath, ...actual.split('/'))));
    const expectedMetadata = new Map([
        ['manifest.json', metadata.manifestBytes],
        ['integrity.json', metadata.integrityBytes],
        ['packaging-receipt.json', metadata.receiptBytes],
    ]);
    for (const [relativePath, expectedBytes] of expectedMetadata) {
        if (!actualSet.has(relativePath))
            continue;
        try {
            const actual = readVerificationFile(join(canonicalRootPath, ...relativePath.split('/')), `${label} ${relativePath}`);
            if (!actual.bytes.equals(expectedBytes))
                errors.push(verificationIssue('HASH_MISMATCH', `${label} ${relativePath} differs from the packaging receipt artifact.`, join(canonicalRootPath, ...relativePath.split('/'))));
        }
        catch (error) {
            errors.push(asVerificationError(error));
        }
    }
    for (const [artifactPath, entry] of metadata.artifactFiles) {
        const relativePath = metadata.runtimePrefix ? `${metadata.runtimePrefix}/${artifactPath}` : artifactPath;
        const absolutePath = join(canonicalRootPath, ...relativePath.split('/'));
        if (!actualSet.has(relativePath))
            continue;
        try {
            const actual = readVerificationFile(absolutePath, `${label} runtime artifact ${relativePath}`);
            const hash = createHash('sha256').update(actual.bytes).digest('hex');
            const integrityKey = relativePath;
            if (actual.bytes.byteLength !== entry.byte_length || hash !== entry.content_sha256 || hash !== metadata.integrity.files[integrityKey])
                errors.push(verificationIssue('HASH_MISMATCH', `${label} runtime artifact ${relativePath} differs from the manifest/integrity hash.`, absolutePath));
        }
        catch (error) {
            errors.push(asVerificationError(error));
        }
    }
    return { artifactCount: metadata.artifactFiles.size, errors };
}
function verifyPluginMetadata(root, metadata, label) {
    const errors = [];
    let name = null;
    let version = null;
    try {
        const plugin = parseVerificationJson(join(root, '.codex-plugin', 'plugin.json'), `${label} plugin metadata`);
        const packageJson = parseVerificationJson(join(root, 'package.json'), `${label} package metadata`);
        name = typeof plugin.value.name === 'string' ? plugin.value.name : null;
        version = typeof plugin.value.version === 'string' ? plugin.value.version : null;
        if (plugin.value.name !== metadata.receipt.package_name)
            errors.push(verificationIssue('VERSION_MISMATCH', `${label} plugin name does not match the packaging receipt.`, join(root, '.codex-plugin', 'plugin.json')));
        if (plugin.value.version !== metadata.receipt.package_version || packageJson.value.version !== metadata.receipt.package_version)
            errors.push(verificationIssue('VERSION_MISMATCH', `${label} plugin version does not match the packaging receipt.`, join(root, '.codex-plugin', 'plugin.json')));
        return { status: errors.length === 0 ? 'verified' : 'failed', name, version, pluginBytes: plugin.bytes, packageBytes: packageJson.bytes, errors };
    }
    catch (error) {
        errors.push(asVerificationError(error));
    }
    return { status: 'failed', name, version, errors };
}
/** Verify an installed plugin against the exact runtime packaging receipt that produced it. */
export function verifyInstalledRuntime(input) {
    const verifiedAt = (() => {
        try {
            const value = input.now?.() ?? new Date();
            return value.toISOString();
        }
        catch {
            return new Date().toISOString();
        }
    })();
    let bundledPluginRoot = '';
    let installedPluginRoot = '';
    const errors = [];
    let metadata;
    let installedArtifactCount = 0;
    let sourceStatus = 'not_run';
    let bundledStatus = 'not_run';
    let installedStatus = 'not_run';
    let pluginMetadataStatus = 'not_run';
    let packageName = null;
    let packageVersion = null;
    let sourceRevision = null;
    let generatorVersion = null;
    let manifestSha256 = null;
    let integritySha256 = null;
    let pluginName = null;
    let pluginVersion = null;
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
        if (bundledMetadata.pluginBytes && installedMetadata.pluginBytes && !bundledMetadata.pluginBytes.equals(installedMetadata.pluginBytes))
            errors.push(verificationIssue('PARITY_FAILED', 'Installed plugin metadata differs from the bundled plugin metadata.', join(installedPluginRoot, '.codex-plugin', 'plugin.json')));
        if (bundledMetadata.packageBytes && installedMetadata.packageBytes && !bundledMetadata.packageBytes.equals(installedMetadata.packageBytes))
            errors.push(verificationIssue('PARITY_FAILED', 'Installed package metadata differs from the bundled package metadata.', join(installedPluginRoot, 'package.json')));
        pluginMetadataStatus = bundledMetadata.errors.length === 0 && installedMetadata.errors.length === 0 ? 'verified' : 'failed';
        pluginName = installedMetadata.name ?? bundledMetadata.name;
        pluginVersion = installedMetadata.version ?? bundledMetadata.version;
    }
    catch (error) {
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
