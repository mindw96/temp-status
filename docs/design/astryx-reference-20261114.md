# Astryx reference styling — 2026-11-14 KST

Active design: `vAstryx-reference-20261114`.

The user chose Astryx as a visual reference while retaining the current
lightweight deployment. This adaptation uses neutral, opaque surfaces, restrained
borders, flatter controls and reduced decorative shadows/blur on `/` and `/a100`.
It does not copy Astryx source code or install Astryx, React or other dependencies.

## Official references

- [Astryx documentation](https://astryx.atmeta.com/)
- [Official repository README](https://github.com/meta/astryx/blob/main/README.md)
- [Core package README](https://github.com/meta/astryx/blob/main/packages/core/README.md)

These references inform the visual direction, not an exact reproduction of the
Astryx component system.

## Scope

- Adjust existing light/dark color tokens and surface, border, radius, shadow
  and backdrop styles in `design-system.css`, `styles.css`, `a100.css` and
  `sbatch-rankings.css`.
- Match the browser theme-color values and nonvisual HTML design markers.
- Keep Noto Sans / Noto Sans KR, existing font sizes, spacing, compact GPU card
  geometry and responsive rules.
- Preserve GPU allocation/observation, unallocated, unknown and offline states,
  status colors, utilization meters, polling, sorting, filters, pagination,
  dialogs, theme persistence and reduced-motion behavior.
- Retain collectors, API contracts, storage, build/deployment architecture and
  existing runtime dependencies.

Build, browser and production verification results are recorded separately;
this design note does not establish their outcome.

## Previous-version backup and recovery

- Recovery tag: `pre-astryx-reference-20261114`.
- Source commit: `a527df955014fd0640e34d7b4dabbcc1a0c81af0`.
- Local backup directory:
  `/Users/mindw/Documents/Codex/2026-09-22/sites-plugin-sites-openai-curated-remote/backups/pre-astryx-reference-20261114/`.
- Source archive: `temp-status-pre-astryx-reference-20261114.zip`.
- Archive SHA-256:
  `8b15c8fe1152f86c52ed13699a88a731ed968f78240bb6d5e23da5132cc923ef`.

The source-only archive excludes environment secrets and live collector data.
Its checksum applies to this local ZIP, not a GitHub-generated archive.

Inspect the preserved source in a separate worktree:

```bash
git worktree add --detach ../temp-status-pre-astryx-reference-20261114 pre-astryx-reference-20261114
```

Recover through a reviewed new commit restoring the relevant frontend files,
then build and verify before pushing. Existing Render automatic deployment may
run when `main` is pushed. Do not reset history or move existing version tags,
including v261011, vApple and vToss.

## Local validation

- Build, Slurm job-filter/badge tests, polling tests and Render server tests passed.
- Chrome checks used the unchanged public API through a read-only local preview.
- Checked main/A100 pages, light/dark themes, Groups dialog, server filtering, Priority sorting, Ranking panel and reciprocal navigation.
- Viewports: 1920×1080, 1080×1920 and 390×844. Portrait retained four server columns; mobile had no page-level horizontal overflow.
- First desktop GPU card remained 336×110.984375px with 5px 10px padding and the same Noto font stack.
- The four active CSS files total 58670 → 56310 bytes; summed gzip size 13418 → 13092 bytes.
- Dependency manifest/lockfile and dashboard data/render scripts were unchanged. Theme script changes only browser theme-color constants.
- Six representative text/background pairs meet 4.5:1 contrast; this is not a complete accessibility audit.
