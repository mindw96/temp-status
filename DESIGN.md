# Active dashboard design: v261011

Restored on 2026-10-12 KST at the user's request. The visual source of truth is
[v261011](https://github.com/mindw96/temp-status/tree/v261011), commit
`72ff77261dda424358b51a0d7b6469339765ae5f`, for both `/` and `/a100`.

## Active implementation

- `public/design-system.css`: original light/dark tokens, glass surfaces and
  Noto Sans / Noto Sans KR font import.
- `public/styles.css`: original dashboard layout, controls and responsive rules.
- `public/a100.css`: original A100 layout and component rules.
- `public/theme.js`: original saved/system theme behavior and theme-color values.
- `public/motion.css` and `public/motion.js`: existing transitions and
  reduced-motion handling included in v261011.

Restore the original spacing, card geometry, colors and typography together.
The vApple and vToss CSS files remain available as historical source, but are not
loaded by either active HTML entry point. The HTML root and meta version markers
identify this restoration without adding a visible dashboard label.

## Preserved alternatives

- [vApple reference](docs/design/references/vApple.md)
- [vToss reference](docs/design/references/vToss.md)
- [Version and recovery records](docs/design/versions.md)
- [This restoration](docs/design/restore-v261011-20261012.md)

The supplied reference documents describe their respective archived versions;
they do not override the current user-requested v261011 design.
