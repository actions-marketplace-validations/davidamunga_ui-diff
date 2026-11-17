#!/usr/bin/env node
// Render a GitHub-flavored markdown ui-diff report from run.sh output.
//
// Usage:
//   node comment.cjs --report .ui-diff/report [--base-url <prefix from publish.sh>] \
//     [--summary summary.md] [--out comment.md]
//
// Omit --base-url to get relative image paths (for previewing, or manual upload mode).
// Reads results.json (+ run.json for commits and coverage). The output is wrapped in
// <!-- ui-diff:start/end --> markers so post.cjs can replace it on later runs.
const fs = require('fs');
const path = require('path');
const { args } = require('./lib.cjs');

const a = args();
if (!a.report) {
  console.error('Required: --report <dir>');
  process.exit(1);
}
const read = (f) => JSON.parse(fs.readFileSync(path.join(a.report, f), 'utf8'));
const { summary, items } = read('results.json');
const run = fs.existsSync(path.join(a.report, 'run.json')) ? read('run.json') : null;
const url = (rel) => (a['base-url'] ? `${a['base-url']}/${rel}?raw=true` : rel);
const img = (rel, alt, width) => `<img src="${url(rel)}" alt="${alt}"${width ? ` width="${width}"` : ''}>`;
const label = (i) => [i.viewport, i.scheme && i.scheme !== 'light' ? i.scheme : null].filter(Boolean).join(' · ');
const warn = (i) => (i.warnings || []).map((w) => `> ⚠️ ${w}`);

const out = ['<!-- ui-diff:start -->', '## 🎨 UI diff', ''];

if (a.summary && fs.existsSync(a.summary)) out.push(fs.readFileSync(a.summary, 'utf8').trim(), '');

const stats = [
  summary.changed && `**${summary.changed} changed**`,
  summary.added && `${summary.added} new`,
  summary.removed && `${summary.removed} removed`,
  `${summary.unchanged} with no visual change`,
  summary.error && `⚠️ ${summary.error} failed`,
].filter(Boolean);
out.push(`<sub>${stats.join(' · ')}</sub>`);
if (run) {
  const head = `\`${run.head.sha.slice(0, 7)}\`${run.head.dirty ? ' + uncommitted changes' : ''}`;
  out.push(`<sub>Checked ${run.routes.map((r) => `\`${r}\``).join(', ')} at ${run.viewports.join(', ')}${run.schemes.length > 1 ? ` (${run.schemes.join(', ')})` : ''} — \`${run.base.sha.slice(0, 7)}\` → ${head}. Pages not listed were not checked.</sub>`);
}
out.push('');

for (const i of items.filter((x) => x.status === 'changed')) {
  const size = i.sizeChanged ? ` · height ${i.before.height}→${i.after.height}px` : '';
  out.push(`### \`${i.route || i.name}\` — ${label(i)}`, `<sub>${i.percent}% of pixels changed${size}</sub>`, '', ...warn(i));
  const zoomed = (i.regions || []).filter((r) => r.zoom);
  if (zoomed.length) {
    out.push('| Before | After |', '|---|---|');
    for (const r of zoomed) out.push(`| ${img(r.zoom.before, 'before')} | ${img(r.zoom.after, 'after')} |`);
    out.push('');
  }
  if (i.regionsOmitted) out.push(`<sub>+${i.regionsOmitted} more changed area${i.regionsOmitted > 1 ? 's' : ''} — see the full page below.</sub>`, '');
  if (i.measured && i.measured.lines.length) {
    out.push('<details><summary>Measured changes</summary>', '', ...i.measured.lines.map((l) => `- ${l}`), '', '</details>', '');
  }
  out.push(zoomed.length ? '<details><summary>Full page + diff overlay</summary>' : '<details open><summary>Full page + diff overlay</summary>', '');
  out.push('| Before | After | Diff |', '|---|---|---|');
  out.push(`| ${img(`before/${i.file}`, 'before', 300)} | ${img(`after/${i.file}`, 'after', 300)} | ${img(`diff/${i.file}`, 'diff', 300)} |`);
  out.push('', '</details>', '');
}

for (const i of items.filter((x) => x.status === 'added')) {
  out.push(`### 🆕 \`${i.route || i.name}\` — ${label(i)}`, '', ...warn(i), img(`after/${i.file}`, 'new', 400), '');
}

for (const i of items.filter((x) => x.status === 'removed')) {
  out.push(`### 🗑️ \`${i.route || i.name}\` — ${label(i)}`, '', ...warn(i), img(`before/${i.file}`, 'removed', 400), '');
}

const errors = items.filter((x) => x.status === 'error');
if (errors.length) {
  out.push('<details><summary>⚠️ Failed to capture</summary>', '');
  for (const i of errors) out.push(`- \`${i.route || i.name}\` (${label(i)}): ${i.error}`);
  out.push('', '</details>', '');
}

const same = items.filter((x) => x.status === 'unchanged');
if (same.length) {
  out.push(`<details><summary>No visual change (${same.length})</summary>`, '');
  for (const i of same) out.push(`- \`${i.route || i.name}\` — ${label(i)}${i.warnings ? ` ⚠️ ${i.warnings.join('; ')}` : ''}`);
  out.push('', '</details>', '');
}

out.push('<sub>Generated with the ui-diff skill</sub>', '<!-- ui-diff:end -->');
const md = out.join('\n').replace(/\n{3,}/g, '\n\n');
// GitHub rejects comment/PR bodies over 65,536 chars.
if (md.length > 60000) {
  console.error(`warning: report is ${md.length} chars (GitHub limit 65536) — capture fewer routes/viewports or split the comment.`);
}
if (a.out) fs.writeFileSync(a.out, md);
else process.stdout.write(md + '\n');
