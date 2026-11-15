import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
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
            artifacts.push(readRuntimeArtifact(absolutePath, artifactPath));
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
