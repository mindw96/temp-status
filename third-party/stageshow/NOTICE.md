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

Job row movement is a local, keyed FLIP implementation informed by
`references/motion.md` and `examples/reorder`: measure current positions, move
only changed rows, keep readable text at its original size, and settle without
bounce. When sorting reverses the relative order of shared rows, the new order
uses a 180 ms opacity reveal instead of crossing text. Moves starting outside
the reduced result area also use a short reveal. Ranking period changes follow
the reference's 200 ms / 8 px body reveal.
These are adaptations for user-driven application state, not copies of a demo.

No Stage/Act runtime, simulated input, React runtime, app icons, fonts or other
third-party brand assets are included. Existing transitions.dev dialog, theme
and accordion effects retain their own attribution. Update effects are disabled
under reduced motion and cancelled when the page becomes hidden.
