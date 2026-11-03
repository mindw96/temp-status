# Stageshow motion adaptations

- Author: Benji Taylor
- Source: https://github.com/benjitaylor/skills/tree/802057409787133703c56001080169e347305572/stageshow
- Pinned commit: `802057409787133703c56001080169e347305572`
- License: MIT, reproduced in [LICENSE](LICENSE).

`public/live.js` ports the full-width, rounded `clip-path` fill from
`kit/parts/Meter.tsx` and `kit/parts/Meter.css`. `public/motion.js` connects
the previous rendered fill to the next report using the original Meter easing,
shortened to 360 ms for live monitoring. Numeric labels and ARIA values update
immediately; missing, stale and offline reports clear the old fill immediately.

Slurm Jobs sorting, filtering and paging use a local keyed list comparison
and a 180 ms opacity reveal informed by `references/motion.md`: keep readable
text at its original size, use short response timing and settle without bounce.
The latest list is immediately in place; rows do not travel across each other.
Ranking period changes follow the reference's 200 ms / 8 px body reveal.
These are adaptations for user-driven application state, not copies of a demo.

No Stage/Act runtime, simulated input, React runtime, app icons, fonts or other
third-party brand assets are included. Existing transitions.dev dialog, theme
and accordion effects retain their own attribution. Update effects are disabled
under reduced motion and cancelled when the page becomes hidden.
