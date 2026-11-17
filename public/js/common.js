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

  g.RelayCommon = {
    initThemeToggle,
    showToast,
    apiJson,
    relayAction,
    wireDialog,
    wireGmassPopovers,
    wireChatDrawer,
    wireDownloadExtensionModal
  };
})(window);
