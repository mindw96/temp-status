(() => {
  'use strict';
  // Local integration for the transitions.dev recipes in motion.css.
  // Keep native dialog focus trapping, Escape handling and focus restoration.
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const closeTimers = new WeakMap();
  const openers = new WeakMap();
  const closeDelay = dialog => {
    if (reducedMotion.matches) return 0;
    const value = getComputedStyle(dialog).getPropertyValue('--modal-close-dur').trim();
    return (parseFloat(value) || 150) * (value.endsWith('ms') ? 1 : 1000);
  };

  function openDialog(dialog) {
    clearTimeout(closeTimers.get(dialog));
    closeTimers.delete(dialog);
    dialog.classList.remove('is-closing');
    if (!dialog.open) {
      openers.set(dialog, document.activeElement);
      dialog.classList.remove('is-open');
      dialog.showModal();
      // Establish the initial scale before starting the copied CSS transition.
      void dialog.offsetWidth;
    }
    dialog.classList.add('is-open');
  }

  function closeDialog(dialog) {
    if (!dialog.open || closeTimers.has(dialog)) return;
    dialog.classList.remove('is-open');
    dialog.classList.add('is-closing');
    const finish = () => {
      closeTimers.delete(dialog);
      dialog.close();
      dialog.classList.remove('is-closing');
      // A 30-second refresh can replace the original job button while open.
      const opener = openers.get(dialog);
      if (opener && !opener.isConnected) {
        const attribute = ['data-job', 'data-a100-job', 'data-node'].find(name => opener.hasAttribute(name));
        const replacement = attribute && document.querySelector(`[${attribute}="${CSS.escape(opener.getAttribute(attribute))}"]`);
        (replacement || document.querySelector('#retry-live, #a100-refresh'))?.focus({preventScroll: true});
      }
      openers.delete(dialog);
    };
    const delay = closeDelay(dialog);
    if (delay) closeTimers.set(dialog, setTimeout(finish, delay));
    else finish();
  }

  document.querySelectorAll('dialog.t-modal').forEach(dialog => {
    dialog.querySelector('[data-dialog-close]')?.addEventListener('click', () => closeDialog(dialog));
    dialog.addEventListener('cancel', event => {
      event.preventDefault();
      closeDialog(dialog);
    });
    const outside = event => {
      if (event.target !== dialog) return false;
      const bounds = dialog.getBoundingClientRect();
      return event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom;
    };
    let pressedBackdrop = false;
    dialog.addEventListener('pointerdown', event => {pressedBackdrop = outside(event);});
    dialog.addEventListener('click', event => {
      if (pressedBackdrop && outside(event)) closeDialog(dialog);
      pressedBackdrop = false;
    });
    dialog.addEventListener('close', () => {
      // Ignore a queued close event if the dialog has already reopened.
      if (dialog.open) return;
      clearTimeout(closeTimers.get(dialog));
      closeTimers.delete(dialog);
      dialog.classList.remove('is-open', 'is-closing');
    });
  });

  document.querySelectorAll('.t-acc').forEach(accordion => {
    const head = accordion.querySelector('.t-acc-head');
    const panel = accordion.querySelector('.t-acc-panel');
    head.addEventListener('click', () => {
      const open = accordion.dataset.open !== 'true';
      accordion.dataset.open = String(open);
      head.setAttribute('aria-expanded', String(open));
      panel.inert = !open;
      panel.setAttribute('aria-hidden', String(!open));
    });
  });

  // Stageshow's Meter and content reveals, adapted for real updates.
  // See third-party/stageshow/NOTICE.md. Text/ARIA always hold the latest data.
  const updates = new Set();
  const moving = new WeakMap();
  const canAnimate = () => !document.hidden && !reducedMotion.matches;
  const visible = element => {
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < window.innerHeight;
  };
  function stopUpdate(animation) {
    updates.delete(animation);
    const target = animation.effect?.target;
    if (target && moving.get(target) === animation) {
      moving.delete(target);
      target.classList.remove('is-updating');
    }
    animation.cancel();
  }
  function stopWithin(root) {
    for (const animation of updates) if (root.contains(animation.effect?.target)) stopUpdate(animation);
  }
  function animateUpdate(element, frames, options) {
    if (!canAnimate() || !visible(element) || typeof element.animate !== 'function') return;
    const previous = moving.get(element);
    if (previous) stopUpdate(previous);
    element.classList.add('is-updating');
    const animation = element.animate(frames, options);
    updates.add(animation);
    moving.set(element, animation);
    const clean = () => {
      updates.delete(animation);
      if (moving.get(element) === animation) {
        moving.delete(element);
        element.classList.remove('is-updating');
      }
    };
    animation.finished.then(clean, clean);
  }
  function meterEntries(root) {
    const entries = new Map();
    root.querySelectorAll('.live-node').forEach(node => {
      const id = node.querySelector('.node-summary[data-node]')?.dataset.node;
      node.querySelectorAll('.gpu-meter[role="meter"], .storage-meter[role="meter"]').forEach(meter => {
        const gpu = meter.closest('[data-gpu-index]');
        const key = JSON.stringify([id, gpu ? `gpu:${gpu.dataset.gpuIndex}` : 'storage', meter.getAttribute('aria-label')]);
        const fill = meter.firstElementChild;
        if (fill && visible(meter)) entries.set(key, {fill, value: Number(meter.getAttribute('aria-valuenow'))});
      });
    });
    return entries;
  }
  function captureMeters(root) {
    const previous = new Map();
    if (canAnimate()) for (const [key, {fill, value}] of meterEntries(root)) {
      previous.set(key, {value, clip: getComputedStyle(fill).clipPath, moving: moving.has(fill)});
    }
    stopWithin(root);
    return previous;
  }
  function animateMeters(root, previous) {
    if (!previous?.size || !canAnimate()) return;
    for (const [key, {fill, value}] of meterEntries(root)) {
      const before = previous.get(key);
      // Missing/invalid reports have no entry: never animate from stale values
      // on recovery, or invent a zero baseline for newly collected devices.
      if (!before || (before.value === value && !before.moving)) continue;
      animateUpdate(fill, [{clipPath: before.clip}, {clipPath: fill.style.clipPath}],
        {duration: 360, easing: 'cubic-bezier(0.45, 0, 0.2, 1)'});
    }
  }
  function captureRows(root) {
    const keys = [...root.querySelectorAll('[data-motion-row]')].map(row => row.dataset.motionRow);
    const opacity = moving.has(root) ? getComputedStyle(root).opacity : null;
    const focused = root.contains(document.activeElement) ? document.activeElement : null;
    const focusRow = focused?.closest('[data-motion-row]');
    // Capture current opacity before cancelling an interrupted list change.
    stopWithin(root);
    return {keys, opacity, focus: focusRow ? {key: focusRow.dataset.motionRow, arrow: focused.classList.contains('table-arrow')} : null};
  }
  function animateRows(root, previous) {
    if (!previous) return;
    const rows = [...root.querySelectorAll('[data-motion-row]')];
    if (previous.focus) {
      const row = rows.find(row => row.dataset.motionRow === previous.focus.key);
      (row?.querySelector(previous.focus.arrow ? '.table-arrow' : '.job-name') || document.querySelector('#job-search'))?.focus({preventScroll: true});
    }
    if (!canAnimate() || !previous.keys.length) return;
    const keys = rows.map(row => row.dataset.motionRow);
    if (keys.length === previous.keys.length && keys.every((key, index) => key === previous.keys[index])) return;
    // Reveal the latest list as a whole: travelling table rows can overlap or
    // clip text when sorting, filtering or wrapping changes their geometry.
    animateUpdate(root, [{opacity: previous.opacity ?? 0.5}, {opacity: 1}],
      {duration: 180, easing: 'cubic-bezier(0.25, 0.8, 0.25, 1)'});
  }
  function revealContent(element) {
    const current = moving.has(element) ? getComputedStyle(element) : null;
    animateUpdate(element, [{opacity: current?.opacity ?? 0.5, transform: current?.transform ?? 'translateY(8px)'}, {opacity: 1, transform: 'translateY(0)'}],
      {duration: 200, easing: 'cubic-bezier(0.25, 0.8, 0.25, 1)'});
  }
  const settleUpdates = () => {for (const animation of updates) stopUpdate(animation);};
  reducedMotion.addEventListener('change', () => {if (reducedMotion.matches) settleUpdates();});
  document.addEventListener('visibilitychange', () => {if (document.hidden) settleUpdates();});

  window.dashboardMotion = {openDialog, closeDialog, captureMeters, animateMeters, captureRows, animateRows, revealContent};
})();
