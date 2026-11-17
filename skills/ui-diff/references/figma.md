# Comparing with a Figma design

Read this only when the user gives a Figma link, or a route in `.ui-diff.json` has a
`figma` key. It adds a "vs design" check: the implementation (head screenshot) next to
the Figma frame, with the areas that differ most boxed.

**Set expectations.** A design and a real render never match pixel for pixel: fonts
render differently, the design has placeholder copy and data, frames are often idealized
or out of date. Treat every boxed area as a **prompt for a human look, not a verdict**.
Never write "doesn't match the design" or "matches the design"; write what differs
("the CTA sits below the price in the build, beside it in the design").

## 1. Which frame goes with which screenshot

The user needs a link to a **frame**, not just the file: in Figma, select the frame and
use *Copy link to selection*. It looks like
`https://www.figma.com/design/<fileKey>/<name>?node-id=12-34`. Without `node-id`, ask for one.

Pair each frame with one route **and one viewport**. A 1440-wide frame goes with the
desktop screenshot, a 390-wide one with mobile. In `.ui-diff.json`, a string `figma`
applies to the first viewport; use an object for several:

```json
{ "path": "/pricing", "figma": { "desktop": "https://www.figma.com/design/…?node-id=1-2",
                                 "mobile":  "https://www.figma.com/design/…?node-id=1-9" } }
```

Captures and `results.json` items then carry the matching `figma` link.

## 2. Get the frame as PNG

Use whichever works, in this order:

1. **A Figma tool you already have** (e.g. the Figma MCP server's `get_screenshot` with the
   file key and node id, `-` → `:`). Save the image to `.ui-diff/design-src/<name>.png`.
   If the tool returns an image you can see but not a file, use option 2.
2. **The REST API**, if `FIGMA_TOKEN` is set (a personal access token with *File content:
   read*, from Figma → Settings → Security):
   ```bash
   node $SKILL/scripts/figma-export.cjs "<frame url>" --out .ui-diff/design-src/pricing__desktop.png --scale 2
   ```
   Use `--scale 2` when the screenshot is 2× (mobile viewports are), `1` for desktop.
   Exit 2 means no token: ask the user for one or for an exported PNG. Never put the
   token in a file in the repo.
3. **A PNG the user exports** (frame → Export → PNG).

Keep design PNGs out of `.ui-diff/report/`: only what's in the report gets published.

## 3. Compare

Run after `run.sh` (it clears the report). Use the head screenshot from
`.ui-diff/shots/after/<name>__<viewport>.png` (it's there for every route, changed or not):

```bash
node $SKILL/scripts/compare.cjs --design .ui-diff/design-src/pricing__desktop.png \
  --actual .ui-diff/shots/after/pricing__desktop.png --out .ui-diff/report/design \
  --name pricing__desktop --label "/pricing — desktop" --figma "<frame url>"
```

Both images are scaled to the narrower width; the taller one is cropped (`--fit pad` to
compare the full height instead, which shows the extra length as a change). Pixelmatch
runs with a lenient threshold (`--threshold 0.3`) and scattered antialiasing noise is
ignored (`--min-cell`). Output in `--out`:

- `<name>__composite.png`: design | implementation | diff, numbered boxes on all three.
- `zoom/<name>__r<i>__{design,actual,diff}.png`: crops of each boxed area.
- `<name>.json`: `percent`, `regions` (in compared-image pixels), and `notes` (height or
  width mismatch, which usually means the wrong frame or viewport).

`comment.cjs` adds a "vs design" section automatically when `.ui-diff/report/design/`
has results, and `publish.sh` uploads those images with the rest.

## 4. Read it and write it up

Open the composite first, then the zooms. For each boxed area, decide what kind of
difference it is:

- **Probably worth flagging:** missing or extra elements, different order or layout,
  wrong component variant, clearly different color, size or spacing, things cut off.
- **Usually noise; mention once at most:** font smoothing, placeholder vs real text and
  images, slightly different line breaks, the page simply being longer than the frame.

Where the PR's measured values (`measured.md`) or the Figma tool's design context give
exact numbers, use them rather than estimating from pixels. Add a short **vs design**
part to `summary.md`, e.g.:

```markdown
**vs design** (`/pricing`, desktop)
- The "Most popular" label is above the card in the build, inside it in the design.
- Card padding looks tighter than the frame. Worth checking with design.
- Otherwise close; remaining differences are font rendering and real prices.
```

If a note says the widths or heights differ a lot, check you paired the right frame
and viewport before reporting anything.
