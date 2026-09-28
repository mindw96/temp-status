(() => {
  'use strict';
  const storageKey = 'gpu-dashboard-theme';
  const root = document.documentElement;
  const systemTheme = window.matchMedia('(prefers-color-scheme: dark)');
  const validPreference = value => value === 'light' || value === 'dark' ? value : null;
  let preference = null;
  try {
    preference = validPreference(window.localStorage.getItem(storageKey));
  } catch {
    // The toggle also works when the browser disallows persistent storage.
  }

  function applyTheme() {
    const theme = preference || (systemTheme.matches ? 'dark' : 'light');
    root.dataset.theme = theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content',
      theme === 'dark' ? '#101713' : '#f5f7f8');
    const button = document.getElementById('theme-toggle');
    if (button) {
      const next = theme === 'dark' ? 'light' : 'dark';
      button.setAttribute('aria-label', `Switch to ${next} mode`);
      button.title = `Switch to ${next} mode`;
      button.querySelector('.theme-toggle-label').textContent = next === 'dark' ? 'Dark mode' : 'Light mode';
    }
  }

  // This script runs in the head before the stylesheet to avoid a light flash.
  applyTheme();
  const bindToggle = () => {
    applyTheme();
    document.getElementById('theme-toggle')?.addEventListener('click', () => {
      preference = root.dataset.theme === 'dark' ? 'light' : 'dark';
      try {
        window.localStorage.setItem(storageKey, preference);
      } catch {
        // Keep the choice for this page even if saving it is unavailable.
      }
      applyTheme();
    });
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bindToggle, {once: true});
  } else {
    bindToggle();
  }
  systemTheme.addEventListener('change', () => {
    if (preference === null) applyTheme();
  });
  window.addEventListener('storage', event => {
    if (event.key === storageKey || event.key === null) {
      preference = validPreference(event.newValue);
      applyTheme();
    }
  });
})();
