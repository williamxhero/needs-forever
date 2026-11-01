import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = resolve(root, 'dist/src');
const target = resolve(root, 'plugins/needs-forever/runtime/src');
const files = readdirSync(source).filter((name) => name.endsWith('.js')).sort();
mkdirSync(target, { recursive: true });
const hashes = {};
for (const name of files) {
  // Generated type-only protocol modules have no runtime imports. Ship only
  // executable modules; strip source-map pointers to unshipped source files.
  const contents = readFileSync(join(source, name), 'utf8').replace(/^\/\/# sourceMappingURL=.*$/gm, '');
  writeFileSync(join(target, name), contents, 'utf8');
  hashes[`src/${name}`] = createHash('sha256').update(contents).digest('hex');
}
writeFileSync(resolve(target, '../integrity.json'), JSON.stringify({ generated_by: 'npm run plugin:build', files: hashes }, null, 2) + '\n');
console.log(`Built self-contained plugin runtime (${files.length} modules).`);
