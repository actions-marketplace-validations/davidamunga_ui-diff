#!/usr/bin/env node
// Screenshot a list of routes on a running web app, deterministically, and record a
// computed-style snapshot of every visible element (used by stylediff.cjs).
//
// Usage:
//   node capture.cjs --url http://localhost:3001 --out shots/before \
//     [--routes "/,/settings"] [--config .ui-diff.json] \
//     [--viewports "desktop:1440x900,mobile:iPhone 13"] [--schemes light,dark]
//
// --routes are added to the config's routes. --viewports/--schemes override the config.
// Writes <out>/<name>__<viewport>[__<scheme>].png, a matching .styles.json, and manifest.json.
const fs = require('fs');
const path = require('path');
const { need, args, slug } = require('./lib.cjs');
const { chromium, devices } = need('playwright');

const DEFAULT_VIEWPORTS = { desktop: { width: 1440, height: 900 }, mobile: { device: 'iPhone 13' } };

// Kill motion and blinking so two captures of identical UI produce identical pixels.
const STABILIZE_CSS = `
*, *::before, *::after {
  animation-duration: 0s !important; animation-delay: 0s !important;
  transition-duration: 0s !important; transition-delay: 0s !important;
  caret-color: transparent !important; scroll-behavior: auto !important;
}`;

// Framework dev-mode chrome that would otherwise show up in screenshots.
// Errors they would have displayed are still recorded (see devOverlayError below).
const DEV_OVERLAYS = [
  'nextjs-portal', '#__next-build-watcher', '#__next-prerender-indicator',
  'vite-error-overlay', '#webpack-dev-server-client-overlay', 'astro-dev-toolbar',
  '#nuxt-devtools-container', '#svelte-inspector-host', '.tsqd-parent-container',
];

function parseViewports(spec) {
  if (!spec) return null;
  const out = {};
  for (const part of spec.split(',')) {
    const i = part.indexOf(':');
    const name = part.slice(0, i);
    const rest = part.slice(i + 1).trim();
    const m = rest.match(/^(\d+)x(\d+)$/);
    out[name] = m ? { width: Number(m[1]), height: Number(m[2]) } : { device: rest };
  }
  return out;
}

// Browser context options for one viewport. Named devices get real mobile emulation
// (touch, mobile UA, isMobile) so responsive code that checks for them behaves as on a phone.
function contextFor(vp, cfg) {
  if (vp.device) {
    const d = devices[vp.device];
    if (!d) throw new Error(`Unknown Playwright device "${vp.device}"`);
    const { defaultBrowserType, ...opts } = d;
    return { ...opts, deviceScaleFactor: Number(cfg.deviceScaleFactor || Math.min(d.deviceScaleFactor, 2)) };
  }
  return { viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: Number(cfg.deviceScaleFactor || 1) };
}

function mergeRoutes(cfgRoutes, cliRoutes) {
  const list = (cfgRoutes || []).map((r) => (typeof r === 'string' ? { path: r } : r));
  for (const p of cliRoutes) if (!list.some((r) => r.path === p && !r.actions)) list.push({ path: p });
  if (!list.length) list.push({ path: '/' });
  return list.map((r) => ({ name: r.name || slug(r.path), ...r }));
}

// A route's Figma frame for one viewport: a string means the first viewport,
// an object maps viewport name → frame URL (see references/figma.md).
function figmaFor(route, vpName, firstVp) {
  const f = route.figma;
  if (!f) return null;
  return typeof f === 'string' ? (vpName === firstVp ? f : null) : f[vpName] || null;
}

// Bring the page into a state a plain load doesn't show (open modal, hover, filled form).
// Each action is one of: {click}, {hover}, {fill: [selector, value]}, {press: key}, {wait: ms|selector}
async function runAction(page, act) {
  if (act.click) await page.click(act.click);
  else if (act.hover) await page.hover(act.hover);
  else if (act.fill) await page.fill(act.fill[0], act.fill[1]);
  else if (act.press) await page.keyboard.press(act.press);
  else if (typeof act.wait === 'number') await page.waitForTimeout(act.wait);
  else if (act.wait) await page.waitForSelector(act.wait);
}

