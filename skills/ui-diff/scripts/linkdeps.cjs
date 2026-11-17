#!/usr/bin/env node
// Reuse <src>'s installed dependencies in <dst> (a worktree with the same lockfile)
// without sharing the node_modules folders themselves.
//
// Usage: node linkdeps.cjs <src-root> <dst-root>
//
// Each node_modules in <dst> becomes a real folder whose entries symlink to <src>'s.
// Symlinking the whole folder would make both dev servers share build caches that live
// inside it (Vite's .vite, webpack/babel's .cache), which corrupts each other's output.
// Covers monorepos: every package folder with a node_modules (up to 4 levels) is mirrored.
const fs = require('fs');
const path = require('path');

const CACHE_DIRS = new Set(['.vite', '.vite-temp', '.cache', '.astro', '.turbo', '.svelte-kit']);
const [src, dst] = process.argv.slice(2).map((p) => path.resolve(p));
if (!src || !dst) {
  console.error('Usage: linkdeps.cjs <src-root> <dst-root>');
  process.exit(1);
}

function findNodeModules(dir, rel, depth, out) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    if (ent.name === 'node_modules') out.push(rel);
    else if (!ent.name.startsWith('.') && depth < 4) findNodeModules(path.join(dir, ent.name), path.join(rel, ent.name), depth + 1, out);
  }
  return out;
}

let linked = 0;
for (const rel of findNodeModules(src, '', 0, [])) {
  const dstPkg = path.join(dst, rel);
  if (!fs.existsSync(dstPkg)) continue; // package doesn't exist at this commit
  const from = path.join(src, rel, 'node_modules');
  const to = path.join(dstPkg, 'node_modules');
  fs.rmSync(to, { recursive: true, force: true });
  fs.mkdirSync(to);
  for (const name of fs.readdirSync(from)) {
    if (CACHE_DIRS.has(name)) continue;
    fs.symlinkSync(path.join(from, name), path.join(to, name));
  }
  linked++;
}
console.log(`linked ${linked} node_modules folder(s)`);
