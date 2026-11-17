// Shared helpers: resolve deps from the ui-diff tools dir, parse simple --flag args,
// and the PNG / changed-region helpers used by diff.cjs and compare.cjs.
const fs = require('fs');
const path = require('path');
const os = require('os');

const TOOLS_DIR =
  process.env.UI_DIFF_HOME ||
  path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'ui-diff');

function need(name) {
  try {
    return require(require.resolve(name, { paths: [TOOLS_DIR] }));
  } catch (e) {
    console.error(`Missing dependency "${name}". Run scripts/setup.sh first.`);
    process.exit(2);
  }
}

function args(argv = process.argv.slice(2)) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      if (v !== undefined) out[k] = v;
      else if (argv[i + 1] && !argv[i + 1].startsWith('--')) out[k] = argv[++i];
      else out[k] = true;
    } else out._.push(a);
  }
  return out;
}

// "/settings/profile?tab=1" -> "settings-profile-tab-1", "/" -> "home"
function slug(route) {
  const s = route.replace(/^https?:\/\/[^/]+/, '').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '');
  return s || 'home';
}

// --- PNG helpers (pngjs is loaded lazily so non-image scripts don't need it) ---------
const PNG = () => need('pngjs').PNG;
const readPng = (p) => PNG().sync.read(fs.readFileSync(p));
const writePng = (p, png) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, PNG().sync.write(png));
};
const blank = (w, h) => {
  const out = new (PNG())({ width: w, height: h });
  out.data.fill(255);
  return out;
};

// Place img on a w×h canvas (top-left), filling the rest with opaque white, so images
// of different sizes can still be compared; the padding shows up as change.
function padTo(img, w, h) {
  if (img.width === w && img.height === h) return img;
  const out = blank(w, h);
  PNG().bitblt(img, out, 0, 0, Math.min(img.width, w), Math.min(img.height, h), 0, 0);
  return out;
}

function crop(img, { x, y, w, h }) {
  const out = new (PNG())({ width: w, height: h });
  PNG().bitblt(img, out, x, y, w, h, 0, 0);
  return out;
}

// Group diff pixels (pure red in pixelmatch output) into rectangular regions.
//   grid      px; diff pixels are clustered on this grid to find separate regions
//   pad       px of context around each region
//   reach     cells of gap allowed between pixels of one region (nearby edits merge)
//   minCell   diff pixels a cell needs to count (raise it to ignore scattered AA noise)
//   max       regions kept (largest first); the rest are counted in `omitted`
function findRegions(diff, { grid = 24, pad = 32, reach = 2, minCell = 1, max = 6 } = {}) {
  const gw = Math.ceil(diff.width / grid);
  const gh = Math.ceil(diff.height / grid);
  const counts = new Uint32Array(gw * gh);
  for (let y = 0; y < diff.height; y++) {
    for (let x = 0; x < diff.width; x++) {
      const i = (y * diff.width + x) * 4;
      if (diff.data[i] === 255 && diff.data[i + 1] === 0 && diff.data[i + 2] === 0) {
        counts[Math.floor(y / grid) * gw + Math.floor(x / grid)]++;
      }
    }
  }
  const cells = counts.map((n) => (n >= minCell ? 1 : 0));
  // Connected components over the grid.
  const seen = new Uint8Array(gw * gh);
  const boxes = [];
  for (let c = 0; c < cells.length; c++) {
    if (!cells[c] || seen[c]) continue;
    let [x0, y0, x1, y1] = [Infinity, Infinity, -1, -1];
    let count = 0;
    let pixels = 0;
    const stack = [c];
    seen[c] = 1;
    while (stack.length) {
      const k = stack.pop();
      const cx = k % gw;
      const cy = (k - cx) / gw;
      x0 = Math.min(x0, cx); y0 = Math.min(y0, cy); x1 = Math.max(x1, cx); y1 = Math.max(y1, cy);
      count++;
      pixels += counts[k];
      for (let dy = -reach; dy <= reach; dy++) {
        for (let dx = -reach; dx <= reach; dx++) {
          const nx = cx + dx, ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue;
          const n = ny * gw + nx;
          if (cells[n] && !seen[n]) { seen[n] = 1; stack.push(n); }
        }
      }
    }
    const x = Math.max(0, x0 * grid - pad);
    const y = Math.max(0, y0 * grid - pad);
    boxes.push({
      x, y,
      w: Math.min(diff.width, (x1 + 1) * grid + pad) - x,
      h: Math.min(diff.height, (y1 + 1) * grid + pad) - y,
      cells: count,
      pixels,
    });
  }
  boxes.sort((a, b) => b.cells - a.cells);
  const kept = boxes.slice(0, max).sort((a, b) => a.y - b.y || a.x - b.x);
  return { kept, omitted: boxes.length - kept.length };
}

module.exports = { TOOLS_DIR, need, args, slug, readPng, writePng, blank, padTo, crop, findRegions };
