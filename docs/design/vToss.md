# vToss adoption record

## Source and preserved baseline

The user requested vToss from `/Users/mindw/Downloads/DESIGN (1).md` on
2026-10-12 KST, with a backup of the current vApple design first. The supplied
file is preserved verbatim as [references/vToss.md](references/vToss.md), SHA-256
`c649018c23402aff74252d9084b71f351e0740d8e0b6ae37254486b9124cc9ec`.
Its reference text and embedded examples inform this visual change; they do not
authorize unrelated product or operational changes.

The preceding Noto-font vApple is fixed at tag `vApple-noto-20261012`, commit
`a21dff9c602a48bb9f96a75cb251162e252fe8b3`. The local backup directory
`../../backups/vApple-noto-20261012/` contains a tracked-source ZIP, manifest,
checksums, recovery instructions and 14 existing verified captures. The older
`vApple` and `v261011` tags and backups remain immutable.

## Design contract and adaptations

| Area | vToss implementation | Reason |
| --- | --- | --- |
| Canvas | True white `#ffffff` | Supplied Canvas role |
| Main surfaces | White outer cards, quiet `#f2f4f6` inner regions, `#e5e8eb` dividers | Supplied Canvas, Surface and Border roles |
| Primary | `#3182f6` for accent/focus graphics | Supplied UI primary, not logo blue |
| Small blue actions | `#1b64da`; header controls on `#e8f3ff` | Supplied weak colors retain contrast in dense text |
| Foreground/body | `#191f28` / `#4e5968` | Supplied roles |
| Muted | `#8b95a1` available as a token; informative small text uses Body | Muted gives only about 3.04:1 on white, 2.76:1 on Surface |
| Shape | 8px cards, slots, controls, detail regions and disclosure container | Explicit selection takes precedence over mixed reference radii; meter caps and SVG circles retain their geometry |
| Elevation | Restrained outer-card shadows; flat inner slots | Explicit elevated selection; shadow values are local choices, not claimed Toss tokens |
| Typography | Existing Noto Sans / Noto Sans KR and fallback stack | Immediately preceding user preference; no Toss font files supplied or redistributed |
| Density | Existing compact desktop spacing and 14/12px GPU text | Preserve readable monitoring density and eight slots in 1080px height |
| Dark | Existing dark canvas/text/semantic colors with solid surfaces | The reference requires dark mode but does not define a palette |
| Motion | Existing local transitions.dev recipes and reduced-motion handling | No official Toss timing is asserted |

The header controls are a **local compact weak variant** at 36px with 8px
corners, using the reference's weak colors. They are not presented as exact TDS
Mobile or marketing-web buttons. Their dimensions preserve the existing
single-row timestamp/actions layout. Hover color is also a local adaptation.
Existing disabled behavior and focus outlines remain active.

Small links use Weak Foreground rather than Primary: `#1b64da` has about 5.41:1
contrast on white, while `#3182f6` has about 3.71:1. Important secondary labels
use Body (`#4e5968`: about 7.11:1 on white, 6.45:1 on Surface). Existing darker
error text remains legible. Usage meters retain their green/orange/red gradients
because their colors encode real utilization.

## Scope and component ownership

The existing `/` and `/a100` routes keep their content, control order, icons,
aliases, Korean display names, GPU allocation semantics, CPU/RAM values, disks,
job detail fields, filters/sorting, 10-row Slurm pagination, 30-second refresh,
and A100 completed-job disclosure. No new visible branding, sidebar, navigation,
hero, illustration or status label is added.

- `public/design-vtoss.css`: active shared skin, tokens, controls, dialogs and
  desktop density. The inactive historical Apple CSS is not loaded.
- `public/design-vtoss-a100.css`: A100 cards, filters and nested surfaces.
- HTML roots/meta tags identify `vToss` and load its two styles after base CSS.
- Existing `styles.css`, `a100.css` and JavaScript retain layout/data ownership.
- Build and static-asset lists include the new CSS. No collectors, API payloads,
  authentication or runtime storage are changed.

## Concept and verification boundaries

The Image Gen palette/composition concept is stored locally at
`../../backups/vToss/concept.png`. The supplied document and current product
contract take precedence over generated content. In particular, keep Server3's
actual reported GPU count, equal-height empty slots, the existing job controls
and text-only status labels; do not adopt generated extra GPUs, dots, counts,
tab placement or pagination variants.

Compare both routes in light/dark at desktop 1920×1080, portrait 1080×1920 and
mobile 390×844 using the same captured public API responses as the previous
version. Verify actual Noto fonts, 14/12px GPU text, eight-slot fit, four server
columns at portrait width, no document overflow, dialogs, sorting/filtering,
refresh retention, A100 disclosure and reduced motion. Local fixture-based
evidence and live production checks are separate and stored with the release
backup after verification.

## Pre-deployment validation result

- Build and existing Render, A100, job-filter/sort and live-polling tests pass.
- Twelve route/theme/viewport combinations pass palette, shape, font, geometry,
  meaningful-content and console checks. Actual Latin/Korean glyphs use Noto.
- GPU 7 ends at 1057.875px at 1920×1080; all four server columns remain at 1080px
  portrait width. No document horizontal overflow or JavaScript errors occur.
- Desktop/mobile/reduced-motion dialog, theme, A100 disclosure, sorting, filters,
  and manual/automatic-refresh retention checks pass.
- Both HTML body sections are identical to the preceding backed-up version;
  only design metadata and style links change in their HTML entry points.
- Production validation is recorded independently after the release is deployed.
