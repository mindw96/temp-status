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

  window.dashboardMotion = {openDialog, closeDialog};
})();
