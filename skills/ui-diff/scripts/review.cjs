#!/usr/bin/env node
// Design review gate: a `ui-diff/design-review` commit status that stays pending until
// someone with write access approves the UI changes for that exact head commit.
//
// Usage:
//   node review.cjs carry  --sha <head> --body comment.md
//       Before posting: if <head> is already approved (a re-run), render the box ticked.
//   node review.cjs status --sha <head> --report <dir> [--target <url>] [--event <json>] [--label <name>]
//       After posting: pending if there are visual changes (unless already approved for
//       <head>), else success. Drops the approval label from the PR when resetting.
//   node review.cjs event  --event <json> [--label <name>]
//       The approve workflow: a ticked/unticked box (issue_comment edited) or the label
//       (pull_request labeled/unlabeled). Only reads the event and calls the API; never
//       runs PR code.
//
// The comment carries <!-- ui-diff:review sha=<head> pages=N failed=M -->, so an approval
// only ever applies to the commit that was rendered, and only while it's still the PR head.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { args } = require('./lib.cjs');

const CONTEXT = 'ui-diff/design-review';
const START = '<!-- ui-diff:start -->';
const END = '<!-- ui-diff:end -->';
const MARK = /<!-- ui-diff:review sha=([0-9a-f]{7,40}) pages=(\d+) failed=(\d+) -->/;
const BOX = /^- \[( |x|X)\] \*\*Design approved\*\*.*$/m;
const APPROVED_LINE = /^✅ Approved by @.*\n?/m;
const WRITE = new Set(['admin', 'maintain', 'write']);

// Pages (routes) with visual changes, and pages that failed to capture.
function counts(items) {
  const routes = (st) => new Set(items.filter((i) => st.includes(i.status)).map((i) => i.route || i.name)).size;
  return { pages: routes(['changed', 'added', 'removed']), failed: routes(['error']) };
}
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
function pendingText({ pages, failed }) {
  const parts = [pages && `${plural(pages, 'page')} changed`, failed && `${failed} failed to capture`].filter(Boolean);
  return `${parts.join(', ')} — needs design review`;
}
// The block comment.cjs puts in the report. checkbox=false (description mode) → label only.
function block({ sha, pages, failed, checkbox = true, label }) {
  const out = [`<!-- ui-diff:review sha=${sha} pages=${pages} failed=${failed} -->`];
  if (checkbox) out.push('- [ ] **Design approved** — tick to approve these UI changes');
  else out.push(`<sub>Design review: add the \`${label || 'design-approved'}\` label to approve these UI changes.</sub>`);
  return out.join('\n');
}
function parse(body) {
  const text = body || '';
  const i = text.indexOf(START), j = text.indexOf(END);
  if (i === -1 || j < i) return null;
  const section = text.slice(i, j);
  const m = section.match(MARK);
  if (!m) return null;
  const box = section.match(BOX);
  return { sha: m[1], pages: +m[2], failed: +m[3], checked: box ? box[1] !== ' ' : null };
}
// Tick (with an "Approved by" line) or untick the box; text outside the section is kept.
function setApproval(body, by, sha) {
  const i = body.indexOf(START), j = body.indexOf(END);
  let section = body.slice(i, j).replace(APPROVED_LINE, '');
  section = section.replace(BOX, (line) => {
    const ticked = line.replace(/^- \[( |x|X)\]/, `- [${by ? 'x' : ' '}]`);
    return by ? `${ticked}\n✅ Approved by @${by} for \`${sha.slice(0, 7)}\`` : ticked;
  });
  return body.slice(0, i) + section + body.slice(j);
}
module.exports = { CONTEXT, counts, pendingText, block, parse, setApproval };
if (require.main !== module) return;

