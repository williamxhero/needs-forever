#!/usr/bin/env node
import { resolve } from 'node:path';
import { NFDaemon, startLoopbackApi } from './daemon.js';
import { startWebServer } from './web.js';
function flags(argv) {
    const result = new Map();
    for (let i = 0; i < argv.length; i += 2) {
        const key = argv[i];
        const value = argv[i + 1];
        if (!key || !value || !key.startsWith('--') || value.startsWith('--'))
            throw new Error('Expected daemon flags with values.');
        result.set(key, value);
    }
    return result;
}
async function main() {
    const [command = 'start', ...argv] = process.argv.slice(2);
    const options = flags(argv);
    if (command !== 'start' && command !== 'status')
        throw new Error('Usage: daemon [start|status] --workspace DIRECTORY [--workspace DIRECTORY ...] [--state FILE] [--port PORT].');
    const workspaces = argv.flatMap((value, index) => value === '--workspace' && argv[index + 1] ? [resolve(argv[index + 1])] : []);
    if (!workspaces.length)
        workspaces.push(resolve('.'));
    const daemon = new NFDaemon({ workspaces, ...(options.has('--state') ? { dataPath: options.get('--state') } : {}), ...(options.has('--interval') ? { intervalMs: Number(options.get('--interval')) } : {}) });
    if (command === 'status') {
        await daemon.tick();
        console.log(JSON.stringify(daemon.status(), null, 2));
        return;
    }
    daemon.start();
    const api = await startLoopbackApi({ daemon, port: options.has('--port') ? Number(options.get('--port')) : 0, ...(options.has('--token') ? { token: options.get('--token') } : {}) });
    let web;
    if (options.has('--web-port'))
        web = await startWebServer({ workspace: workspaces[0], port: Number(options.get('--web-port')), daemonApi: api.url, daemonToken: api.token });
    console.log(JSON.stringify({ url: api.url, web_url: web?.url ?? null, pid: process.pid, tokenPath: daemon.tokenPath }));
    await new Promise((resolvePromise) => {
        const stop = () => { daemon.stop(); void Promise.all([api.close(), web?.close() ?? Promise.resolve()]).finally(resolvePromise); };
        process.once('SIGINT', stop);
        process.once('SIGTERM', stop);
    });
}
main().catch((error) => { console.error(error instanceof Error ? error.message : 'NF daemon failed.'); process.exitCode = 1; });
