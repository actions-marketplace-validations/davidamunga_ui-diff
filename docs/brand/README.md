# Brand assets

The source of truth is the Figma file **[UI Diffs](https://www.figma.com/design/Wlx6ycTYRVkzCQ4sdRMLb8/UI-Diffs?node-id=0-1)**.
Edit there, then re-export the files below. Don't edit the exports by hand.

| File | Figma node | Export |
|---|---|---|
| `logo.svg` | `Logo/Mark` (component) | SVG |
| `header-light.png` | `README/Header — light` (instance, Light mode) | PNG @2x (2560×640) |
| `header-dark.png` | `README/Header — dark` (instance, Dark mode) | PNG @2x (2560×640) |

The mark is a before/after slider: the lavender **before** half holds a square-cornered
button, the violet **after** half holds a pill, with the slider handle between them.

Colors are variables in the `ui-diff brand` collection, with Light and Dark modes. The
header component binds every fill and stroke to them, so the two README headers are the
same component in different modes.

| Token | Light | Dark |
|---|---|---|
| `color/bg` | `#FBFAFF` | `#0E0B16` |
| `color/surface` | `#FFFFFF` | `#17131F` |
| `color/border` | `#E7E3F3` | `#2A2436` |
| `color/ink` | `#16121F` | `#F4F1FB` |
| `color/muted` | `#5F5873` | `#A89FBD` |
| `color/brand` | `#7C3AED` | `#9B6BFF` |
| `color/brand-soft` | `#EDE9FE` | `#2A1F45` |
| `color/before` | `#2563EB` | `#5B8CFF` |

Type: Geist (wordmark, text) and Geist Mono (labels, measured values).
