(function () {
  'use strict';

  const ACCEPT_SELECTORS = [
    '#mail-accept-all-2',
    'button[id*="mail-accept-all"]',
    'button.accept-all',
    'button[name="agree"]',
    'button[value="agree"]',
    '[name="accept_all"]',
    '[value="accept_all"]',
    '.mail-accept-all-button',
    '.consent-overlay button.primary'
  ];

  const SUBMIT_SELECTORS = [
    '.actions.single button.done-button',
    'button[type="submit"][name="agree"]',
    'button.done-button'
  ];

  let accepted = false;
  let attempts = 0;

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function scanAndAccept() {
    if (accepted || attempts >= 20) return;
    attempts++;

    for (const sel of ACCEPT_SELECTORS) {
      const btn = document.querySelector(sel);
      if (btn && isVisible(btn)) {
        btn.click();
        accepted = true;
        setTimeout(() => {
          for (const subSel of SUBMIT_SELECTORS) {
            const sub = document.querySelector(subSel);
            if (sub && !sub.disabled && isVisible(sub)) {
              sub.click();
              break;
            }
          }
        }, 700);
        return;
      }
    }
  }

  scanAndAccept();
  const iv = setInterval(() => {
    if (accepted || attempts >= 20) { clearInterval(iv); return; }
    scanAndAccept();
  }, 500);
})();
