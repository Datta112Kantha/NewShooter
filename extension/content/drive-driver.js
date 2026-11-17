(function () {
  'use strict';

  const DOM = window.NewShooterDOM;

  async function autoShareAndGetLink() {
    const shareBtn = document.querySelector('button[aria-label*="Share" i], [data-tooltip*="Share" i], [role="button"][aria-label*="Share" i]');
    if (shareBtn && DOM.isElementVisible(shareBtn)) {
      await DOM.cdpClickElement(shareBtn);
      await DOM.sleep(900);
    }

    // Switch Restricted -> Anyone with the link if role option menu is present
    const accessTriggers = document.querySelectorAll('button, [role="button"], [role="combobox"], [role="menuitem"]');
    for (const el of accessTriggers) {
      if (!DOM.isElementVisible(el)) continue;
      const txt = (el.innerText || el.getAttribute('aria-label') || '').toLowerCase();
      if (txt.includes('restricted') || txt.includes('change to anyone')) {
        await DOM.cdpClickElement(el);
        await DOM.sleep(500);
        const anyoneOpt = [...document.querySelectorAll('[role="menuitem"], [role="option"], li, button')]
          .find((cand) => DOM.isElementVisible(cand) && (cand.innerText || '').toLowerCase().includes('anyone with the link'));
        if (anyoneOpt) {
          await DOM.cdpClickElement(anyoneOpt);
          await DOM.sleep(600);
        }
        break;
      }
    }

    const linkInput = document.querySelector('input[readonly][value*="drive.google.com"], input[type="url"], input[value*="https://drive.google.com"]')
      || [...document.querySelectorAll('input')].find((el) => /drive\.google\.com/i.test(el.value || ''));
    const url = linkInput?.value || window.location.href;
    const copyBtn = [...document.querySelectorAll('button, [role="button"]')]
      .find((el) => DOM.isElementVisible(el) && (el.innerText || '').toLowerCase().includes('copy link'));
    if (copyBtn) await DOM.cdpClickElement(copyBtn);
    const doneBtn = [...document.querySelectorAll('button, [role="button"]')]
      .find((el) => DOM.isElementVisible(el) && (el.innerText || '').trim().toLowerCase() === 'done');
    if (doneBtn) await DOM.cdpClickElement(doneBtn);

    return { ok: Boolean(url), url };
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.action === 'DRIVE_GET_SHARE_LINK' || msg.action === 'DRIVE_AUTO_SHARE') {
      autoShareAndGetLink().then((res) => sendResponse(res));
      return true;
    }
    return false;
  });
})();
