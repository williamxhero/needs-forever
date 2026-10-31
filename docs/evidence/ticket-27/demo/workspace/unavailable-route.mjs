import { writeFileSync } from 'node:fs';
writeFileSync('route-attempted.txt', 'required-first-route-failed');
console.error('The first route is deliberately unavailable. Use the authorized direct-file alternative.');
process.exitCode = 23;
