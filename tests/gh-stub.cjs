#!/usr/bin/env node
// Stateful stand-in for `gh` for the design review tests (selftest.sh). State lives in
// $GH_STATE/state.json: comments, commit statuses, collaborator permissions, the PR head.
// Every call is appended to $GH_STATE/calls.log. Answers like GITHUB_TOKEN: /user is denied.
const fs = require('fs');
const path = require('path');

const dir = process.env.GH_STATE;
const file = path.join(dir, 'state.json');
const st = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
st.comments = st.comments || {};
st.statuses = st.statuses || {};
st.perms = st.perms || {};
const argv = process.argv.slice(2);
fs.appendFileSync(path.join(dir, 'calls.log'), argv.join(' ') + '\n');
const save = () => fs.writeFileSync(file, JSON.stringify(st, null, 2));
const BOT = 'github-actions[bot]';
const url = (pr, id) => `https://github.com/acme/demo/pull/${pr}#issuecomment-${id}`;

// gh pr comment <n> --body-file <f>
if (argv[0] === 'pr' && argv[1] === 'comment') {
  const id = String(100 + Object.keys(st.comments).length);
  const pr = argv[2];
  st.comments[id] = { id: +id, pr, body: fs.readFileSync(argv[argv.indexOf('--body-file') + 1], 'utf8'), user: { login: BOT }, html_url: url(pr, id) };
  save();
  console.log(url(pr, id));
  process.exit(0);
}
if (argv[0] !== 'api') process.exit(0);

let method = 'GET', endpoint = null, jq = null;
const fields = {};
for (let i = 1; i < argv.length; i++) {
  const x = argv[i];
  if (x === '-X') method = argv[++i];
  else if (x === '-f' || x === '-F') {
    const [k, ...v] = argv[++i].split('=');
    const val = v.join('=');
    fields[k] = val.startsWith('@') ? fs.readFileSync(val.slice(1), 'utf8') : val;
  } else if (x === '--jq') jq = argv[++i];
  else if (!x.startsWith('-')) endpoint = x;
}
const ep = endpoint.replace('{owner}/{repo}', 'acme/demo');
let m;
const out = (v) => { console.log(typeof v === 'string' ? v : JSON.stringify(v)); process.exit(0); };

if (ep === 'user') process.exit(1);
if ((m = ep.match(/^repos\/acme\/demo\/issues\/(\d+)\/comments$/))) {
  const list = Object.values(st.comments).filter((c) => c.pr === m[1] && c.body.includes('<!-- ui-diff:start -->'));
  if (jq && jq.includes('@json')) out(list.map((c) => JSON.stringify({ id: c.id, html_url: c.html_url, body: c.body, login: c.user.login })).join('\n'));
  out(list.map((c) => c.id).join('\n'));
}
if ((m = ep.match(/^repos\/acme\/demo\/issues\/comments\/(\d+)$/))) {
  const c = st.comments[m[1]];
  if (!c) process.exit(1);
  if (method === 'PATCH') { c.body = fields.body; save(); }
  out(jq === '.html_url' ? c.html_url : c);
}
if ((m = ep.match(/^repos\/acme\/demo\/pulls\/(\d+)$/))) {
  const p = { number: +m[1], head: { sha: st.head }, html_url: `https://github.com/acme/demo/pull/${m[1]}`, body: st.prBody || '' };
  out(jq === '.head.sha' ? st.head : p);
}
if ((m = ep.match(/^repos\/acme\/demo\/statuses\/(\w+)$/)) && method === 'POST') {
  (st.statuses[m[1]] = st.statuses[m[1]] || []).unshift({ ...fields });
  save();
  process.exit(0);
}
if ((m = ep.match(/^repos\/acme\/demo\/commits\/(\w+)\/status$/))) {
  const seen = new Set();
  out({ statuses: (st.statuses[m[1]] || []).filter((s) => !seen.has(s.context) && seen.add(s.context)) });
}
if ((m = ep.match(/^repos\/acme\/demo\/collaborators\/([^/]+)\/permission$/))) {
  const p = st.perms[decodeURIComponent(m[1])];
  if (!p) process.exit(1);
  out({ permission: p === 'maintain' ? 'write' : p, role_name: p });
}
if (method === 'DELETE') process.exit(0);
console.error(`gh stub: unhandled ${argv.join(' ')}`);
process.exit(1);
