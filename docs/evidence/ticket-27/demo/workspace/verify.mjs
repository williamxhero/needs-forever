import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = (name) => JSON.parse(readFileSync(name, 'utf8'));
try {
  assert.equal(readFileSync('route-attempted.txt', 'utf8'), 'required-first-route-failed');
  assert.deepEqual(read('stage1.json'), { stage: 1, value: 'alpha' });
  assert.deepEqual(read('stage2.json'), { stage: 2, value: 'alpha-beta' });
  assert.deepEqual(read('final.json'), { stage: 3, value: 'alpha-beta-gamma' });
  console.log('All three independent stage checks PASS; the failed first route was attempted.');
} catch (error) {
  console.error('Independent acceptance FAIL:', error.message);
  process.exitCode = 1;
}