// Runs in the page. One record per visible element: DOM path, short label, page-space box,
// a fixed set of computed styles, and WCAG contrast for elements that hold text.
function snapshotStyles() {
  const PROPS = [
    'color', 'background-color', 'background-image', 'font-family', 'font-size', 'font-weight',
    'line-height', 'letter-spacing', 'text-transform', 'text-decoration-line', 'text-align',
    'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
    'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
    'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width',
    'border-top-color', 'border-top-style', 'border-radius', 'box-shadow', 'opacity',
    'display', 'flex-direction', 'justify-content', 'align-items', 'gap', 'grid-template-columns',
    'max-width', 'min-width', 'max-height', 'min-height',
  ];
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'LINK', 'META', 'BR']);
  const MAX = 4000;
  // Normalize any CSS color (rgb, oklch, color(), named) to sRGB via a 1px canvas.
  const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  const rgbCache = new Map();
  const toRgba = (c) => {
    if (rgbCache.has(c)) return rgbCache.get(c);
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = '#000';
    ctx.fillStyle = c;
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
    const v = [r, g, b, a / 255];
    rgbCache.set(c, v);
    return v;
  };
  const hex = ([r, g, b]) => '#' + [r, g, b].map((x) => x.toString(16).padStart(2, '0')).join('');
  const lum = ([r, g, b]) => {
    const f = (v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  // First ancestor-or-self with a solid-ish background; null if an image/gradient is in the way.
  const effectiveBg = (el) => {
    for (let n = el; n; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (cs.backgroundImage && cs.backgroundImage !== 'none') return null;
      const c = toRgba(cs.backgroundColor);
      if (c[3] > 0.5) return c;
    }
    return [255, 255, 255, 1];
  };
  const out = [];
  for (const el of document.body.querySelectorAll('*')) {
    if (out.length >= MAX || SKIP.has(el.tagName)) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || Number(cs.opacity) === 0) continue;
    const tags = [];
    for (let n = el; n && n !== document.body; n = n.parentElement) tags.unshift(n.tagName.toLowerCase());
    const text = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join(' ').replace(/\s+/g, ' ').trim().slice(0, 80);
    const ident = el.id || el.getAttribute('data-testid') || el.getAttribute('aria-label') || el.getAttribute('name') ||
      (el.tagName === 'IMG' ? el.getAttribute('alt') || (el.getAttribute('src') || '').split('/').pop() : '') || '';
    const s = {};
    for (const p of PROPS) s[p] = cs.getPropertyValue(p);
    const rec = {
      path: tags.join('>'),
      tag: el.tagName.toLowerCase(),
      cls: [...el.classList].slice(0, 2).map((c) => c.slice(0, 24)),
      text, ident,
      box: [Math.round(r.x + scrollX), Math.round(r.y + scrollY), Math.round(r.width), Math.round(r.height)],
      s,
    };
    if (text) {
      const fg = toRgba(cs.color);
      const bg = effectiveBg(el);
      if (bg && fg[3] > 0.5) {
        const [l1, l2] = [lum(fg), lum(bg)].sort((a, b) => b - a);
        const size = parseFloat(cs.fontSize);
        const large = size >= 24 || (size >= 18.66 && Number(cs.fontWeight) >= 700);
        rec.contrast = { ratio: Math.round(((l1 + 0.05) / (l2 + 0.05)) * 100) / 100, fg: hex(fg), bg: hex(bg), min: large ? 3 : 4.5 };
      }
    }
    out.push(rec);
  }
  return { truncated: out.length >= MAX, elements: out };
}

// True if the framework's dev error overlay is showing (checked before we hide it).
function devOverlayError() {
  if (document.querySelector('vite-error-overlay')) return true;
  const next = document.querySelector('nextjs-portal');
  if (next && next.shadowRoot && next.shadowRoot.querySelector('[data-nextjs-dialog], [data-nextjs-toast-errors], [data-issues-count]')) return true;
  const wp = document.getElementById('webpack-dev-server-client-overlay');
  return !!(wp && wp.style.display !== 'none');
}

// Storybook's error screen (story threw, or no such story): its message, else null.
function storybookError() {
  if (!document.body.classList.contains('sb-show-errordisplay')) return null;
  const el = document.querySelector('#error-message') || document.querySelector('.sb-errordisplay');
  return ((el && el.innerText) || 'unknown error').trim().split('\n')[0].slice(0, 200);
}

