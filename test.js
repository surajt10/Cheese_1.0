// Unit tests for the pure modules (no Electron needed).
const assert = require('assert');
const os = require('os'); const fs = require('fs'); const path = require('path');
const { prepareHistory } = require('./providers');
const Store = require('./store');

// prepareHistory: drops unanswered old turns, keeps alternation, trims images
const msgs = [
  { role: 'user', image: 'A' }, { role: 'assistant', text: 'ans A' },
  { role: 'user', image: 'B' }, { role: 'assistant', text: 'boom', error: true },
  { role: 'user', image: 'C' }, { role: 'assistant', text: 'ans C' },
  { role: 'user', image: 'D' },
];
const h = prepareHistory(msgs, 2);
assert.deepStrictEqual(h.map((m) => m.role), ['user', 'assistant', 'user', 'assistant', 'user']);
assert.strictEqual(h.filter((m) => m.image).length, 2);
assert.strictEqual(h[0].image, undefined); // oldest image dropped
assert.strictEqual(h[4].image, 'D');
assert.strictEqual(h[2].image, 'C');
assert.ok(!h.some((m) => m.text === 'boom'));

// Store round-trip
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cheese-'));
const s = new Store(dir, 'x', { a: 1 });
s.set({ b: 2 }); s.flush();
const s2 = new Store(dir, 'x', { a: 1, c: 3 });
assert.deepStrictEqual(s2.get(), { a: 1, b: 2, c: 3 });
console.log('all tests passed');
