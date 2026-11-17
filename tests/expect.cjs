#!/usr/bin/env node
// Tiny assertion helper for selftest.sh.
//
// Usage: node expect.cjs <file> '<js expression>' '<description>'
// The expression sees `d` (parsed JSON for .json files, the text otherwise) and helpers:
//   item(d, file)        the results.json item for a screenshot file
//   has(text, needle)    substring check
// Prints ✓/✗ with the description; exits 1 on failure (showing what was evaluated).
const fs = require('fs');

const [file, expr, desc] = process.argv.slice(2);
const raw = fs.readFileSync(file, 'utf8');
const d = file.endsWith('.json') ? JSON.parse(raw) : raw;
const item = (r, f) => r.items.find((i) => i.file === f) || {};
const has = (text, needle) => String(text).includes(needle);

let ok = false;
let err = '';
try {
  ok = !!new Function('d', 'item', 'has', `return (${expr});`)(d, item, has);
} catch (e) {
  err = ` (${e.message})`;
}
console.log(`  ${ok ? '✓' : '✗'} ${desc}${ok ? '' : `\n      expected: ${expr}${err}\n      in: ${file}`}`);
process.exit(ok ? 0 : 1);
