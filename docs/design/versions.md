# Dashboard design versions

The user requested named, recoverable design versions on 2026-10-11 (KST).
These names identify frontend releases, not a change to the collector protocol.

| Version | Source reference | Scope |
| --- | --- | --- |
| [v261011](https://github.com/mindw96/temp-status/tree/v261011) | `72ff77261dda424358b51a0d7b6469339765ae5f` | Previous Noto Sans, glass surfaces, existing modal/icon/disclosure transitions; main and A100 pages. |
| [vApple](https://github.com/mindw96/temp-status/tree/vApple) | Annotated `vApple` tag | User-supplied `DESIGN.md`, system fonts, compact solid controls, elevated surfaces, primary `#191bdf`, and retained dark mode. See [adoption decisions](vApple.md). |
| [vApple-noto-20261012](https://github.com/mindw96/temp-status/tree/vApple-noto-20261012) | `a21dff9c602a48bb9f96a75cb251162e252fe8b3` | vApple with the v261011 Noto Sans / Noto Sans KR font stack restored; exact baseline before vToss. |
| [vToss](https://github.com/mindw96/temp-status/tree/vToss) | Annotated `vToss` tag | Supplied Toss reference, white canvas, blue/gray roles, 8px shapes, compact elevated cards and Noto fonts. See [adoption decisions](vToss.md). |

Tags are immutable snapshots. Do not move `v261011` or `vApple` to a newer commit.

The Noto typography amendment is preserved by `vApple-noto-20261012`. The
original `vApple` tag and backup remain the initial release. The active design
on `main` is now vToss.

Use a new dated version for subsequent named releases. The active design is also
identified by `data-design-version` and a `design-version` meta tag in both HTML
entry points; there is no extra version label in the dashboard itself.

## v261011 backup

- Annotated tag points to `72ff77261dda424358b51a0d7b6469339765ae5f`.
- [Download the tagged source from GitHub](https://github.com/mindw96/temp-status/archive/refs/tags/v261011.zip).
- Additional local backup: `../../backups/v261011/` relative to this checkout.
- Local tracked-source archive: `temp-status-v261011.zip` (50 files).
- Local archive SHA-256: `e14478e28407269969d949b33f910965c18f85542d6d45aa2666fe1c4cf35519`.
- `manifest.json`, `SHA256SUMS`, and `README.md` record integrity and recovery.
- Eight reference screenshots cover both themes on main desktop, portrait,
  mobile, and A100 desktop. They use a captured public API response and fixed
  browser clock so before/after comparisons do not mix different job data.
- The archive contains tracked source, not environment secrets or a live data
  backup. Reports continue to come from the existing collectors.

The local `git archive` ZIP and GitHub-generated ZIP use different packaging, so
the checksum above applies only to the named local archive.

## Review or recover a version

To inspect the exact old version without modifying the active checkout:

```bash
git fetch origin --tags
git worktree add --detach ../temp-status-v261011 v261011
```

To undo this initial vApple release on a clean `main` checkout, review the release
diff and create a normal inverse commit:

```bash
git show --stat vApple
git revert vApple
```

Review and build the result before pushing `main`, because pushing triggers the
existing Render deployment. If later changes depend on vApple, resolve them as a
new change instead of resetting history or moving a tag. See the local backup
README for a narrower restoration of the previous frontend files.

## Validation records

The vApple release is checked for palette, system typography, compact density,
light/dark mode, GPU slot visibility, responsive layout, dialogs, filters,
sorting, pagination, 30-second refresh, and reduced motion. Local screen evidence
and the design review are kept under `../../backups/vApple/`. Live deployment is
verified independently from local fixture-based checks.

## vToss and its previous-version backup

- Previous current version: `vApple-noto-20261012`; local directory
  `../../backups/vApple-noto-20261012/` includes 55 tracked source files, 14
  previously verified screenshots, recovery instructions and checksums.
- ZIP `temp-status-vApple-noto-20261012.zip` SHA-256:
  `f2a3278d10d1b7119f22db569a44513e22de12e01a8cc0a5acddd0e2d6b0b87d`.
- The historical Apple reference is retained at [references/vApple.md](references/vApple.md).
  Root `DESIGN.md` now contains the supplied Toss reference verbatim.
- vToss source, captures, fidelity record and deployment evidence are stored in
  `../../backups/vToss/` after final verification.
- To inspect the exact preceding version, use
  `git worktree add --detach ../temp-status-vApple-noto vApple-noto-20261012`.
  To undo only the initial vToss release on a clean current branch, review
  `git show --stat vToss`, then use `git revert vToss`, build and verify before
  pushing. Do not reset history or move existing version tags.
