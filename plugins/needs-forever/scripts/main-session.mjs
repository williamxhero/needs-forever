#!/usr/bin/env node
import { resolve, isAbsolute } from 'node:path';
import { readFileSync } from 'node:fs';
import { prepareMainSession, resumeMainSession, mainSessionStatus, loadMainSessionTracking, updateMainSessionTracking } from '../runtime/src/main-session.js';
import { NATIVE_BINDING_COMMAND_HINT } from '../runtime/src/control-intent.js';
import { redact } from '../runtime/src/redact.js';
import { controllerStatus, pauseMainController, prepareControllerResume } from '../runtime/src/main-controller.js';

try {
  const [command, ...args] = process.argv.slice(2);
  const flags = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]; const value = args[i + 1];
    const known = ['--task', '--state', '--test-fixture', '--tracking-backend', '--tracking-path', '--tracking-repository', '--tracking-issue', '--tracking-title', '--tracking-clarification', '--tracking-update', '--acceptance-id', '--tracking-status', '--tracking-notes', '--tracking-evidence'];
    if (!known.includes(key) || flags[key] || !value || value.startsWith('--')) throw new Error('Expected unique task/state/tracking flags. Session ids cannot be supplied.');
    flags[key] = ['--tracking-backend', '--tracking-repository', '--tracking-issue', '--tracking-title', '--acceptance-id', '--tracking-status', '--tracking-notes', '--tracking-evidence'].includes(key) ? value : resolve(value);
  }
  if (!flags['--state']) throw new Error('--state is required.');
  const tracking = () => {
    const selected = ['--tracking-backend', '--tracking-path', '--tracking-repository', '--tracking-issue', '--tracking-title', '--tracking-clarification'].some((key) => flags[key] !== undefined);
    if (!selected) return undefined;
    const backend = flags['--tracking-backend']; if (!['local-json', 'github-issue'].includes(backend)) throw new Error('Tracking requires an explicit backend.');
    const result = { backend };
    if (backend === 'local-json') { if (!flags['--tracking-path'] || flags['--tracking-repository'] || flags['--tracking-issue'] || flags['--tracking-title']) throw new Error('local-json tracking requires --tracking-path and no GitHub options.'); result.path = flags['--tracking-path']; }
    else { if (!flags['--tracking-repository'] || flags['--tracking-path']) throw new Error('github-issue tracking requires --tracking-repository and no local path.'); result.repository = flags['--tracking-repository']; if (flags['--tracking-issue']) result.issue = Number(flags['--tracking-issue']); if (flags['--tracking-title']) result.title = flags['--tracking-title']; }
    if (flags['--tracking-clarification']) result.clarification = JSON.parse(readFileSync(flags['--tracking-clarification'], 'utf8'));
    return result;
  };
  const update = () => flags['--tracking-update'] ? JSON.parse(readFileSync(flags['--tracking-update'], 'utf8')) : { acceptance_id: flags['--acceptance-id'], status: flags['--tracking-status'], notes: flags['--tracking-notes'] ?? '', evidence_refs: flags['--tracking-evidence'] ? flags['--tracking-evidence'].split(',').map((value) => value.trim()).filter(Boolean) : [] };
  let result;
  if (command === 'prepare') {
    if (!flags['--task']) throw new Error('--task is required.');
    const state = prepareMainSession(flags['--task'], flags['--state'], Boolean(flags['--test-fixture']), tracking());
    result = { prepared: true, binding_instruction: NATIVE_BINDING_COMMAND_HINT, task_id: state.task_id, control_mode: state.control_mode, status: state.status, binding: state.binding, state_path: flags['--state'] };
  } else if (command === 'resume') {
    await prepareControllerResume(flags['--state']);
    const state = resumeMainSession(flags['--state'], flags['--task'], Boolean(flags['--test-fixture']), tracking());
    result = { prepared: true, binding_instruction: NATIVE_BINDING_COMMAND_HINT, task_id: state.task_id, control_mode: state.control_mode, status: state.status, binding: state.binding, state_path: flags['--state'] };
  } else if (command === 'status') result = await controllerStatus(flags['--state']);
  else if (command === 'tracking-load') result = loadMainSessionTracking(flags['--state']);
  else if (command === 'tracking-update') result = updateMainSessionTracking(flags['--state'], update());
  else if (command === 'pause') result = await pauseMainController(flags['--state']);
  else throw new Error('Commands: prepare/resume/status/pause/tracking-load/tracking-update with --state FILE.');
  console.log(JSON.stringify(result, null, 2));
} catch (error) { console.error(String(redact(error.message))); process.exitCode = 1; }
