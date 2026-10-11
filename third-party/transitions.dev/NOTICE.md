# Transitions.dev CSS snippets

This dashboard uses three CSS transition examples from
[Jakub Antalik's transitions.dev](https://github.com/Jakubantalik/transitions.dev),
Copyright (c) 2026 Jakub Antalik / Transitions.dev.

Upstream commit: `2773886681b6bb8effe0d7b5c66306430d18e000`.

Only the following CSS snippets are included in `public/motion.css`:

- [Modal open / close](https://github.com/Jakubantalik/transitions.dev/blob/2773886681b6bb8effe0d7b5c66306430d18e000/skills/transitions-dev/06-modal.md)
- [Icon swap](https://github.com/Jakubantalik/transitions.dev/blob/2773886681b6bb8effe0d7b5c66306430d18e000/skills/transitions-dev/09-icon-swap.md)
- [Accordion expand](https://github.com/Jakubantalik/transitions.dev/blob/2773886681b6bb8effe0d7b5c66306430d18e000/skills/transitions-dev/21-accordion.md)

The `:root` defaults and CSS blocks are copied verbatim from those references,
including all `prefers-reduced-motion` guards. Application-specific markup and
JavaScript connect the snippets to the dashboard; no transitions.dev service,
package, account, or runtime is required.

The snippets are covered by **section 1, Transitions and skills**, of the
[upstream license](https://github.com/Jakubantalik/transitions.dev/blob/2773886681b6bb8effe0d7b5c66306430d18e000/LICENSE),
preserved in full in [LICENSE](LICENSE). The tooling's separate MIT license does
not replace the snippets' license. The snippets may be copied and modified for
personal or commercial websites; they must not be repackaged as a competing
transitions library or animation kit.

Integration hooks:

- `.t-modal`: add `.is-open` when showing the native job-detail dialog; change
  to `.is-closing` before calling its native `close()` method.
- `.t-icon-swap[data-state="a"|"b"]`: contains two `.t-icon` elements with matching
  `data-icon` values; changing the state cross-fades their opacity, blur, and scale.
- `.t-acc[data-open="true"|"false"]`: surrounds the Completed jobs toggle and a
  `.t-acc-panel` containing `.t-acc-panel-inner`. The toggle controls
  `aria-expanded`; collapsed content must also be kept out of keyboard focus.
  A `.t-acc-chevron` inside the toggle flips when expanded.
