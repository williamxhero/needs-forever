import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { contractIdentity, } from './local-tracking.js';
export const GITHUB_TRACKING_START = '<!-- needs-forever:tracking:start -->';
export const GITHUB_TRACKING_END = '<!-- needs-forever:tracking:end -->';
/** The production seam. Tests should inject a controlled adapter instead. */
export class GhCliAdapter {
    executable;
    constructor(executable = 'gh') {
        this.executable = executable;
    }
    run(args) {
        const result = spawnSync(this.executable, [...args], { encoding: 'utf8' });
        return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
    }
}
function required(value, field) {
    if (typeof value !== 'string' || !value.trim())
        throw new Error(`${field} must be a nonempty string.`);
    return value.trim();
}
function evidenceRefs(value) {
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item.trim()))
        throw new Error('evidence_refs must contain only nonempty strings.');
    return value.map((item) => item.trim());
}
function clarification(value) {
    if (!value || typeof value !== 'object')
        throw new Error('Malformed clarification.');
    const item = value;
    return {
        value: required(item.value, 'clarification.value'), priority: required(item.priority, 'clarification.priority'),
        evidence: required(item.evidence, 'clarification.evidence'), authorization: required(item.authorization, 'clarification.authorization'),
        stop_condition: required(item.stop_condition, 'clarification.stop_condition'), budget: required(item.budget, 'clarification.budget'),
    };
}
function normalizedTask(task) {
    const ids = new Set();
    const acceptance = task.acceptance.map((item) => {
        const id = required(item.id, 'acceptance id');
        const text = required(item.text, 'acceptance text');
        if (ids.has(id))
            throw new Error(`Duplicate acceptance id: ${id}`);
        ids.add(id);
        return { id, text };
    });
    return { ...structuredClone(task), task_id: required(task.task_id, 'task_id'), workspace: resolve(required(task.workspace, 'workspace')), goal: required(task.goal, 'goal'), acceptance, authorization: required(task.authorization, 'authorization'), limits: { ...task.limits } };
}
function locator(repository, issue) { return `github:${repository}#${issue}`; }
function validateRecord(value, expectedLocator) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('Tracking record must be a JSON object.');
    const record = value;
    if (record.schema_version !== 1 || record.backend !== 'github-issue' || record.locator !== expectedLocator)
        throw new Error('GitHub tracking marker or locator mismatch.');
    if (typeof record.task_id !== 'string' || typeof record.contract_identity !== 'string' || !record.contract || !Array.isArray(record.acceptance))
        throw new Error('Malformed GitHub tracking record.');
    const acceptance = record.acceptance.map((candidate) => {
        if (!candidate || typeof candidate !== 'object')
            throw new Error('Malformed acceptance item.');
        const item = candidate;
        const id = required(item.id, 'acceptance id');
        const text = required(item.text, 'acceptance text');
        if (!['TODO', 'IN_PROGRESS', 'REPORTED_DONE', 'BLOCKED'].includes(item.status))
            throw new Error(`Invalid acceptance status for ${id}.`);
        const notes = typeof item.notes === 'string' ? item.notes : '';
        const refs = evidenceRefs(item.evidence_refs);
        if (item.status === 'REPORTED_DONE' && refs.length === 0)
            throw new Error(`Reported completion for ${id} requires evidence.`);
        if (item.status === 'BLOCKED' && !notes.trim())
            throw new Error(`Blocked acceptance ${id} requires notes.`);
        return { id, text, status: item.status, notes, evidence_refs: refs };
    });
    const ids = new Set();
    for (const item of acceptance) {
        if (ids.has(item.id))
            throw new Error(`Duplicate acceptance id: ${item.id}`);
        ids.add(item.id);
    }
    return { schema_version: 1, backend: 'github-issue', locator: expectedLocator, task_id: record.task_id, contract_identity: record.contract_identity, contract: normalizedTask(record.contract), clarification: clarification(record.clarification), acceptance, updated_at: required(record.updated_at, 'updated_at') };
}
function compareContract(record, task) {
    const identity = contractIdentity(task);
    const expected = normalizedTask(task).acceptance;
    if (record.task_id !== task.task_id || record.contract_identity !== identity || contractIdentity(record.contract) !== identity)
        throw new Error('Tracking record contract mismatch.');
    const actual = new Map(record.acceptance.map((item) => [item.id, item.text]));
    if (expected.length !== actual.size || expected.some((item) => actual.get(item.id) !== item.text))
        throw new Error('Tracking record acceptance identity mismatch.');
}
function sorted(value) {
    if (Array.isArray(value))
        return value.map(sorted);
    if (value && typeof value === 'object')
        return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, sorted(item)]));
    return value;
}
function json(value) { return JSON.stringify(sorted(value), null, 2); }
function block(record) { return `${GITHUB_TRACKING_START}\n${json(record)}\n${GITHUB_TRACKING_END}`; }
function extract(body, expectedLocator) {
    const pattern = new RegExp(`${GITHUB_TRACKING_START.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\r?\\n([\\s\\S]*?)\\r?\\n${GITHUB_TRACKING_END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'g');
    const matches = [...body.matchAll(pattern)];
    if (matches.length !== 1)
        throw new Error('GitHub tracking canonical block is missing or duplicated.');
    let parsed;
    try {
        parsed = JSON.parse(matches[0][1]);
    }
    catch (error) {
        throw new Error(`Invalid GitHub tracking JSON: ${error.message}`, { cause: error });
    }
    return validateRecord(parsed, expectedLocator);
}
function replaceBlock(body, record, expectedLocator) {
    extract(body, expectedLocator);
    const pattern = new RegExp(`${GITHUB_TRACKING_START.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\r?\\n[\\s\\S]*?\\r?\\n${GITHUB_TRACKING_END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'g');
    return body.replace(pattern, block(record));
}
function command(adapter, args) {
    const result = adapter.run(args);
    if (result.status !== 0)
        throw new Error(`GitHub command failed (${args.join(' ')}): ${result.stderr.trim() || `exit ${result.status}`}`);
    return result.stdout;
}
function parseJson(output, description) { try {
    return JSON.parse(output);
}
catch (error) {
    throw new Error(`GitHub ${description} returned invalid JSON.`, { cause: error });
} }
function createdIssueNumber(output, repository) {
    const url = output.trim().match(/https?:\/\/[^/\s]+\/([^/\s]+\/[^/\s]+)\/issues\/(\d+)/i);
    if (!url || url[1] !== repository)
        throw new Error('GitHub create response did not contain an Issue URL for the requested repository.');
    const issue = Number(url[2]);
    if (!Number.isInteger(issue) || issue <= 0)
        throw new Error('GitHub create response did not contain a valid Issue number.');
    return issue;
}
export class GitHubTrackingStore {
    backend = 'github-issue';
    repository;
    issue;
    title;
    adapter;
    constructor(options) {
        if (options.backend !== 'github-issue')
            throw new Error('An explicit backend selection of github-issue is required.');
        this.repository = required(options.repository, 'repository');
        if (options.issue !== undefined && (!Number.isInteger(options.issue) || options.issue <= 0))
            throw new Error('issue must be a positive integer.');
        this.issue = options.issue;
        this.title = options.title?.trim();
        this.adapter = options.adapter ?? new GhCliAdapter();
        if (this.issue === undefined && !this.title)
            throw new Error('title is required when creating a GitHub Issue.');
    }
    verifyRepository() {
        const viewed = parseJson(command(this.adapter, ['repo', 'view', this.repository, '--json', 'nameWithOwner']), 'repository response');
        if (viewed.nameWithOwner !== this.repository)
            throw new Error(`GitHub repository identity mismatch: expected ${this.repository}.`);
    }
    view(issue) {
        const viewed = parseJson(command(this.adapter, ['issue', 'view', String(issue), '--repo', this.repository, '--json', 'number,title,body']), 'Issue response');
        if (viewed.number !== issue || typeof viewed.body !== 'string')
            throw new Error('GitHub Issue identity mismatch.');
        return { number: viewed.number, title: String(viewed.title ?? ''), body: viewed.body };
    }
    create(task, clarificationValue) {
        if (this.issue !== undefined)
            throw new Error('This GitHub tracking store targets an existing Issue; use load or update.');
        const temporary = join(tmpdir(), `needs-forever-${randomUUID()}.md`);
        const base = { schema_version: 1, backend: 'github-issue', locator: 'github:pending#0', task_id: required(task.task_id, 'task_id'), contract_identity: contractIdentity(task), contract: normalizedTask(task), clarification: clarification(clarificationValue), acceptance: normalizedTask(task).acceptance.map(({ id, text }) => ({ id, text, status: 'TODO', notes: '', evidence_refs: [] })), updated_at: new Date().toISOString() };
        try {
            this.verifyRepository();
            // The issue number is unknown until creation; create with a temporary marked body,
            // then replace its pending locator after GitHub assigns the Issue number.
            writeFileSync(temporary, `${block(base)}\n`, { encoding: 'utf8' });
            const issue = createdIssueNumber(command(this.adapter, ['issue', 'create', '--repo', this.repository, '--title', this.title, '--body-file', temporary]), this.repository);
            const record = { ...base, locator: locator(this.repository, issue) };
            writeFileSync(temporary, `${block(record)}\n`, { encoding: 'utf8' });
            // Adapters may emulate create by reading the body file; real gh needs the file populated first.
            command(this.adapter, ['issue', 'edit', String(issue), '--repo', this.repository, '--body-file', temporary]);
            return this.readBack(issue, record);
        }
        catch (error) {
            throw new Error(`GitHub tracking record was not saved; no local fallback was attempted: ${error.message}`, { cause: error });
        }
        finally {
            try {
                unlinkSync(temporary);
            }
            catch { /* best effort */ }
        }
    }
    readBack(issue, expected) {
        const viewed = this.view(issue);
        const saved = extract(viewed.body, expected.locator);
        compareContract(saved, expected.contract);
        if (JSON.stringify(sorted(saved)) !== JSON.stringify(sorted(expected)))
            throw new Error('GitHub tracking canonical block read-back mismatch.');
        return saved;
    }
    load(task) {
        if (this.issue === undefined)
            throw new Error('An explicit existing Issue is required to load GitHub tracking.');
        this.verifyRepository();
        const viewed = this.view(this.issue);
        const saved = extract(viewed.body, locator(this.repository, this.issue));
        compareContract(saved, task);
        return saved;
    }
    update(task, update) {
        if (this.issue === undefined)
            throw new Error('An explicit existing Issue is required to update GitHub tracking.');
        let temporary;
        try {
            const current = this.load(task);
            const id = required(update.acceptance_id, 'acceptance_id');
            const item = current.acceptance.find((candidate) => candidate.id === id);
            if (!item)
                throw new Error(`Unknown acceptance id: ${id}`);
            if (!['TODO', 'IN_PROGRESS', 'REPORTED_DONE', 'BLOCKED'].includes(update.status))
                throw new Error(`Invalid acceptance status for ${id}.`);
            const notes = typeof update.notes === 'string' ? update.notes.trim() : '';
            const refs = evidenceRefs(update.evidence_refs);
            if (update.status === 'REPORTED_DONE' && refs.length === 0)
                throw new Error(`Reported completion for ${id} requires evidence.`);
            if (update.status === 'BLOCKED' && !notes)
                throw new Error(`Blocked acceptance ${id} requires notes.`);
            item.status = update.status;
            item.notes = notes;
            item.evidence_refs = refs;
            current.updated_at = new Date().toISOString();
            const viewed = this.view(this.issue);
            const body = replaceBlock(viewed.body, current, current.locator);
            temporary = join(tmpdir(), `needs-forever-${randomUUID()}`);
            writeFileSync(temporary, body.replace(/^\uFEFF/, ''), { encoding: 'utf8' });
            command(this.adapter, ['issue', 'edit', String(this.issue), '--repo', this.repository, '--body-file', temporary]);
            return this.readBack(this.issue, current);
        }
        catch (error) {
            throw new Error(`GitHub tracking update was not saved; no local fallback was attempted: ${error.message}`, { cause: error });
        }
        finally {
            if (temporary)
                try {
                    unlinkSync(temporary);
                }
                catch { /* best effort */ }
        }
    }
}
