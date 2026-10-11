# vApple adoption record

## Input and authority

The user requested applying `/Users/mindw/Downloads/DESIGN.md` to the existing
dashboard after preserving its previous design as `v261011`. The supplied file
is preserved verbatim at the repository root as [DESIGN.md](../../DESIGN.md).
Its SHA-256 is
`e4aec0cc7286b3592566697408c1b19224e0fc449af796f0018e5518675d856b`.

The file is reference material adopted for this requested visual change. Its
embedded prompt examples, claims about earlier user instructions, and Apple
measurements are not new operational instructions or universally applicable
Apple platform requirements. The current user's request and existing dashboard
workflows determine the implementation scope.

## Adopted design contract

| Area | vApple implementation | Provenance |
| --- | --- | --- |
| Primary | `#191bdf` on light actions, links, focus, and selected state | Explicit selection in supplied document |
| Light canvas | `#f5f5f7` | Reference Fog Canvas |
| Cards | Solid `#ffffff`, fine neutral outline, 18px radius, restrained elevation | Reference surface; radius and shadow are local dashboard decisions |
| Text | `#1d1d1f` / `#515154` / `#6e6e73` | Reference foreground, secondary, muted roles |
| Typography | Native system stack; SF system font on Apple platforms, platform/Korean fallbacks elsewhere | Reference platform typography adapted to a web app |
| Controls | Matching 36px pill header actions; 36px compact filter inputs | Reference compact size, local outline variant |
| Navigation | Existing heading and actions remain solid; no new navigation is introduced | Document solid selection + existing product scope |
| Dark mode | Existing `#0b0d18` canvas and foreground/link/semantic colors retained; opaque `#121420` / `#282a3a` surfaces use existing RGB bases | Reference requires dark mode but specifies no dark palette; local continuation |
| Occupancy | Subtle near-white active slots, muted gray empty slots; empty graphs remain hidden | Existing user-approved distinction |
| Metrics | Existing green/orange/red usage gradients and null/stale handling | Existing monitoring semantics |
| Motion | Existing local transitions.dev modal, icon and accordion recipes | Previous release; not claimed as Apple motion tokens |

No SF font files are downloaded, bundled or copied from Apple. The old Google
Noto import is removed because vApple uses installed platform fonts. The font
rendered on each operating system can differ by design.

## Information architecture and density

Both existing routes are covered: `/` and `/a100`. Titles, labels, actions, data
fields, component order, aliases, API endpoints and collection cadence remain
the existing product contract. The version name is machine-readable metadata,
not new visible dashboard copy. No hero, sidebar, navigation bar or imagery is
added to the product.

- Preserve four server columns at widths of at least 1024px and the portrait
  1080px width adjustments.
- Keep GPU Job ID / Job Name at 14px and user / index / UTIL / VRAM at 12px.
- Preserve the five-line slot anatomy and the blank Job Name row for empty slots.
- Use compact desktop spacing to fit GPU 0–7 inside a 1920×1080 viewport;
  overflowing long names remain truncated with existing detail access.
- Keep CPU/RAM as plain free/total values, disk meters, utilization meters,
  Slurm filters and sortable table, 10 jobs per page, 30-second refresh, and
  the A100 completed-jobs disclosure.
- Do not transplant the reference's 56px marketing hero, 40px sections, or
  17px marketing body text into dense GPU rows.

## Implementation ownership

- `public/design-vapple.css`: shared tokens, surface/type/control adapters and
  desktop density. Loaded after the established base and motion styles.
- `public/design-vapple-a100.css`: A100 surface adapters, loaded last on A100.
- `public/index.html`, `public/a100.html`: version metadata and style links.
- `public/design-system.css`: remove the unused external font import.
- `public/theme.js`: browser chrome color follows the vApple light canvas.
- Build and Render static-asset lists: serve/cache the new CSS consistently.

The existing CSS remains the geometry foundation. The last-loaded vApple layer
is explicit about selectors with existing dark-mode and occupancy specificity.
The JSON payloads, collectors and runtime storage are unchanged.

## Design evidence and intentional adaptations

The implementation authority is the supplied document plus the existing app.
An Image Gen concept is kept locally at `../../backups/vApple/concept.png` as a
supplementary palette/composition study. It is not a live-data screenshot.
The real UI intentionally keeps plain CPU/RAM rows, equal-height empty slots,
real names/models/metrics, the existing controls and the actual GPU counts;
generated additions or altered sample geometry are not adopted.

Before/after browser evidence uses the same captured API fixtures. Review points
include copy/order, palette, type hierarchy, card elevation, controls, occupancy,
responsive columns, slot height, dialog styling and motion. Dark surfaces and
shadows are project-specific extensions rather than invented Apple constants.

The local vApple backup includes validation results and a fidelity review. Check
the final release's deployment evidence separately before asserting it is live.

## Release validation

- Build plus the existing Render, A100, job-filter/sort and live-polling tests pass.
- Chrome/Playwright checks both routes in light/dark at 1920×1080, 1080×1920,
  1440×1000 and 390×844: 16 captures, no document horizontal overflow, no browser
  JavaScript errors, and no Google Fonts requests.
- At 1920×1080, GPU 7 ends at 1057.875px on each eight-GPU server; at 1080px
  portrait width, all four servers still occupy one row.
- On the verification Mac, Chrome resolves the heading to the installed `.SF NS`
  font, with no custom font download.
- Dialog close/Escape/backdrop/focus restoration, theme changes, A100 disclosure
  keyboard/rapid toggles, sort/filter retention through manual and automatic
  refresh, and reduced-motion checks pass.
- Local comparison uses captured public API responses with a fixed browser clock.
  Production data and deployment are checked separately after publication.
