#!/bin/sh
# Every check this project has. No dependencies beyond Node itself — the app
# ships as plain files and the tests run against those same files.
set -e
cd "$(dirname "$0")/.."

echo "--- syntax ---"
for f in app.js sw.js worker/receipt-ocr.js; do node --check "$f" && echo "ok   $f"; done

echo "\n--- every element app.js reaches for exists in index.html ---"
node -e '
const fs = require("fs");
const used = new Set([...fs.readFileSync("app.js","utf8").matchAll(/\$(?:opt)?\(.([A-Za-z0-9_-]+).\)/g)].map(m=>m[1]));
const have = new Set([...fs.readFileSync("index.html","utf8").matchAll(/id="([A-Za-z0-9_-]+)"/g)].map(m=>m[1]));
const missing = [...used].filter(id => !have.has(id));
if (missing.length) { console.log("FAIL missing ids: " + missing.join(", ")); process.exit(1); }
console.log("ok   all " + used.size + " ids present");'

echo "\n--- receipt parser ---";              node test/receipt-parser.js
echo "\n--- drive ocr ---";                    node test/drive-ocr.js
echo "\n--- business lookup ---";                node test/lookup.js
echo "\n--- reminders and connection ---";        node test/reminders.js
echo "\n--- scanner health and diagnosis ---"; node test/scanner-health.js
echo "\n--- scan flow ---";                    node test/scan-flow.js
echo "\n--- worker ---";                       node test/worker.mjs
echo "\nAll checks passed."
