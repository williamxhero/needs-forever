import { readFileSync } from 'node:fs';
if (readFileSync('native-thread-unload.txt', 'utf8') !== 'native-thread-unload-ok') process.exit(1);
console.log('T11 native thread unload verifier PASS');
