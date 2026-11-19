(function (g) {
  'use strict';

  const STORAGE_KEY = 'color-scheme';

  function getStoredTheme() {
    try {
      return localStorage.getItem(STORAGE_KEY) || 'light dark';
    } catch {
      return 'light dark';
    }
  }

  function resolveEffectiveTheme(val) {
    if (val === 'dark') return 'dark';
    if (val === 'light') return 'light';
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  function applyTheme(val) {
    const meta = document.querySelector('meta[name="color-scheme"]');
    if (meta) meta.setAttribute('content', val);
    const effective = resolveEffectiveTheme(val);
    document.documentElement.dataset.theme = effective;
    const toggleBtn = document.getElementById('themeToggle');
    if (toggleBtn) {
      toggleBtn.setAttribute('aria-pressed', String(effective === 'dark'));
      toggleBtn.title = effective === 'dark' ? 'Switch to light theme' : 'Switch to dark theme';
      const moon = toggleBtn.querySelector('[data-icon="moon"]');
      const sun = toggleBtn.querySelector('[data-icon="sun"]');
      if (moon && sun) {
        moon.style.display = effective === 'dark' ? 'none' : 'inline';
        sun.style.display = effective === 'dark' ? 'inline' : 'none';
      }
    }
  }

  function initThemeToggle() {
    applyTheme(getStoredTheme());
    const btn = document.getElementById('themeToggle');
    if (btn) {
      btn.addEventListener('click', () => {
        const curEffective = resolveEffectiveTheme(getStoredTheme());
        const next = curEffective === 'dark' ? 'light' : 'dark';
        try { localStorage.setItem(STORAGE_KEY, next); } catch {}
        applyTheme(next);
      });
    }
  }

  function syncToastOffset() {
    const header = document.querySelector('.site-header');
    if (!header) return;
    const rect = header.getBoundingClientRect();
    const topPx = Math.max(76, Math.ceil(rect.bottom + 8));
    document.documentElement.style.setProperty('--toast-top', `${topPx}px`);
  }

  let toastOffsetWired = false;
  function wireToastOffsetObserver() {
    if (toastOffsetWired) return;
    toastOffsetWired = true;
    syncToastOffset();
    const header = document.querySelector('.site-header');
    if (header && typeof ResizeObserver !== 'undefined') {
      new ResizeObserver(syncToastOffset).observe(header);
    }
    window.addEventListener('resize', syncToastOffset);
  }

  function showToast(title, message, variant = 'info', timeoutMs = 4500) {
    wireToastOffsetObserver();
    syncToastOffset();
    const region = document.getElementById('toastRegion');
    if (!region) return;
    const item = document.createElement('div');
    item.className = `toast-item toast-item--${variant}`;

    const content = document.createElement('div');
    const h = document.createElement('div');
    h.className = 'toast-item__title';
    h.textContent = title;
    const p = document.createElement('div');
    p.className = 'toast-item__msg';
    p.textContent = message;
    content.appendChild(h);
    content.appendChild(p);

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'toast-item__close';
    closeBtn.setAttribute('aria-label', 'Dismiss notification');
    closeBtn.textContent = '×';
    closeBtn.addEventListener('click', () => item.remove());

    item.appendChild(content);
    item.appendChild(closeBtn);
    region.appendChild(item);
    try {
      document.ariaNotify?.(`${title}: ${message}`);
    } catch {}

    if (timeoutMs > 0) {
      setTimeout(() => { if (item.isConnected) item.remove(); }, timeoutMs);
    }
  }

  async function apiJson(url, opts = {}) {
    const resp = await fetch(url, {
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        ...(opts.headers || {})
      },
      ...opts
    });
    if (resp.status === 401) {
      window.location.href = '/Login.php';
      throw new Error('Unauthorized');
    }
    const data = await resp.json();
    return data;
  }

  async function relayAction(action, payload = {}) {
    return apiJson('/V3/relayCommandApi.php', {
      method: 'POST',
      body: JSON.stringify({ action, ...payload })
    });
  }

  // Light-dismiss polyfill for native <dialog> if closedby="any" is unsupported
  function wireDialog(dialogEl, closeBtn) {
    if (!dialogEl) return;
    if (closeBtn) {
      closeBtn.addEventListener('click', () => {
        dialogEl.returnValue = '';
        dialogEl.close();
      });
    }
    dialogEl.addEventListener('cancel', () => {
      dialogEl.returnValue = '';
    });
    if (!('closedBy' in HTMLDialogElement.prototype)) {
      dialogEl.addEventListener('click', (e) => {
        if (e.target === dialogEl) {
          dialogEl.returnValue = '';
          dialogEl.close();
        }
      });
    }
  }

  function wireGmassPopovers() {
    for (const num of ['2', '4']) {
      const btn = document.getElementById(`gmass${num}NavBtn`);
      const pop = document.getElementById(`gmass${num}Popover`);
      const modal = document.getElementById('gmassModal');
      const frame = document.getElementById('gmassModalFrame');
      const rememberCheck = document.getElementById(`gmass${num}Remember`);
      const openHere = document.getElementById(`gmass${num}OpenHere`);

      if (!btn || !pop) continue;

      if (rememberCheck) {
        try {
          rememberCheck.checked = localStorage.getItem(`gmass${num}_pref`) === 'modal';
        } catch {}
        rememberCheck.addEventListener('change', () => {
          try {
            localStorage.setItem(`gmass${num}_pref`, rememberCheck.checked ? 'modal' : 'ask');
          } catch {}
        });
      }

      if (openHere && modal && frame) {
        openHere.addEventListener('click', () => {
          pop.hidePopover?.();
          frame.src = `/gmass${num}?embed=1`;
          document.getElementById('gmassModalTitle').textContent = `GMASS-${num} Blaster`;
          modal.showModal();
        });
      }

      btn.addEventListener('click', (e) => {
        let pref = 'ask';
        try { pref = localStorage.getItem(`gmass${num}_pref`) || 'ask'; } catch {}
        if (pref === 'modal' && modal && frame) {
          e.preventDefault();
          frame.src = `/gmass${num}?embed=1`;
          document.getElementById('gmassModalTitle').textContent = `GMASS-${num} Blaster`;
          modal.showModal();
          return;
        }
        const rect = btn.getBoundingClientRect();
        pop.style.top = `${rect.bottom + 6}px`;
        pop.style.left = `${Math.max(12, rect.left)}px`;
        pop.togglePopover?.();
      });
    }
  }

  function wireChatDrawer() {
    const btn = document.getElementById('chatBtn');
    const dialog = document.getElementById('chatDialog');
    const closeBtn = document.getElementById('chatCloseBtn');
    const list = document.getElementById('chatMessagesList');
    const form = document.getElementById('chatForm');
    const input = document.getElementById('chatInput');
    const badge = document.getElementById('chatBadge');
    if (!btn || !dialog) return;

    wireDialog(dialog, closeBtn);

    async function refreshMessages(markRead = false) {
      const url = '/V3/controller/messagesApi.php';
      const data = markRead
        ? await apiJson(url, { method: 'POST', body: JSON.stringify({ action: 'markRead' }) })
        : await apiJson(url);

      if (badge) {
        badge.textContent = String(data.unreadCount || 0);
        badge.hidden = !data.unreadCount;
      }
      if (list) {
        list.textContent = '';
        for (const m of data.messages || []) {
          const card = document.createElement('div');
          card.style.cssText = 'padding:8px 10px;border:1px solid var(--border);border-radius:8px;background:var(--surface-alt);';
          const meta = document.createElement('div');
          meta.style.cssText = 'font-size:11px;font-weight:700;color:var(--primary);margin-bottom:2px;';
          meta.textContent = `${m.sender} · ${new Date(m.createdAt).toLocaleTimeString()}`;
          const txt = document.createElement('div');
          txt.style.cssText = 'font-size:12.5px;';
          txt.textContent = m.text;
          card.appendChild(meta);
          card.appendChild(txt);
          list.appendChild(card);
        }
      }
    }

    btn.addEventListener('click', () => {
      refreshMessages(true);
      dialog.showModal();
    });

    if (form && input) {
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const text = input.value.trim();
        if (!text) return;
        input.value = '';
        await apiJson('/V3/controller/messagesApi.php', {
          method: 'POST',
          body: JSON.stringify({ text })
        });
        await refreshMessages(true);
      });
    }

    refreshMessages(false).catch(() => {});
  }

  function wireDownloadExtensionModal() {
    const dialog = document.getElementById('downloadExtDialog');
    const headerBtn = document.getElementById('downloadExtBtn');
    const navBtn = document.getElementById('downloadExtNavBtn');
    const closeBtn = document.getElementById('downloadExtClose');
    const dismissBtn = document.getElementById('downloadExtDismissBtn');
    const copyBtn = document.getElementById('copyExtUrlBtn');
    const copyLabel = document.getElementById('copyExtUrlLabel');

    if (dialog) {
      wireDialog(dialog, closeBtn);
      if (dismissBtn) {
        dismissBtn.addEventListener('click', () => {
          dialog.returnValue = '';
          dialog.close();
        });
      }
    }

    function triggerDownload() {
      const a = document.createElement('a');
      a.href = '/api/download-extension';
      a.download = 'bin4ry-relay-extension.zip';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    }

    function openModal(shouldDownload = true) {
      if (shouldDownload) {
        triggerDownload();
      }
      if (dialog) {
        if (typeof dialog.showModal === 'function') {
          if (!dialog.open) dialog.showModal();
        } else {
          dialog.setAttribute('open', '');
        }
      }
    }

    if (headerBtn) {
      headerBtn.addEventListener('click', (e) => {
        e.preventDefault();
        openModal(true);
      });
    }

    if (navBtn) {
      navBtn.addEventListener('click', (e) => {
        e.preventDefault();
        openModal(true);
      });
    }

    if (copyBtn) {
      copyBtn.addEventListener('click', async () => {
        const text = 'chrome://extensions';
        let copied = false;
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(text);
            copied = true;
          }
        } catch {}
        if (!copied) {
          try {
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.style.position = 'fixed';
            ta.style.left = '-9999px';
            document.body.appendChild(ta);
            ta.focus();
            ta.select();
            copied = document.execCommand('copy');
            document.body.removeChild(ta);
          } catch {}
        }
        if (copyLabel) copyLabel.textContent = 'Copied!';
        showToast('Copied chrome://extensions to clipboard', 'info');
        setTimeout(() => {
          if (copyLabel) copyLabel.textContent = 'Copy URL';
        }, 2500);
      });
    }

    return { openModal, triggerDownload };
  }

  function isLoginStageTab(tab) {
    if (!tab) return false;
    const st = String(tab.status || '').toLowerCase();
    const em = String(tab.email || '').toLowerCase();
    const url = String(tab.url || '').toLowerCase();
    return st === 'login_pending'
      || st.includes('login')
      || st.includes('pending')
      || st.includes('unauth')
      || em.includes('login pending')
      || em.includes('pending login')
      || em.includes('unauth')
      || /(?:accounts\.google\.com|login\.(?:live|yahoo|microsoftonline)\.com)/.test(url)
      || !tab.email
      || tab.email.trim() === '';
  }

  function getProviderIconHtml(provider) {
    const p = String(provider || 'gmail').toLowerCase();
    if (p === 'outlook' || p.includes('outlook') || p.includes('microsoft') || p.includes('live')) {
      return '<span class="tab-provider-icon tab-provider-icon--outlook" title="Outlook" style="display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;border-radius:4px;background:#0078d4;color:#fff;font-size:10px;font-weight:700;margin-right:6px;flex-shrink:0;">O</span>';
    }
    if (p === 'yahoo' || p.includes('yahoo')) {
      return '<span class="tab-provider-icon tab-provider-icon--yahoo" title="Yahoo" style="display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;border-radius:4px;background:#6001d2;color:#fff;font-size:10px;font-weight:700;margin-right:6px;flex-shrink:0;">Y</span>';
    }
    if (p === 'icloud' || p.includes('icloud') || p.includes('apple')) {
      return '<span class="tab-provider-icon tab-provider-icon--icloud" title="iCloud" style="display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;border-radius:4px;background:#333;color:#fff;font-size:10px;font-weight:700;margin-right:6px;flex-shrink:0;">☁</span>';
    }
    return '<span class="tab-provider-icon tab-provider-icon--gmail" title="Gmail" style="display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;border-radius:4px;background:#ea4335;color:#fff;font-size:10px;font-weight:700;margin-right:6px;flex-shrink:0;">G</span>';
  }

  async function pingExtension(timeoutMs = 1500) {
    if (typeof window === 'undefined') return null;

    const hasChromeRuntime = typeof window.chrome !== 'undefined'
      && window.chrome.runtime
      && typeof window.chrome.runtime.sendMessage === 'function';

    if (!hasChromeRuntime) return null;

    const knownIds = [];
    if (window.RELAY_EXTENSION_ID) knownIds.push(window.RELAY_EXTENSION_ID);
    try {
      const stored = localStorage.getItem('relay_extension_id');
      if (stored && !knownIds.includes(stored)) knownIds.push(stored);
    } catch {}

    const pingPayload = { action: 'GET_OPEN_TABS', type: 'PING_TABS' };

    return new Promise((resolve) => {
      let resolved = false;
      let timer = null;
      const done = (val) => {
        if (!resolved) {
          resolved = true;
          if (timer) clearTimeout(timer);
          resolve(val);
        }
      };

      timer = setTimeout(() => done(null), timeoutMs);

      // 1. Direct sendMessage without extension ID
      try {
        window.chrome.runtime.sendMessage(pingPayload, (resp) => {
          if (!window.chrome.runtime.lastError && resp && (resp.ok || resp.tabs)) {
            done(resp);
          }
        });
      } catch {}

      // 2. sendMessage with known extension IDs
      for (const id of knownIds) {
        try {
          window.chrome.runtime.sendMessage(id, pingPayload, (resp) => {
            if (!window.chrome.runtime.lastError && resp && (resp.ok || resp.tabs)) {
              done(resp);
            }
          });
        } catch {}
      }

      // 3. PostMessage bridge with content script if loaded
      const onMsg = (event) => {
        if (event.data && (event.data.type === 'RELAY_EXTENSION_PONG' || event.data.type === 'PONG_TABS') && event.data.tabs) {
          window.removeEventListener('message', onMsg);
          done(event.data);
        }
      };
      window.addEventListener('message', onMsg);
      try {
        window.postMessage({ type: 'RELAY_DASHBOARD_PING' }, '*');
      } catch {}
    });
  }

  async function getTabsViaApi() {
    try {
      const res = await apiJson('/api/tabs');
      return res.onlineTabs || res.tabs || [];
    } catch {
      try {
        const res = await relayAction('refreshTabs');
        return res.onlineTabs || res.tabs || [];
      } catch {
        return [];
      }
    }
  }

  g.RelayCommon = {
    initThemeToggle,
    showToast,
    apiJson,
    relayAction,
    wireDialog,
    wireGmassPopovers,
    wireChatDrawer,
    wireDownloadExtensionModal,
    isLoginStageTab,
    getProviderIconHtml,
    pingExtension,
    getTabsViaApi
  };
})(window);