async function main() {
  const a = args();
  if (!a.url || !a.out) {
    console.error('Required: --url <base url> --out <dir>');
    process.exit(1);
  }
  const cfg = a.config && fs.existsSync(a.config) ? JSON.parse(fs.readFileSync(a.config, 'utf8')) : {};
  const routes = mergeRoutes(cfg.routes, typeof a.routes === 'string' ? a.routes.split(',').filter(Boolean) : []);
  const viewports = parseViewports(a.viewports) || cfg.viewports || DEFAULT_VIEWPORTS;
  const schemes = a.schemes ? a.schemes.split(',') : cfg.colorSchemes || ['light'];
  const mask = cfg.mask || [];
  const hide = [...DEV_OVERLAYS, ...(cfg.hide || [])];
  const extraCSS = `${STABILIZE_CSS}\n${hide.join(',')} { display: none !important; }\n${cfg.css || ''}`;
  const settleMs = Number(a.settle ?? cfg.settleMs ?? 300);
  const storageState = cfg.storageState && fs.existsSync(cfg.storageState) ? cfg.storageState : undefined;

  fs.mkdirSync(a.out, { recursive: true });
  const browser = await chromium.launch();
  const manifest = [];

  for (const scheme of schemes) {
    for (const [vpName, vp] of Object.entries(viewports)) {
      const context = await browser.newContext({
        ...contextFor(vp, cfg),
        colorScheme: scheme,
        reducedMotion: 'reduce',
        locale: cfg.locale || 'en-US',
        timezoneId: cfg.timezone || 'UTC',
        storageState,
      });
      for (const route of routes) {
        const page = await context.newPage();
        const pageErrors = [];
        page.on('pageerror', (e) => pageErrors.push(String(e.message || e).split('\n')[0]));
        const url = new URL(route.path, a.url).toString();
        const file = `${route.name}__${vpName}${schemes.length > 1 ? `__${scheme}` : ''}.png`;
        const entry = { route: route.label || route.path, name: route.name, viewport: vpName, scheme, file, url };
        const figma = figmaFor(route, vpName, Object.keys(viewports)[0]);
        if (figma) entry.figma = figma;
        try {
          const resp = await page.goto(url, { waitUntil: 'load', timeout: 60000 });
          entry.status = resp ? resp.status() : null;
          await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
          if (route.waitFor) await page.waitForSelector(route.waitFor, { timeout: 15000 });
          for (const act of route.actions || []) await runAction(page, act);
          await page.evaluate(() => document.fonts && document.fonts.ready);
          await page.waitForTimeout(settleMs);
          if (await page.evaluate(devOverlayError)) entry.devOverlayError = true;
          const sbError = await page.evaluate(storybookError);
          if (sbError) pageErrors.push(`Storybook couldn't render the story: ${sbError}`);
          await page.addStyleTag({ content: extraCSS });
          await page.screenshot({
            path: path.join(a.out, file),
            fullPage: route.fullPage ?? cfg.fullPage ?? true,
            animations: 'disabled',
            caret: 'hide',
            mask: [...mask, ...(route.mask || [])].map((s) => page.locator(s)),
          });
          const styles = await page.evaluate(snapshotStyles);
          fs.writeFileSync(path.join(a.out, file.replace(/\.png$/, '.styles.json')), JSON.stringify(styles));
        } catch (e) {
          entry.error = String(e.message || e).split('\n')[0];
          console.error(`! ${url} [${vpName}/${scheme}]: ${entry.error}`);
        }
        if (pageErrors.length) entry.pageErrors = pageErrors.slice(0, 3);
        manifest.push(entry);
        await page.close();
        const flag = entry.error ? 'x' : entry.status >= 400 ? `HTTP ${entry.status}` : '✓';
        console.error(`${flag} ${file}${entry.pageErrors || entry.devOverlayError ? ' (page errors)' : ''}`);
      }
      await context.close();
    }
  }
  await browser.close();
  fs.writeFileSync(path.join(a.out, 'manifest.json'), JSON.stringify(manifest, null, 2));
  const failed = manifest.filter((m) => m.error).length;
  console.log(JSON.stringify({ out: a.out, captured: manifest.length - failed, failed }));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
