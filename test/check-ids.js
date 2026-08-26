/* Every element app.js reaches for by name must exist in index.html. A
   missing one is a crash at startup, and the id is only checked where it is
   written as a literal — a computed one tells us nothing. */
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');

const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

const used = new Set([...app.matchAll(/\$(?:opt)?\(\s*(['"])([A-Za-z0-9_-]+)\1\s*\)/g)].map((m) => m[2]));
const have = new Set([...html.matchAll(/id="([A-Za-z0-9_-]+)"/g)].map((m) => m[1]));

const missing = [...used].filter((id) => !have.has(id));
if (missing.length) {
  console.log('FAIL missing ids: ' + missing.join(', '));
  process.exit(1);
}
console.log('ok   all ' + used.size + ' ids present');
