#!/usr/bin/env node
// Export a Figma frame as PNG through the Figma REST API (for compare.cjs).
//
// Usage:
//   FIGMA_TOKEN=... node figma-export.cjs "<figma.com/design/<key>/...?node-id=1-2>" \
//     --out design.png [--scale 2]
//
// FIGMA_TOKEN is a personal access token with "File content: read" scope
// (Figma → Settings → Security → Personal access tokens). An agent with a Figma
// tool (e.g. the Figma MCP server's get_screenshot) can use that instead.
// Prints {"out","fileKey","nodeId","width","height"} on success.
// Exit codes: 1 = bad input / API error, 2 = FIGMA_TOKEN not set.
const fs = require('fs');
const path = require('path');
const { args } = require('./lib.cjs');

// figma.com/{design,file,proto}/<key>[/branch/<branchKey>]/<name>?node-id=1-2
// → { fileKey, nodeId: "1:2" }. Branch links use the branch key. Throws on anything else.
function parseFigmaUrl(input) {
  let u;
  try {
    u = new URL(String(input).trim());
  } catch {
    throw new Error(`not a URL: ${input}`);
  }
  if (!/(^|\.)figma\.com$/.test(u.hostname)) throw new Error(`not a figma.com link: ${input}`);
  const parts = u.pathname.split('/').filter(Boolean);
  if (!['design', 'file', 'proto'].includes(parts[0]) || !parts[1]) {
    throw new Error(`expected a figma.com/design/<fileKey>/… link, got ${u.pathname}`);
  }
  const fileKey = parts[2] === 'branch' && parts[3] ? parts[3] : parts[1];
  const raw = u.searchParams.get('node-id'); // already percent-decoded
  if (!raw) throw new Error('link has no node-id: in Figma, select the frame and use "Copy link to selection"');
  // URLs write "1:2" as "1-2" (instances: "I1-2;3-4"); the API wants colons.
  const nodeId = raw.replace(/-/g, ':');
  if (!/^I?\d+:\d+(;I?\d+:\d+)*$/.test(nodeId)) throw new Error(`unexpected node-id "${raw}"`);
  return { fileKey, nodeId };
}

// Width/height from a PNG's IHDR chunk, without decoding it.
const pngSize = (buf) => ({ width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) });

async function main() {
  const a = args();
  const link = a._[0] || a.url;
  if (!link || !a.out) {
    console.error('Usage: figma-export.cjs <figma frame url> --out design.png [--scale 2]');
    process.exit(1);
  }
  const token = process.env.FIGMA_TOKEN;
  if (!token) {
    console.error('FIGMA_TOKEN is not set. Create a personal access token (File content: read) in Figma → Settings → Security, or export the frame with a Figma tool and save the PNG yourself.');
    process.exit(2);
  }
  const { fileKey, nodeId } = parseFigmaUrl(link);
  const scale = Number(a.scale ?? 1);
  if (!(scale >= 0.01 && scale <= 4)) throw new Error('--scale must be between 0.01 and 4');

  const api = `https://api.figma.com/v1/images/${fileKey}?ids=${encodeURIComponent(nodeId)}&format=png&scale=${scale}`;
  const res = await fetch(api, { headers: { 'X-Figma-Token': token } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.err) {
    const why = { 403: 'token invalid or no access to this file', 404: 'file not found', 429: 'rate limited, wait and retry' }[res.status] || '';
    throw new Error(`Figma API ${res.status}: ${body.err || body.message || res.statusText}${why ? ` (${why})` : ''}`);
  }
  const imgUrl = body.images && body.images[nodeId];
  if (!imgUrl) throw new Error(`Figma rendered nothing for node ${nodeId} (deleted, invisible or empty?)`);

  const img = await fetch(imgUrl);
  if (!img.ok) throw new Error(`downloading the render failed: HTTP ${img.status}`);
  const buf = Buffer.from(await img.arrayBuffer());
  fs.mkdirSync(path.dirname(path.resolve(a.out)), { recursive: true });
  fs.writeFileSync(a.out, buf);
  console.log(JSON.stringify({ out: a.out, fileKey, nodeId, scale, ...pngSize(buf) }));
}

if (require.main === module) {
  main().catch((e) => {
    console.error(String(e.message || e));
    process.exit(1);
  });
}

module.exports = { parseFigmaUrl };
