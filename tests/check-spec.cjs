#!/usr/bin/env node
// Check every skills/*/SKILL.md against the Agent Skills spec (agentskills.io/specification),
// the format Claude Code, Codex, Cursor, Gemini CLI, Copilot, OpenCode, etc. all read.
// Covers the rules a skill can silently break: name format and directory match, length
// limits, allowed top-level fields, string-only metadata, body size, and relative links.
//
// Usage: node check-spec.cjs <skills-dir>   (prints ✓/✗ per rule; exits 1 on any failure)
const fs = require('fs');
const path = require('path');

const root = path.resolve(process.argv[2] || 'skills');
const ALLOWED = new Set(['name', 'description', 'license', 'compatibility', 'metadata', 'allowed-tools']);
let failed = 0;
const rule = (ok, desc) => {
  console.log(`  ${ok ? '✓' : '✗'} ${desc}`);
  if (!ok) failed++;
};

// Minimal YAML for frontmatter: top-level `key: value` plus one level of indented `k: v` maps.
function parseFrontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) return null;
  const out = {};
  let parent = null;
  for (const line of m[1].split('\n')) {
    if (!line.trim()) continue;
    const nested = line.match(/^\s+([\w-]+):\s*(.*)$/);
    const top = line.match(/^([\w-]+):\s*(.*)$/);
    const unquote = (v) => v.replace(/^(['"])(.*)\1$/, '$2');
    if (top) {
      parent = top[2] === '' ? top[1] : null;
      out[top[1]] = top[2] === '' ? {} : unquote(top[2]);
    } else if (nested && parent) {
      out[parent][nested[1]] = { raw: nested[2], value: unquote(nested[2]) };
    }
  }
  return { fields: out, body: text.slice(m[0].length) };
}

for (const dir of fs.readdirSync(root)) {
  const file = path.join(root, dir, 'SKILL.md');
  if (!fs.existsSync(file)) continue;
  console.log(`  ${dir}/SKILL.md`);
  const fm = parseFrontmatter(fs.readFileSync(file, 'utf8'));
  rule(!!fm, 'starts with YAML frontmatter');
  if (!fm) continue;
  const f = fm.fields;
  const name = f.name || '';
  rule(/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name) && name.length <= 64, `name "${name}" is 1-64 lowercase letters/digits/single hyphens`);
  rule(name === dir, 'name matches its directory');
  const desc = f.description || '';
  rule(desc.length >= 1 && desc.length <= 1024, `description is 1-1024 chars (${desc.length})`);
  if (f.compatibility !== undefined) rule(f.compatibility.length >= 1 && f.compatibility.length <= 500, `compatibility is 1-500 chars (${f.compatibility.length})`);
  const extra = Object.keys(f).filter((k) => !ALLOWED.has(k));
  rule(extra.length === 0, `only spec fields${extra.length ? ` (unexpected: ${extra.join(', ')})` : ''}`);
  if (f.metadata !== undefined) {
    const vals = Object.values(f.metadata);
    rule(typeof f.metadata === 'object' && vals.every((v) => /^(['"]).*\1$/.test(v.raw) || !/^[\d.]+$|^(true|false)$/.test(v.raw)), 'metadata values are strings (numbers/booleans quoted)');
  }
  const lines = fm.body.split('\n').length;
  rule(lines < 500, `body under 500 lines (${lines})`);
  const links = [...fm.body.matchAll(/`((?:references|scripts|assets)\/[^`\s]+)`|\]\(((?:references|scripts|assets)\/[^)]+)\)/g)].map((m) => m[1] || m[2]);
  const missing = links.filter((l) => !l.includes('*') && !fs.existsSync(path.join(root, dir, l.split(/[#?]/)[0])));
  rule(missing.length === 0, `referenced skill files exist${missing.length ? ` (missing: ${missing.join(', ')})` : ''}`);
}

process.exit(failed ? 1 : 0);
