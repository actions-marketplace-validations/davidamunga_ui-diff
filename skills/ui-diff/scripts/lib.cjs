// Shared helpers: resolve deps from the ui-diff tools dir and parse simple --flag args.
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

module.exports = { TOOLS_DIR, need, args, slug };
