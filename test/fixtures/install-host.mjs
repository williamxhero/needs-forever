import { cpSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
const args = process.argv.slice(2);
const installed = resolve(process.env.CODEX_HOME, 'plugins/cache/插件 安装副本');
if (args[0] === '--version') console.log('fixture-codex simulated');
else if (args[0] === 'plugin') {
  if (args[1] === 'marketplace') { mkdirSync(process.env.CODEX_HOME, { recursive: true }); console.log('{}'); }
  else if (args[1] === 'add') { cpSync(resolve(process.cwd(), '../../candidate/plugins/needs-forever'), installed, { recursive: true }); console.log(JSON.stringify({ installedPath: installed })); }
  else console.log('[]');
} else if (args[0] === 'app-server') {
  const lines = createInterface({ input: process.stdin });
  for await (const line of lines) {
    const request = JSON.parse(line);
    if (!request.id) continue;
    let result;
    if (request.method === 'initialize') result = { codexHome: process.env.CODEX_HOME, userAgent: 'simulated', platformFamily: 'simulated', platformOs: 'simulated' };
    if (request.method === 'skills/list') result = { data: [{ skills: [{ pluginId: 'needs-forever@needs-forever-local', name: 'needs-forever:supervise' }], errors: [] }] };
    if (request.method === 'hooks/list') result = { data: [{ cwd: process.cwd(), errors: [], warnings: [], hooks: Object.keys(JSON.parse(readFileSync(resolve(installed, 'hooks/hooks.json'), 'utf8')).hooks).map((name) => ({ eventName: name[0].toLowerCase() + name.slice(1), pluginId: 'needs-forever@needs-forever-local', source: 'plugin', sourcePath: resolve(installed, 'hooks/hooks.json'), enabled: true, trustStatus: 'untrusted' })) }] };
    console.log(JSON.stringify({ id: request.id, result }));
  }
}
