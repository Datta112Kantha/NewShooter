(function () {
  'use strict';

  const DOM = window.NewShooterDOM;
  const SKIP_KEYWORDS = [
    'skip', 'not now', 'no thanks', 'no, thanks', 'cancel', 'got it', 'ok', 'dismiss',
    'later', 'remind me later', 'continue', 'confirm', 'accept', 'i agree',
    'abbrechen', 'überspringen', 'später', 'ignorer', 'plus tard', 'annuler',
    'omitir', 'ahora no', 'saltar', 'aceptar', 'pular', 'agora não', 'cancelar',
    'スキップ', '後で', 'キャンセル'
  ];

  function matchesSkipKeyword(text) {
    const clean = String(text || '').trim().toLowerCase().replace(/\s+/g, ' ');
    if (!clean) return false;
    return SKIP_KEYWORDS.some((kw) => clean === kw || clean.includes(kw));
  }

  async function trySkipGds() {
    const candidates = document.querySelectorAll('button, [role="button"], .VfPpkd-Jh9lGc, input[type="submit"], a[role="button"]');
    for (const el of candidates) {
      if (!DOM.isElementVisible(el)) continue;
      const label = el.innerText || el.value || el.getAttribute('aria-label') || '';
      if (matchesSkipKeyword(label)) {
        await DOM.cdpClickElement(el);
        return true;
      }
    }
    const primary = document.querySelector('button[jsname="LgbsSe"], button.confirm');
    if (primary && DOM.isElementVisible(primary)) {
      await DOM.cdpClickElement(primary);
      return true;
    }
    return false;
  }

  async function runGdsLoop() {
    for (let i = 0; i < 8; i++) {
      await DOM.sleep(i === 0 ? 700 : 1200);
      const clicked = await trySkipGds();
      if (clicked) {
        await chrome.runtime.sendMessage({ action: 'GDS_SKIPPED', url: window.location.href }).catch(() => {});
        return true;
      }
    }
    return false;
  }

  window.__newShooterRunGds = trySkipGds;
  runGdsLoop();
})();
