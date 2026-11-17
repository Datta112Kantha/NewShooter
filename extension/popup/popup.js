(function () {
  'use strict';

  const CREDS = window.NewShooterCredentials;
  const SET = window.AutomationSettings;
  let currentStatuses = {};
  let currentTabCount = 0;

  function hasChromeRuntime() {
    return typeof chrome !== 'undefined' && Boolean(chrome.runtime?.sendMessage);
  }

  function sendMsg(msg) {
    if (!hasChromeRuntime()) return Promise.resolve({ ok: false });
    return chrome.runtime.sendMessage(msg);
  }

  function setStatusMsg(text, kind = '') {
    const el = document.getElementById('popupStatusMsg');
    if (!el) return;
    el.textContent = text || '';
    el.className = `popup-status-msg${kind ? ` is-${kind}` : ''}`;
  }

  function readLiveTextAndCaret(el) {
    const sel = window.getSelection();
    const hasSel = Boolean(sel && sel.rangeCount > 0 && el.contains(sel.getRangeAt(0).endContainer));
    const endContainer = hasSel ? sel.getRangeAt(0).endContainer : null;
    const endOffset = hasSel ? sel.getRangeAt(0).endOffset : 0;

    let text = '';
    let caret = null;

    function checkElementBoundary(node, childIdx) {
      if (hasSel && node === endContainer && childIdx === endOffset && caret == null) {
        caret = text.length;
      }
    }

    function walk(node) {
      if (node.nodeType === Node.TEXT_NODE) {
        if (hasSel && node === endContainer && caret == null) {
          caret = text.length + Math.min(endOffset, node.nodeValue.length);
        }
        text += node.nodeValue;
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      if (node.classList?.contains('error-tag')) return;
      if (node.tagName === 'BR') {
        if (!node.dataset?.caretSentinel) text += '\n';
        return;
      }
      const isBlock = node !== el && /^(DIV|P|LI)$/.test(node.tagName);
      if (isBlock && text.length > 0 && !text.endsWith('\n')) {
        text += '\n';
      }
      const children = node.childNodes;
      for (let i = 0; i < children.length; i++) {
        checkElementBoundary(node, i);
        walk(children[i]);
      }
      checkElementBoundary(node, children.length);
    }

    walk(el);
    return { text, caret };
  }

  function setCaretCharacterOffset(el, offset) {
    if (offset == null) return;
    const sel = window.getSelection();
    if (!sel) return;
    const range = document.createRange();
    let remaining = offset;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        return node.parentElement?.closest?.('.error-tag')
          ? NodeFilter.FILTER_REJECT
          : NodeFilter.FILTER_ACCEPT;
      }
    });
    let node;
    let lastTextNode = null;
    while ((node = walker.nextNode())) {
      lastTextNode = node;
      const len = node.nodeValue.length;
      if (remaining <= len) {
        range.setStart(node, remaining);
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);
        return;
      }
      remaining -= len;
    }
    if (lastTextNode) {
      range.setStart(lastTextNode, lastTextNode.nodeValue.length);
    } else {
      range.selectNodeContents(el);
    }
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
  }

  function extractCleanRawLines(el) {
    const { text } = readLiveTextAndCaret(el);
    return text
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  function updateIdCounters(lines) {
    const accounts = lines.map(CREDS.parseCredentialLine).filter(Boolean);
    const idCountEl = document.getElementById('idCount');
    if (idCountEl) idCountEl.textContent = `${accounts.length} ID${accounts.length === 1 ? '' : 's'}`;

    const hintEl = document.getElementById('matchHint');
    if (hintEl) {
      if (accounts.length > 0 && currentTabCount > 0) {
        if (accounts.length === currentTabCount) {
          hintEl.textContent = `${accounts.length}/${currentTabCount} tabs match`;
          hintEl.className = 'match-hint is-match';
        } else {
          hintEl.textContent = `${accounts.length} IDs vs ${currentTabCount} tabs`;
          hintEl.className = 'match-hint is-mismatch';
        }
      } else {
        hintEl.textContent = 'email pass rec 2fa [proxy]';
        hintEl.className = 'match-hint';
      }
    }
    return accounts;
  }

  function renderHighlightedIds(el, preserveCaret = false) {
    const { text: raw, caret } = readLiveTextAndCaret(el);
    const trimmed = raw.trim();
    if (!trimmed) {
      if (el.querySelector('span, br')) el.textContent = '';
      updateIdCounters([]);
      return;
    }
    const lines = raw.split(/\r?\n/);
    el.textContent = '';
    const nonEmptyLines = [];

    lines.forEach((line, idx) => {
      if (idx > 0) el.appendChild(document.createTextNode('\n'));
      const segs = CREDS.classifyLineSegments(line);
      const parsed = CREDS.parseCredentialLine(line);
      if (parsed) nonEmptyLines.push(line);

      const errInfo = parsed ? currentStatuses[parsed.email.toLowerCase()] : null;
      const lineWrap = errInfo ? document.createElement('span') : null;
      if (lineWrap) lineWrap.className = `gid-err-${errInfo.severity || 'action'}`;

      const targetParent = lineWrap || el;
      for (const s of segs) {
        if (s.type === 'space') {
          targetParent.appendChild(document.createTextNode(s.text));
          continue;
        }
        const span = document.createElement('span');
        span.className = `gid-${s.type}`;
        span.textContent = s.text;
        targetParent.appendChild(span);
      }

      if (errInfo) {
        const badge = document.createElement('span');
        badge.className = `error-tag gid-err-${errInfo.severity || 'action'}`;
        badge.textContent = errInfo.statusText || 'Error';
        lineWrap.appendChild(badge);
        el.appendChild(lineWrap);
      }
    });

    if (raw.endsWith('\n')) {
      const br = document.createElement('br');
      br.dataset.caretSentinel = '1';
      el.appendChild(br);
    }

    if (preserveCaret && caret != null) setCaretCharacterOffset(el, caret);
    updateIdCounters(nonEmptyLines);
  }

  async function refreshOpenTabs() {
    const r = await sendMsg({ action: 'GET_OPEN_TABS' });
    if (r?.statuses) currentStatuses = r.statuses;
    const list = document.getElementById('tabList');
    const countEl = document.getElementById('noOfTabs');
    if (!list) return;
    const tabs = r?.tabs || [];
    currentTabCount = tabs.length;
    if (countEl) countEl.textContent = String(tabs.length);
    list.textContent = '';

    for (const t of tabs) {
      const row = document.createElement('div');
      row.className = 'tab-row';

      const left = document.createElement('div');
      left.className = 'tab-row__left';
      const badge = document.createElement('span');
      badge.className = 'tab-badge';
      if (/mail\.google|accounts\.google/i.test(t.url || '')) badge.textContent = 'M';
      else if (/outlook|live\.com|microsoftonline/i.test(t.url || '')) badge.textContent = 'O';
      else if (/yahoo/i.test(t.url || '')) badge.textContent = 'Y';
      else badge.textContent = 'G';

      const title = document.createElement('span');
      title.className = 'tab-row__title';
      title.textContent = t.email ? `${t.email} — ${t.title || t.url}` : (t.title || t.url || `Tab ${t.id}`);
      title.title = t.url || '';
      left.append(badge, title);

      const actions = document.createElement('div');
      actions.style.display = 'flex';
      actions.style.gap = '3px';

      const focusBtn = document.createElement('button');
      focusBtn.type = 'button';
      focusBtn.className = 'ext-btn ext-btn--sm';
      focusBtn.textContent = '↗';
      focusBtn.title = 'Focus tab';
      focusBtn.setAttribute('aria-label', 'Focus tab');
      focusBtn.addEventListener('click', () => sendMsg({ action: 'FOCUS_TAB', tabId: t.id, windowId: t.windowId }));

      const reloadBtn = document.createElement('button');
      reloadBtn.type = 'button';
      reloadBtn.className = 'ext-btn ext-btn--sm';
      reloadBtn.textContent = '↻';
      reloadBtn.title = 'Reload tab';
      reloadBtn.setAttribute('aria-label', 'Reload tab');
      reloadBtn.addEventListener('click', () => sendMsg({ action: 'RELOAD_TAB', tabId: t.id }));

      const closeBtn = document.createElement('button');
      closeBtn.type = 'button';
      closeBtn.className = 'ext-btn ext-btn--sm';
      closeBtn.textContent = '✕';
      closeBtn.title = 'Close tab';
      closeBtn.setAttribute('aria-label', 'Close tab');
      closeBtn.addEventListener('click', async () => {
        await sendMsg({ action: 'CLOSE_TAB', tabId: t.id });
        refreshOpenTabs();
      });

      actions.append(focusBtn, reloadBtn, closeBtn);
      row.append(left, actions);
      list.appendChild(row);
    }

    const loginIds = document.getElementById('loginIds');
    if (loginIds) updateIdCounters(extractCleanRawLines(loginIds));
  }

  async function refreshVerificationUi() {
    const r = await sendMsg({ action: 'SMS_POOL_STATE' });
    if (!r?.ok) return;
    const s = r.stats || {};
    document.getElementById('stTotal').textContent = String(s.total || 0);
    document.getElementById('stAvail').textContent = String(s.available || 0);
    document.getElementById('stOccup').textContent = String(s.in_use || 0);
    document.getElementById('stVerif').textContent = String(s.verified || 0);
    document.getElementById('stErr').textContent = String(s.permanent_error || 0);

    const tbody = document.getElementById('verifTableBody');
    tbody.textContent = '';
    for (const item of r.items || []) {
      const tr = document.createElement('tr');
      const tdP = document.createElement('td');
      tdP.textContent = item.phone;
      const tdS = document.createElement('td');
      tdS.textContent = item.status;
      const tdA = document.createElement('td');
      tdA.textContent = item.assignedTo || '—';
      const tdU = document.createElement('td');
      tdU.textContent = item.url || '';
      tdU.style.maxWidth = '140px';
      tdU.style.overflow = 'hidden';
      tdU.style.textOverflow = 'ellipsis';
      tr.append(tdP, tdS, tdA, tdU);
      tbody.appendChild(tr);
    }
  }

  function populateSettingsDialog(cur) {
    document.getElementById('setNotifyCaptcha').checked = Boolean(cur.notifyOnCaptcha);
    document.getElementById('setCloseCaptcha').checked = Boolean(cur.closeOnCaptcha);
    document.getElementById('setDisableCloseErr').checked = Boolean(cur.disableTabCloseOnError);
    document.getElementById('setCaptchaTimeout').value = String(cur.captchaTimeoutSec || 300);
    document.getElementById('setTypingSpeed').value = cur.typingSpeed || 'normal';
    document.getElementById('setHumanize').checked = Boolean(cur.humanizeTyping);
    document.getElementById('setTotpRetries').value = String(cur.totpMaxRetries || 3);
    document.getElementById('setWsUrl').value = cur.wsUrl || 'ws://127.0.0.1:8080';
  }

  document.addEventListener('DOMContentLoaded', async () => {
    document.getElementById('hSlider').addEventListener('input', (e) => {
      document.getElementById('hVal').textContent = `${e.target.value}%`;
    });
    document.getElementById('vSlider').addEventListener('input', (e) => {
      document.getElementById('vVal').textContent = `${e.target.value}%`;
    });
    document.getElementById('gapSlider').addEventListener('input', (e) => {
      document.getElementById('gapVal').textContent = `${Number(e.target.value).toFixed(1)}s`;
    });

    document.getElementById('popoutBtn').addEventListener('click', () => {
      if (hasChromeRuntime()) {
        chrome.windows.create({ url: chrome.runtime.getURL('popup/popup.html'), type: 'popup', width: 760, height: 640 });
      }
    });

    document.getElementById('openTabsBtn').addEventListener('click', async () => {
      const count = Number(document.getElementById('tabNumber').value || 1);
      const provider = document.getElementById('providerSelect').value;
      const hGap = Number(document.getElementById('hSlider').value || 20);
      const vGap = Number(document.getElementById('vSlider').value || 20);
      await sendMsg({
        action: 'OPEN_TABS_GRID',
        count,
        provider,
        hGap,
        vGap,
        screenWidth: window.screen?.availWidth || 1440,
        screenHeight: window.screen?.availHeight || 900
      });
      refreshOpenTabs();
    });

    document.getElementById('openExistingBtn').addEventListener('click', refreshOpenTabs);
    document.getElementById('reorderTabsBtn').addEventListener('click', async () => {
      await sendMsg({ action: 'REORDER_TABS' });
      refreshOpenTabs();
    });
    document.getElementById('reloadTabsBtn').addEventListener('click', () => sendMsg({ action: 'RELOAD_ALL_TABS' }));
    document.getElementById('logoutAllBtn').addEventListener('click', () => sendMsg({ action: 'LOGOUT_ALL_ACCOUNTS' }));
    document.getElementById('closeAllBtn').addEventListener('click', async () => {
      await sendMsg({ action: 'CLOSE_ALL_MAIL_TABS' });
      refreshOpenTabs();
    });

    // Live credential box with caret-preserving highlighting & Excel table paste
    const loginIds = document.getElementById('loginIds');
    loginIds.addEventListener('paste', (e) => {
      const html = e.clipboardData?.getData('text/html');
      const plain = e.clipboardData?.getData('text/plain') || '';
      e.preventDefault();
      const text = html && /<t[rdh]/i.test(html) ? CREDS.convertTableHtmlToPlainText(html) : plain;
      loginIds.innerText = text;
      renderHighlightedIds(loginIds, false);
    });
    loginIds.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const sel = window.getSelection();
        if (sel && sel.rangeCount > 0) {
          const range = sel.getRangeAt(0);
          range.deleteContents();
          const nl = document.createTextNode('\n');
          range.insertNode(nl);
          range.setStartAfter(nl);
          range.collapse(true);
          sel.removeAllRanges();
          sel.addRange(range);
        }
        renderHighlightedIds(loginIds, true);
      }
    });
    loginIds.addEventListener('input', () => {
      renderHighlightedIds(loginIds, true);
    });
    loginIds.addEventListener('blur', () => renderHighlightedIds(loginIds, false));

    document.getElementById('loginQueueBtn').addEventListener('click', async () => {
      const lines = extractCleanRawLines(loginIds);
      const accounts = lines.map(CREDS.parseCredentialLine).filter(Boolean);
      if (accounts.length === 0) {
        setStatusMsg('Paste at least one valid account line first.', 'warn');
        return;
      }
      const gapSec = Number(document.getElementById('gapSlider').value || 4);
      const hGap = Number(document.getElementById('hSlider').value || 20);
      const vGap = Number(document.getElementById('vSlider').value || 20);
      const defaultProxy = document.getElementById('standaloneProxyInput').value.trim();
      const normalized = accounts.map((a) => ({ ...a, proxy: a.proxy || defaultProxy }));
      const hasSocksAuth = normalized.some((a) => /^socks/i.test(a.proxy || '') && a.proxy.includes('@'));
      const res = await sendMsg({
        action: 'START_LOGIN_QUEUE',
        accounts: normalized,
        gapSec,
        assignExistingTabs: currentTabCount >= normalized.length,
        hGap,
        vGap
      });
      setStatusMsg(
        hasSocksAuth
          ? `Queued ${res?.queued || normalized.length}. Note: SOCKS5 auth requires "Isolated Proxy" launch.`
          : `Queued ${res?.queued || normalized.length} login(s).`,
        hasSocksAuth ? 'warn' : 'ok'
      );
      setTimeout(refreshOpenTabs, 500);
    });

    document.getElementById('launchIsolatedBtn').addEventListener('click', async () => {
      const lines = extractCleanRawLines(loginIds);
      const accounts = lines.map(CREDS.parseCredentialLine).filter(Boolean);
      if (accounts.length === 0) {
        setStatusMsg('Paste accounts in GMAIL IDS first.', 'warn');
        return;
      }
      if (!hasChromeRuntime()) {
        setStatusMsg('Controller WebSocket unavailable outside extension.', 'warn');
        return;
      }
      const settings = await SET.load();
      const defaultProxy = document.getElementById('standaloneProxyInput').value.trim();
      setStatusMsg(`Launching ${accounts.length} isolated browser(s) via Controller WS...`);
      try {
        const res = await sendMsg({
          action: 'LAUNCH_ISOLATED_ACCOUNTS',
          bulk: lines.join('\n'),
          accounts,
          defaultProxy,
          wsUrl: settings.wsUrl
        });
        const errs = Array.isArray(res?.errors) ? res.errors : [];
        const navErrs = Array.isArray(res?.results) ? res.results.filter((r) => r.navError) : [];
        if (!res?.ok) {
          const detail = errs[0]?.error || res?.error || 'Failed to launch isolated browser(s).';
          setStatusMsg(detail, 'warn');
          return;
        }
        if (errs.length > 0 || navErrs.length > 0) {
          const firstErr = errs[0]
            ? `${errs[0].email}: ${errs[0].error}`
            : `${navErrs[0].email}: ${navErrs[0].navError}`;
          setStatusMsg(`Launched ${res.launched || 0}; ${errs.length + navErrs.length} issue(s) (${firstErr})`, 'warn');
        } else {
          setStatusMsg(`Launched ${res.launched || 0} isolated proxied browser(s) via Controller.`, 'ok');
        }
        setTimeout(refreshOpenTabs, 500);
      } catch (err) {
        setStatusMsg(`Controller unreachable: ${err.message}`, 'warn');
      }
    });

    document.getElementById('applyProxyBtn').addEventListener('click', async () => {
      const proxy = document.getElementById('standaloneProxyInput').value.trim();
      const r = await sendMsg({ action: 'SET_STANDALONE_PROXY', proxy });
      if (!r?.ok) {
        setStatusMsg(r?.error || 'Failed to apply standalone proxy.', 'warn');
      } else if (r?.config?.warning) {
        setStatusMsg(r.config.warning, 'warn');
      } else {
        setStatusMsg(proxy ? `Standalone proxy applied (${r?.config?.scheme || 'http'}).` : 'Standalone proxy cleared (direct).', 'ok');
      }
    });

    // Verification toggle & actions
    const verifToggle = document.getElementById('verifToggleBtn');
    const verifBody = document.getElementById('verifBody');
    verifToggle.addEventListener('click', () => {
      verifBody.hidden = !verifBody.hidden;
      verifToggle.setAttribute('aria-expanded', String(!verifBody.hidden));
      if (!verifBody.hidden) refreshVerificationUi();
    });
    document.getElementById('verifSyncBtn').addEventListener('click', async () => {
      await sendMsg({ action: 'SMS_POOL_SYNC', raw: document.getElementById('verifInput').value });
      refreshVerificationUi();
    });
    document.getElementById('verifPullBtn').addEventListener('click', async () => {
      const r = await sendMsg({ action: 'SMS_POOL_STATE' });
      if (r?.raw !== undefined) document.getElementById('verifInput').value = r.raw;
      refreshVerificationUi();
    });
    document.getElementById('verifResetErrBtn').addEventListener('click', async () => {
      await sendMsg({ action: 'SMS_POOL_RESET_ERRORS' });
      refreshVerificationUi();
    });
    document.getElementById('verifClearBtn').addEventListener('click', async () => {
      await sendMsg({ action: 'SMS_POOL_CLEAR' });
      document.getElementById('verifInput').value = '';
      refreshVerificationUi();
    });

    // Automation Settings Dialog
    const dlg = document.getElementById('automationSettingsDialog');
    document.getElementById('openSettingsBtn').addEventListener('click', async () => {
      const cur = await SET.load();
      populateSettingsDialog(cur);
      dlg.showModal();
    });
    document.getElementById('settingsDlgClose').addEventListener('click', () => {
      dlg.returnValue = '';
      dlg.close();
    });
    document.getElementById('resetSettingsBtn').addEventListener('click', async () => {
      const def = await SET.reset();
      populateSettingsDialog(def);
    });
    document.getElementById('settingsForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const nextSettings = {
        notifyOnCaptcha: document.getElementById('setNotifyCaptcha').checked,
        closeOnCaptcha: document.getElementById('setCloseCaptcha').checked,
        disableTabCloseOnError: document.getElementById('setDisableCloseErr').checked,
        captchaTimeoutSec: Number(document.getElementById('setCaptchaTimeout').value || 300),
        typingSpeed: document.getElementById('setTypingSpeed').value,
        humanizeTyping: document.getElementById('setHumanize').checked,
        totpMaxRetries: Number(document.getElementById('setTotpRetries').value || 3),
        wsUrl: document.getElementById('setWsUrl').value.trim()
      };
      await SET.save(nextSettings);
      await sendMsg({ action: 'UPDATE_AUTOMATION_SETTINGS', settings: nextSettings });
      dlg.returnValue = '';
      dlg.close();
    });

    if (hasChromeRuntime() && chrome.runtime.onMessage) {
      chrome.runtime.onMessage.addListener((msg) => {
        if (msg.action === 'VERIFICATION_STATUS_UPDATE') {
          currentStatuses = msg.statuses || {};
          renderHighlightedIds(loginIds, false);
          refreshOpenTabs();
        }
      });
    }

    const curSettings = await SET.load();
    if (curSettings.standaloneProxy) {
      document.getElementById('standaloneProxyInput').value = curSettings.standaloneProxy;
    }
    const wsChip = document.getElementById('wsChip');
    if (wsChip && hasChromeRuntime()) {
      const wsSt = await sendMsg({ action: 'GET_WS_STATUS' }).catch(() => null);
      const label = wsChip.querySelector('span:last-child');
      if (label) label.textContent = wsSt?.connected ? 'Active' : 'Standby';
    }
    const vs = await sendMsg({ action: 'GET_VERIFICATION_STATUSES' });
    if (vs?.statuses) currentStatuses = vs.statuses;
    await refreshOpenTabs();
  });
})();
