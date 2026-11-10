// node test.js: the diff filtering and budgeting the action relies on.
'use strict';
const assert = require('assert');
const { globToRegExp, excluded, prepareDiff, DEFAULT_EXCLUDE } = require('./index.js');

const pats = DEFAULT_EXCLUDE.map(globToRegExp);
assert(excluded('package-lock.json', pats) && excluded('web/package-lock.json', pats));
assert(excluded('Cargo.lock', pats) && excluded('dist/app.js', pats) && excluded('dist/a/b.js', pats));
assert(excluded('static/app.min.js', pats) && !excluded('src/dist.js', pats) && !excluded('src/lock.go', pats));
assert(globToRegExp('docs/**/*.md').test('docs/a/b.md') && !globToRegExp('docs/**/*.md').test('src/a.md'));

const file = (p, n) => `diff --git a/${p} b/${p}\n--- a/${p}\n+++ b/${p}\n@@ -1 +1 @@\n${'+line\n'.repeat(n)}`;
const diff = file('src/a.go', 5) + file('yarn.lock', 50) + file('src/b.go', 400);
const all = prepareDiff(diff, 100000, pats);
assert.deepStrictEqual(all.skipped, ['yarn.lock']);
assert(all.text.includes('src/a.go') && all.text.includes('src/b.go') && !all.text.includes('yarn.lock'));
assert.strictEqual(all.cut.length, 0);
assert.strictEqual(all.files, 3);

const small = prepareDiff(diff, 1000, pats);
assert.deepStrictEqual(small.cut, ['src/b.go']);
assert(small.text.length <= 1000 + 60 && small.text.includes('[... diff of this file cut here ...]'));
assert(small.text.split('\n').every((l) => l === '' || l.startsWith('diff') || l.startsWith('---') || l.startsWith('+++') || l.startsWith('@@') || l === '+line' || l.startsWith('[...')), 'cut on a line boundary');
console.log('test ok');