// --- GitHub ------------------------------------------------------------------------
const a = args();
const REPO = process.env.GH_REPO || process.env.GITHUB_REPOSITORY;
const note = (m) => console.error(`ui-diff: ${m}`);
const gh = (...argv) => execFileSync('gh', argv, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();
const ghQuiet = (...argv) => {
  try { return execFileSync('gh', argv, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; }
};
const readEvent = () => JSON.parse(fs.readFileSync(a.event || process.env.GITHUB_EVENT_PATH, 'utf8'));
const label = a.label || 'design-approved';

function setStatus(sha, state, description, target) {
  const f = ['-f', `state=${state}`, '-f', `context=${CONTEXT}`, '-f', `description=${description.slice(0, 140)}`];
  if (target) f.push('-f', `target_url=${target}`);
  gh('api', '-X', 'POST', `repos/${REPO}/statuses/${sha}`, ...f, '--silent');
  note(`${CONTEXT} → ${state}: ${description}`);
}
// "Approved by @x" if <sha>'s current review status is an approval, else null.
function approvedBy(sha) {
  const out = ghQuiet('api', `repos/${REPO}/commits/${sha}/status`);
  const s = out && (JSON.parse(out).statuses || []).find((x) => x.context === CONTEXT);
  const m = s && s.state === 'success' && /^Approved by @([\w.[\]-]+)/.exec(s.description || '');
  return m ? m[1] : null;
}
// The login our comments are posted as: the token's user, or github-actions[bot] for
// GITHUB_TOKEN (which can't read /user). UI_DIFF_BOT_LOGIN overrides (GitHub App tokens).
function botLogin() {
  return process.env.UI_DIFF_BOT_LOGIN || ghQuiet('api', 'user', '--jq', '.login') || 'github-actions[bot]';
}
function canWrite(user) {
  const out = ghQuiet('api', `repos/${REPO}/collaborators/${encodeURIComponent(user)}/permission`);
  if (!out) return false;
  const p = JSON.parse(out);
  return WRITE.has(p.role_name) || WRITE.has(p.permission);
}
function patchComment(id, body) {
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ui-diff-')), 'body.md');
  fs.writeFileSync(tmp, body);
  gh('api', '-X', 'PATCH', `repos/${REPO}/issues/comments/${id}`, '-F', `body=@${tmp}`, '--silent');
}
// The PR's ui-diff comment posted by the bot, if any.
function findComment(pr, bot) {
  const out = gh('api', `repos/${REPO}/issues/${pr}/comments`, '--paginate', '--jq',
    `.[] | select(.body | contains("${START}")) | {id, html_url, body, login: .user.login} | @json`);
  return out.split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((c) => c.login === bot) || null;
}

// --- commands ------------------------------------------------------------------------
const cmd = a._[0];
if (cmd === 'carry') {
  const by = approvedBy(a.sha);
  const body = fs.readFileSync(a.body, 'utf8');
  if (by && parse(body) && parse(body).checked === false) {
    fs.writeFileSync(a.body, setApproval(body, by, a.sha));
    note(`${a.sha.slice(0, 7)} was already approved by @${by}; keeping it`);
  }
} else if (cmd === 'status') {
  const { items } = JSON.parse(fs.readFileSync(path.join(a.report, 'results.json'), 'utf8'));
  const c = counts(items);
  if (!c.pages && !c.failed) {
    setStatus(a.sha, 'success', 'No visual changes', a.target);
  } else if (approvedBy(a.sha)) {
    note(`${a.sha.slice(0, 7)} is already approved; leaving the status`);
  } else {
    setStatus(a.sha, 'pending', pendingText(c), a.target);
    // An approval label from an earlier commit doesn't carry over.
    const e = a.event ? readEvent() : {};
    const pr = e.pull_request;
    if (pr && (pr.labels || []).some((l) => l.name === label)) {
      ghQuiet('api', '-X', 'DELETE', `repos/${REPO}/issues/${pr.number}/labels/${encodeURIComponent(label)}`);
      note(`removed the '${label}' label (it approved an earlier commit)`);
    }
  }
} else if (cmd === 'event') {
  handle(readEvent()); // ignoring an event is not a failure
} else {
  console.error('Usage: review.cjs carry|status|event (see the header)');
  process.exit(1);
}

// Returns true if it changed anything; logs why when it ignores an event.
function handle(e) {
  const ignore = (why) => { note(`ignored: ${why}`); return false; };
  const sender = e.sender && e.sender.login;
  const bot = botLogin();
  if (!sender) return ignore('no sender in the event');
  if (sender === bot) return ignore(`the edit was made by ${bot} itself`);

  let pr, approve, comment;
  if (e.comment && e.issue) {
    // A ticked or unticked box in the ui-diff comment.
    if (e.action !== 'edited') return ignore(`comment ${e.action}, not edited`);
    if (!e.issue.pull_request) return ignore('not a pull request comment');
    if (!e.comment.body.includes(START)) return ignore('not the ui-diff comment');
    if (e.comment.user.login !== bot) return ignore(`comment author ${e.comment.user.login} isn't ${bot}`);
    const now = parse(e.comment.body);
    const was = parse(e.changes && e.changes.body && e.changes.body.from);
    if (!now || now.checked === null) return ignore('the comment has no approval box');
    if (!was || was.checked === now.checked || was.sha !== now.sha) return ignore("the approval box didn't change");
    pr = e.issue.number;
    approve = now.checked;
    comment = { id: e.comment.id, html_url: e.comment.html_url };
  } else if (e.pull_request && ['labeled', 'unlabeled'].includes(e.action)) {
    if (!e.label || e.label.name !== label) return ignore(`label '${e.label && e.label.name}' isn't '${label}'`);
    pr = e.pull_request.number;
    approve = e.action === 'labeled';
    // The comment, or the PR description in description mode.
    comment = findComment(pr, bot);
    if (!comment && !parse(e.pull_request.body)) return ignore(`PR #${pr} has no ui-diff result from ${bot} yet`);
  } else {
    return ignore(`unsupported event (${e.action || 'no action'})`);
  }

  if (!canWrite(sender)) return ignore(`@${sender} doesn't have write access to ${REPO}`);

  // Re-read: the result must still be for the commit that's now the PR head.
  const p = JSON.parse(gh('api', `repos/${REPO}/pulls/${pr}`));
  const current = comment ? JSON.parse(gh('api', `repos/${REPO}/issues/comments/${comment.id}`)) : p;
  const r = parse(current.body);
  if (!r) return ignore('no review marker in the ui-diff result (require-approval off, or no visual changes)');
  if (r.sha !== p.head.sha) return ignore(`the result is for ${r.sha.slice(0, 7)} but the PR head is ${p.head.sha.slice(0, 7)} (stale)`);
  if (e.comment && r.checked !== approve) return ignore('the box changed again since this event');

  const target = comment ? comment.html_url || current.html_url : p.html_url;
  if (approve) {
    setStatus(r.sha, 'success', `Approved by @${sender}`, target);
    if (comment && r.checked !== null) patchComment(comment.id, setApproval(current.body, sender, r.sha));
  } else {
    if (!approvedBy(r.sha)) return ignore(`${r.sha.slice(0, 7)} isn't approved; nothing to undo`);
    setStatus(r.sha, 'pending', pendingText(r), target);
    if (comment && r.checked !== null) patchComment(comment.id, setApproval(current.body, null, r.sha));
  }
  return true;
}
