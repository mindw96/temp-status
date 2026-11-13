# Active dashboard design: vAstryx-reference-20261114

Requested on 2026-11-14 KST: a small, CSS-only restyle of `/` and `/a100`, using
[Astryx](https://astryx.atmeta.com/) as a visual reference for neutral, flat
surfaces and controls. This is a local design adaptation; no Astryx source code,
React runtime or new dependency is included.

## Active implementation

- `public/design-system.css`: shared light/dark tokens, flat surfaces and
  Noto Sans / Noto Sans KR font import.
- `public/styles.css`: dashboard surfaces, controls, table and dialogs.
- `public/a100.css`: matching A100 surfaces and controls.
- `public/sbatch-rankings.css`: matching ranking launcher, panel and tabs.
- `public/theme.js`: existing saved/system theme behavior, with matching
  theme-color values.
- `public/motion.css` and `public/motion.js`: existing transitions and
  reduced-motion handling.

Keep the existing Noto typography, font sizes, compact GPU card geometry,
responsive layout and all behavior. Preserve allocated, unallocated, unavailable
and offline GPU distinctions, status colors and utilization meters. Collector
protocols, APIs, storage and the existing Render/Worker architecture stay intact.

The vApple and vToss CSS files remain available as historical source, but are not
loaded by either active HTML entry point. The HTML root and meta version markers
identify the active design without adding a visible dashboard label.

## Preserved alternatives

- [vApple reference](docs/design/references/vApple.md)
- [vToss reference](docs/design/references/vToss.md)
- [Version and recovery records](docs/design/versions.md)
- [Previous v261011 restoration](docs/design/restore-v261011-20261012.md)
- [Astryx reference scope and recovery](docs/design/astryx-reference-20261114.md)

The supplied reference documents describe their respective archived versions;
they do not override the current user-requested design. Existing version tags
remain immutable.
