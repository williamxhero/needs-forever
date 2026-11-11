import { closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { activeRouteCatalog, RouteCatalog } from './route-catalog.js';
import { routeReadAuthorization } from './route-authorization.js';
import { routeEvidenceDigest } from './route-ledger.js';
import { snapshotRouteEvidence } from './planning-context.js';
import { redact } from './redact.js';
import type { RouteCatalogEntry, RouteEvidence } from './route-contract.js';
import type { Snapshot, State } from './types.js';

const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const exact = (value: Record<string, unknown>, fields: string[]) => Object.keys(value).length === fields.length && fields.every((field) => Object.hasOwn(value, field));
const safeText = (value: unknown, max = 160): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\x00-\x1f]/.test(value) && redact(value) === value;
const inside = (root: string, path: string) => { const suffix = relative(root, path); return suffix !== '' && !isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith(`..\\`) && !suffix.startsWith('../'); };

/** The task is prose, so this is deliberately conservative rather than a
 * general authorization interpreter. Recognized path/holdout exclusions are
 * enforced; an ambiguous read/access restriction cannot authorize a probe. */
export function artifactReadAuthorized(state: State, path: string): boolean {
  return routeReadAuthorization(state.task, path) === 'authorized';
}

/** A descriptor supplies a path, never availability or permission. B performs
 * this bounded read itself and records only the digest, never file contents. */
export function probeWorkspaceArtifact(state: State, path: string): RouteEvidence | null {
  if (!artifactReadAuthorized(state, path)) return null;
  if (!safeText(path, 512) || path.includes('\\') || isAbsolute(path)) return null;
  const parts = path.split('/');
  if (parts.length > 16 || parts.some((part) => !part || (part.startsWith('.') && !['.scratch', '.cache'].includes(part)) || /secret|credential|token|password|auth|cookie|private|\.pem$|\.key$/i.test(part))) return null;
  try {
    const root = realpathSync(state.task.workspace), target = resolve(root, ...parts);
    if (!inside(root, target)) return null;
    // Check every parent: a regular leaf below a symlink/junction is unsafe.
    for (let count = 1; count <= parts.length; count++) if (lstatSync(resolve(root, ...parts.slice(0, count))).isSymbolicLink()) return null;
    if (!inside(root, realpathSync(target))) return null;
    const stat = lstatSync(target);
    if (!stat.isFile()) return null;
    const fd = openSync(target, 'r');
    let digest: string;
    try {
      const opened = fstatSync(fd);
      if (!opened.isFile() || opened.ino !== stat.ino || opened.dev !== stat.dev) return null;
      const buffer = Buffer.alloc(Math.min(opened.size, 16_384));
      const count = readSync(fd, buffer, 0, buffer.length, 0);
      const after = lstatSync(target);
      if (!inside(root, realpathSync(target)) || after.isSymbolicLink() || after.ino !== opened.ino || after.dev !== opened.dev || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) return null;
      digest = routeEvidenceDigest({ path, size: opened.size, bytes_read: count, prefix_sha256: routeEvidenceDigest([...buffer.subarray(0, count)]) });
    } finally { closeSync(fd); }
    return { id: `artifact-probe:${digest}`, source: 'probe', reference: `workspace-file:${path}`, observed_at: new Date().toISOString(), task_version: state.task_version, content_sha256: digest };
  } catch { return null; }
}

function output(entry: Snapshot['evidence'][number]): unknown {
  const value = object(entry.value);
  if (entry.type === 'commandExecution') return value.aggregatedOutput;
  // Native PostToolUse already pairs the real request/result and lifecycle
  // identity. Only its response can carry hints; tool_input is never proof.
  if (entry.type === 'functionCallOutput' && value.hook_event_name === 'PostToolUse') {
    const response = value.tool_response;
    return typeof response === 'string' ? response : object(response).stdout ?? response;
  }
  return null;
}

/** Ingest at most four current tool-result hints. Facts are projected only from
 * B's supported independent probes; arbitrary stdout JSON cannot grant auth,
 * network, quota, capabilities, success or an observed provider status. */
