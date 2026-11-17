(function () {
  'use strict';

  const DOM = window.NewShooterDOM;
  const SUSPENSION_PATTERNS = [
    /your account has been disabled/i,
    /account suspended/i,
    /account has been suspended/i,
    /couldn['’]?t find your google account/i,
    /violated (?:our|google'?s) (?:terms|policies)/i,
    /unable to sign you in/i
  ];

  function extractEmailFromSupportPage() {
    const text = document.body?.innerText || '';
    const m = text.match(/[\w.+-]+@[\w.-]+\.[a-zA-Z]{2,}/);
    if (m) return m[0];
    const params = new URLSearchParams(window.location.search);
    return params.get('email') || '';
  }

  async function inspectSupportPage() {
    const heading = document.querySelector('h1, h2, [role="heading"]')?.innerText || '';
    const fullText = `${heading}\n${document.body?.innerText || ''}`;
    const isSuspended = SUSPENSION_PATTERNS.some((rx) => rx.test(fullText));

    if (isSuspended) {
      let email = extractEmailFromSupportPage();
      if (!email) {
        const pending = await chrome.runtime.sendMessage({ action: 'GET_PENDING_LOGIN' }).catch(() => null);
        email = pending?.account?.email || '';
      }
      await chrome.runtime.sendMessage({
        action: 'REPORT_VERIFICATION_STATUS',
        email,
        statusText: heading ? heading.trim().slice(0, 60) : 'Account Suspended',
        severity: 'fatal',
        code: 'ACCOUNT_SUSPENDED'
      }).catch(() => {});
      await chrome.runtime.sendMessage({
        action: 'TASK_STATUS_UPDATE',
        email,
        status: 'BLOCKED',
        step: 'Account Suspended',
        errorMessage: heading.trim() || 'Account Suspended / Disabled'
      }).catch(() => {});
      return { suspended: true, email, heading: heading.trim() };
    }

    const dismiss = document.querySelector('button[aria-label*="Close" i], a.continue-link');
    if (dismiss && DOM.isElementVisible(dismiss)) {
      await DOM.cdpClickElement(dismiss);
    }
    return { suspended: false };
  }

  window.__newShooterInspectSupport = inspectSupportPage;
  setTimeout(inspectSupportPage, 800);
})();
