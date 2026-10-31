import { readFileSync } from 'node:fs';
if (readFileSync('exit.txt', 'utf8') !== 'exit-ok') process.exit(1);
console.log('T11 app-server exit verifier PASS');
