#!/usr/bin/env node
// Guess the dev-server command for a project, with a {port} placeholder.
//
// Usage: node devcmd.cjs <project-dir>   -> prints e.g. "npm run dev -- --port {port} --strictPort"
//        node devcmd.cjs <project-dir> --storybook   -> e.g. "npm run storybook -- -p {port} --ci"
// Exits 1 with a reason if it can't tell; then pass --dev to run.sh or set devCommand in config.
const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
const storybook = argv.includes('--storybook');
const dir = path.resolve(argv.find((x) => !x.startsWith('--')) || '.');
const pkgPath = path.join(dir, 'package.json');

if (!fs.existsSync(pkgPath)) {
  if (storybook) {
    console.error('No package.json, so no Storybook; pass --dev "<command with {port}>"');
    process.exit(1);
  }
  // Plain static site.
  if (fs.existsSync(path.join(dir, 'index.html'))) {
    console.log('python3 -m http.server {port}');
    process.exit(0);
  }
  console.error('No package.json or index.html; pass --dev "<command with {port}>"');
  process.exit(1);
}

const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const deps = { ...pkg.dependencies, ...pkg.devDependencies };
const scripts = pkg.scripts || {};
const has = (f) => fs.existsSync(path.join(dir, f));
const pm = has('pnpm-lock.yaml') ? 'pnpm' : has('yarn.lock') ? 'yarn' : has('bun.lockb') || has('bun.lock') ? 'bun' : 'npm';

// Storybook: the project's "storybook" script (a later -p wins over one already in it), else the CLI.
// --ci: no prompts, no browser.
if (storybook) {
  if (scripts.storybook) {
    console.log(`${pm === 'npm' ? 'npm run storybook --' : `${pm} run storybook`} -p {port} --ci`);
  } else if (has('.storybook') || deps.storybook) {
    const exec = { npm: 'npx --no-install', pnpm: 'pnpm exec', yarn: 'yarn', bun: 'bunx' }[pm];
    console.log(`${exec} storybook dev -p {port} --ci`);
  } else {
    console.error('No .storybook/ folder or "storybook" script; pass --dev "<command with {port}>"');
    process.exit(1);
  }
  process.exit(0);
}

const script = ['dev', 'start', 'serve'].find((s) => scripts[s]);
if (!script) {
  console.error('package.json has no dev/start/serve script; pass --dev "<command with {port}>"');
  process.exit(1);
}

const body = scripts[script];

// Port flags per dev server. Order matters: meta-frameworks before the bundler they use.
let flags = '';
if (/\bnext\b/.test(body) || deps.next) flags = '-p {port}';
else if (/\bnuxi?\b/.test(body) || deps.nuxt) flags = '--port {port}';
else if (/\bastro\b/.test(body) || deps.astro) flags = '--port {port}';
else if (/\bng\b/.test(body) || deps['@angular/cli']) flags = '--port {port}';
else if (/\bgatsby\b/.test(body) || deps.gatsby) flags = '-p {port}';
else if (/\breact-scripts\b/.test(body)) flags = ''; // honors PORT
else if (/\b(vite|svelte-kit|react-router|remix vite|solid-start|vinxi)\b/.test(body) || deps.vite) flags = '--port {port} --strictPort';
// Otherwise rely on the PORT env var that run.sh sets.

const run = pm === 'npm' ? `npm run ${script}${flags ? ' --' : ''}` : `${pm} run ${script}`;
console.log(`${run}${flags ? ' ' + flags : ''}`);
