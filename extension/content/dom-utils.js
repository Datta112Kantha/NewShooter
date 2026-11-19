(function (g) {
  'use strict';

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function isElementVisible(el) {
    if (!el || !el.isConnected) return false;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  async function waitForElement(selectorOrFn, timeoutMs = 15000, intervalMs = 200) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      let el = null;
      if (typeof selectorOrFn === 'function') {
        el = selectorOrFn();
      } else {
        const all = document.querySelectorAll(selectorOrFn);
        for (const cand of all) {
          if (isElementVisible(cand)) { el = cand; break; }
        }
      }
      if (el) return el;
      await sleep(intervalMs);
    }
    return null;
  }

  function readFieldValue(el) {
    if (!el) return '';
    return el.isContentEditable ? (el.textContent || '') : (el.value ?? '');
  }

  function setNativeInputValue(input, value) {
    if (!input) return;
    if (input.isContentEditable) {
      input.textContent = String(value ?? '');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }
    const proto = Object.getPrototypeOf(input);
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(input, value);
    else input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function simulateClick(el) {
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const x = Math.round(rect.left + rect.width / 2);
    const y = Math.round(rect.top + rect.height / 2);
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: x, clientY: y }));
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, clientX: x, clientY: y }));
    el.click();
    return { x, y };
  }

  async function cdpClickElement(el) {
    if (!el) return;
    el.scrollIntoView({ block: 'center', inline: 'center' });
    const rect = el.getBoundingClientRect();
    const x = Math.round(rect.left + rect.width / 2);
    const y = Math.round(rect.top + rect.height / 2);
    try {
      const resp = await chrome.runtime.sendMessage({ action: 'CDP_CLICK', x, y });
      if (resp?.ok) return;
    } catch {}
    simulateClick(el);
  }

  async function typeOrganic(el, text, opts = {}) {
    el.focus();
    if (opts.clear !== false) {
      setNativeInputValue(el, '');
      el.focus();
    }
    const str = String(text || '');
    if (opts.useCdp) {
      try {
        const resp = await chrome.runtime.sendMessage({ action: 'CDP_TYPE', text: str });
        await sleep(60);
        const actual = readFieldValue(el);
        if (resp?.ok && (actual === str || (el.isContentEditable && actual.trim() === str.trim()))) {
          return { ok: true, method: 'cdp' };
        }
      } catch {}
    }
    for (let i = 0; i < str.length; i++) {
      setNativeInputValue(el, str.slice(0, i + 1));
      await sleep(opts.fast ? 8 : 15 + Math.random() * 15);
    }
    return { ok: true, method: 'dom' };
  }

  // Trusted Types safe HTML setter (required under strict CSP on Gmail/Outlook/Yahoo)
  let trustedHtmlPolicy = null;
  function setSafeHtml(targetEl, html) {
    if (!targetEl) return;
    const raw = String(html || '');
    try {
      if (window.trustedTypes && window.trustedTypes.createPolicy) {
        if (!trustedHtmlPolicy) {
          trustedHtmlPolicy = window.trustedTypes.createPolicy('newshooter-html', {
            createHTML: (s) => s
          });
        }
        targetEl.innerHTML = trustedHtmlPolicy.createHTML(raw);
        return;
      }
    } catch {}

    try {
      const range = document.createRange();
      range.selectNodeContents(targetEl);
      targetEl.textContent = '';
      targetEl.appendChild(range.createContextualFragment(raw));
    } catch {
      targetEl.innerText = raw.replace(/<[^>]+>/g, '');
    }
  }

  function simulateKeyPress(key, code) {
    const target = (document.activeElement && document.activeElement !== document.body)
      ? document.activeElement
      : (document.body || document.documentElement);
    if (!target) return;
    const charCode = key.charCodeAt(0);
    const eventInit = {
      key: key,
      code: code || (key.length === 1 ? `Key${key.toUpperCase()}` : key),
      keyCode: charCode,
      which: charCode,
      charCode: charCode,
      bubbles: true,
      cancelable: true,
      view: window
    };
    target.dispatchEvent(new KeyboardEvent('keydown', eventInit));
    target.dispatchEvent(new KeyboardEvent('keypress', eventInit));
    target.dispatchEvent(new KeyboardEvent('keyup', eventInit));
  }

  function decodeBase64Files(attachments = []) {
    const dt = new DataTransfer();
    for (const att of attachments) {
      if (!att || !att.base64) continue;
      const bin = atob(att.base64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const file = new File([bytes], att.filename || 'attachment.bin', { type: att.mimeType || 'application/octet-stream' });
      dt.items.add(file);
    }
    return dt;
  }

  g.NewShooterDOM = {
    sleep,
    isElementVisible,
    waitForElement,
    setNativeInputValue,
    simulateClick,
    cdpClickElement,
    simulateKeyPress,
    typeOrganic,
    setSafeHtml,
    decodeBase64Files
  };
})(window);