export function ingestRouteObservations(state: State, snapshot: Snapshot): number {
  if (snapshot.task_id !== state.task_id || snapshot.task_version !== state.task_version || routeEvidenceDigest(snapshot.task) !== routeEvidenceDigest(redact(state.task)) || snapshot.worker_thread_id !== ((state as State & { main_session_id?: string }).main_session_id ?? state.worker_thread_id)) return 0;
  const catalog = new RouteCatalog({ task_id: state.task_id, task_version: state.task_version }, { data: activeRouteCatalog(state) });
  const proofs = snapshotRouteEvidence(snapshot);
  let accepted = 0, inspected = 0;
  for (const entry of snapshot.evidence.slice(0, 32)) {
    if (inspected >= 4) break;
    const proof = proofs.find((item) => item.id === entry.id);
    if (!proof || entry.source?.thread_id !== snapshot.worker_thread_id || (entry.source.turn_id && entry.source.turn_id !== snapshot.worker_turn_id) || Date.now() - Date.parse(proof.observed_at) > 600_000 || Date.parse(proof.observed_at) > Date.now() + 5_000) continue;
    let raw = output(entry);
    try {
      if (typeof raw === 'string') { if (raw.length > 8_000) continue; raw = JSON.parse(raw); }
      if (JSON.stringify(raw ?? null).length > 8_000 || JSON.stringify(redact(raw)) !== JSON.stringify(raw)) continue;
      const envelope = object(raw), inventory = object(envelope.nf_route_inventory);
      if (!exact(envelope, ['nf_route_inventory']) || !exact(inventory, ['schema_version', 'task_id', 'task_version', 'routes']) || inventory.schema_version !== 1 || inventory.task_id !== state.task_id || inventory.task_version !== state.task_version || !Array.isArray(inventory.routes) || inventory.routes.length > 4) continue;
      for (const item of inventory.routes) {
        if (inspected++ >= 4 || catalog.list().length >= 64) break;
        const hint = object(item), resource = object(hint.resource);
        if (!exact(hint, ['route_id', 'resource', 'operation']) || !exact(resource, ['kind', 'id']) || !safeText(hint.route_id) || !/^[\w:.-]+$/.test(hint.route_id) || !safeText(resource.id, 512) || !safeText(hint.operation) || !['artifact', 'command', 'provider', 'api'].includes(String(resource.kind))) continue;
        const prior = catalog.get(hint.route_id);
        if (prior && (prior.resource.kind !== resource.kind || prior.resource.id !== resource.id || prior.operation !== hint.operation)) continue;
        const sourceProof = { ...proof, id: `tool-observation:${routeEvidenceDigest({ reference: proof.reference, digest: proof.content_sha256 })}` };
        const candidate: RouteCatalogEntry = { route_id: hint.route_id, resource: { kind: resource.kind as RouteCatalogEntry['resource']['kind'], id: resource.id }, operation: hint.operation,
          status: 'candidate', authorization: { status: 'unknown', evidence_ids: [] }, network: { required: null, available: null, evidence_ids: [] }, authentication: { status: 'unknown', evidence_ids: [] }, rate_limit: { status: 'unknown', retry_at: null, evidence_ids: [] }, last_success: null, capabilities: [], evidence: [sourceProof] };
        if (resource.kind === 'artifact' && hint.operation === 'read-local-artifact' && artifactReadAuthorized(state, resource.id)) {
          const observed = probeWorkspaceArtifact(state, resource.id);
          if (!observed) continue;
          const digest = routeEvidenceDigest({ task_id: state.task_id, task_version: state.task_version, workspace: state.task.workspace, authorization: state.task.authorization, operation: 'bounded-workspace-inspection' });
          const contract: RouteEvidence = { id: `route-scope:${digest}`, source: 'artifact', reference: `task-contract:${state.task_id}:${state.task_version}`, observed_at: observed.observed_at, task_version: state.task_version, content_sha256: digest };
          candidate.status = 'observed'; candidate.evidence.push(observed, contract);
          candidate.authorization = { status: 'authorized', evidence_ids: [contract.id] };
          candidate.network = { required: false, available: null, evidence_ids: [observed.id] };
          candidate.authentication = { status: 'not_required', evidence_ids: [observed.id] };
          candidate.rate_limit = { status: 'clear', retry_at: null, evidence_ids: [observed.id] };
          candidate.last_success = { at: observed.observed_at, evidence_ids: [observed.id] };
          candidate.capabilities = ['B independently read at most 16384 bytes of this source-linked workspace artifact. Relevance, completeness and task success require separate evidence.'];
        } else if (prior) continue; // A hint cannot erase any existing facts/exclusions.
        catalog.upsert(candidate); accepted++;
      }
    } catch { /* Invalid/oversized hints never change facts or interrupt Stop. */ }
  }
  if (accepted) state.route_catalog = catalog.toJSON();
  return accepted;
}
