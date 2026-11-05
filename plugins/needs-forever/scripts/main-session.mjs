#!/usr/bin/env node
import { resolve, isAbsolute } from 'node:path';
import { prepareMainSession, resumeMainSession, mainSessionStatus } from '../runtime/src/main-session.js';
import { NATIVE_BINDING_COMMAND_HINT } from '../runtime/src/control-intent.js';
import { redact } from '../runtime/src/redact.js';
import { controllerStatus, pauseMainController, prepareControllerResume } from '../runtime/src/main-controller.js';

try {
  const [command, ...args] = process.argv.slice(2);
  const flags = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!['--task', '--state', '--test-fixture'].includes(args[i]) || flags[args[i]] || !args[i + 1] || !isAbsolute(args[i + 1])) throw new Error('Expected unique absolute --task/--state/--test-fixture FILE flags. Session ids cannot be supplied.');
    flags[args[i]] = resolve(args[i + 1]);
  }
  if (!flags['--state']) throw new Error('--state is required.');
  let result;
  if (command === 'prepare') {
    if (!flags['--task']) throw new Error('--task is required.');
    const state = prepareMainSession(flags['--task'], flags['--state'], Boolean(flags['--test-fixture']));
    result = { prepared: true, binding_instruction: NATIVE_BINDING_COMMAND_HINT, task_id: state.task_id, control_mode: state.control_mode, status: state.status, binding: state.binding, state_path: flags['--state'] };
  } else if (command === 'resume') {
    await prepareControllerResume(flags['--state']);
    const state = resumeMainSession(flags['--state'], flags['--task'], Boolean(flags['--test-fixture']));
    result = { prepared: true, binding_instruction: NATIVE_BINDING_COMMAND_HINT, task_id: state.task_id, control_mode: state.control_mode, status: state.status, binding: state.binding, state_path: flags['--state'] };
  } else if (command === 'status') result = await controllerStatus(flags['--state']);
  else if (command === 'pause') {
    result = await pauseMainController(flags['--state']);
  }
  else throw new Error('Commands: prepare --task FILE --state FILE | status/pause --state FILE.');
  console.log(JSON.stringify(result, null, 2));
} catch (error) { console.error(String(redact(error.message))); process.exitCode = 1; }
