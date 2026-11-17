#!/usr/bin/env node
// Put a rendered report on a PR, replacing the previous ui-diff report if there is one.
//
// Usage: node post.cjs --pr <number> --body comment.md [--mode comment|description] [--dry-run]
//
//   comment      edit the existing comment that has the ui-diff markers, else add one
//   description  replace the marked section of the PR description, else append it;
//                the rest of the description is left exactly as it was
// --dry-run prints what would be sent instead of sending it. Prints the resulting URL.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { args } = require('./lib.cjs');

const START = '<!-- ui-diff:start -->';
const END = '<!-- ui-diff:end -->';
// Exported for testing: swap the marked section, or append it after a rule.
function spliceSection(existing, section) {
  const text = existing || '';
  const i = text.indexOf(START);
  const j = text.indexOf(END);
  if (i !== -1 && j > i) return text.slice(0, i) + section + text.slice(j + END.length);
  return text.trim() ? `${text.trimEnd()}\n\n---\n\n${section}` : section;
}
module.exports = { spliceSection };
if (require.main !== module) return;

const a = args();
const mode = a.mode || 'comment';
if (!a.pr || !a.body || !['comment', 'description'].includes(mode)) {
  console.error('Usage: post.cjs --pr <number> --body <file> [--mode comment|description] [--dry-run]');
  process.exit(1);
}
const body = fs.readFileSync(a.body, 'utf8').trim();
const gh = (...argv) => execFileSync('gh', argv, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();


if (mode === 'comment') {
  const ids = gh('api', `repos/{owner}/{repo}/issues/${a.pr}/comments`, '--paginate',
    '--jq', `.[] | select(.body | contains("${START}")) | .id`).split('\n').filter(Boolean);
  if (a['dry-run']) {
    console.log(ids.length ? `would update comment ${ids[0]}` : `would add a comment to #${a.pr}`);
  } else if (ids.length) {
    console.log(gh('api', '-X', 'PATCH', `repos/{owner}/{repo}/issues/comments/${ids[0]}`, '-F', `body=@${a.body}`, '--jq', '.html_url'));
  } else {
    console.log(gh('pr', 'comment', String(a.pr), '--body-file', a.body));
  }
} else {
  const current = gh('pr', 'view', String(a.pr), '--json', 'body', '-q', '.body');
  const next = spliceSection(current, body);
  if (a['dry-run']) {
    process.stdout.write(next + '\n');
  } else {
    const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ui-diff-')), 'body.md');
    fs.writeFileSync(tmp, next);
    gh('pr', 'edit', String(a.pr), '--body-file', tmp);
    console.log(gh('pr', 'view', String(a.pr), '--json', 'url', '-q', '.url'));
  }
}
