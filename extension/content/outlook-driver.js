(function () {
  'use strict';

  const DOM = window.NewShooterDOM;
  const TAGS = window.NewShooterTags;
  let abortFlag = false;

  function extractEmailFromDom() {
    const titleMatch = (document.title || '').match(/[\w.+-]+@[\w.-]+\.[a-zA-Z]{2,}/);
    if (titleMatch) return titleMatch[0];
    const me = document.querySelector('#mectrl_currentAccount_secondary, [data-testid="personaEmail"], [aria-label*="@"], div[title*="@"]');
    const m = (me?.getAttribute('aria-label') || me?.getAttribute('title') || me?.innerText || '').match(/[\w.+-]+@[\w.-]+\.[a-zA-Z]{2,}/);
    return m ? m[0] : '';
  }

  function scrapeFolderCounts() {
    const readCount = (selectors) => {
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el) {
          const n = parseInt((el.innerText || '').replace(/\D+/g, ''), 10);
          if (Number.isFinite(n)) return n;
        }
      }
      return 0;
    };
    const bodyText = (document.body?.innerText || '').toLowerCase();
    const isBlocked = bodyText.includes('unusual activity')
      || bodyText.includes('account has been suspended')
      || bodyText.includes('daily message limit');

    return {
      inbox: readCount(['[data-folder-name="inbox"] [title*="unread" i], [title^="Inbox"] span:last-child']),
      draft: readCount(['[data-folder-name="drafts"] span:last-child, [title^="Drafts"] span:last-child']),
      sent: readCount(['[data-folder-name="sentitems"] span:last-child, [title^="Sent"] span:last-child']),
      spam: readCount(['[data-folder-name="junkemail"] span:last-child, [title^="Junk"] span:last-child']),
      isBlocked
    };
  }

  async function openOutlookCompose() {
    const toFieldSelector = 'div[aria-label="To"][contenteditable="true"], input[aria-label="To"]';
    const existing = document.querySelector(toFieldSelector);
    if (existing && DOM.isElementVisible(existing)) return true;

    // Standard compose button: button[aria-label*="New mail" i], button[data-testid="ComposeButton"]
    let newMailBtn = await DOM.waitForElement('button[aria-label*="New mail" i], button[data-testid="ComposeButton"], [aria-label*="New message" i]', 2000);
    if (newMailBtn) {
      await DOM.cdpClickElement(newMailBtn);
      if (await DOM.waitForElement(toFieldSelector, 3000)) return true;
    }

    // Fallback a) Keyboard shortcut 'n' (standard Outlook shortcut to compose)
    DOM.simulateKeyPress('n');
    if (await DOM.waitForElement(toFieldSelector, 2500)) return true;

    // Fallback b) Hamburger menu button[aria-label*="Navigation" i]
    const navBtn = document.querySelector('button[aria-label*="Navigation" i], button[aria-label*="App launcher" i], button[aria-label*="Side pane" i], button[aria-label*="Show navigation" i]');
    if (navBtn) {
      await DOM.cdpClickElement(navBtn);
      await DOM.sleep(400);
      newMailBtn = await DOM.waitForElement('button[aria-label*="New mail" i], button[data-testid="ComposeButton"], [aria-label*="New message" i]', 2000);
      if (newMailBtn) {
        await DOM.cdpClickElement(newMailBtn);
        if (await DOM.waitForElement(toFieldSelector, 3000)) return true;
      }
    }

    // Fallback c) Compact icon / button
    const compactIcon = await DOM.waitForElement('button[aria-label*="New" i]:not([aria-label*="folder" i]), [data-icon-name="MailAdd"], button i[data-icon-name="ComposeRegular"], [data-testid="fluent-icon-mail-add"]', 2000);
    if (compactIcon) {
      const btn = compactIcon.closest('button') || compactIcon;
      await DOM.cdpClickElement(btn);
      if (await DOM.waitForElement(toFieldSelector, 3000)) return true;
    }

    // Fallback d) Temporarily apply zoom (document.body.style.zoom = "0.75")
    const origZoom = document.body.style.zoom || '';
    try {
      document.body.style.zoom = '0.75';
      window.dispatchEvent(new Event('resize'));
      await DOM.sleep(400);

      newMailBtn = await DOM.waitForElement('button[aria-label*="New mail" i], button[data-testid="ComposeButton"]', 2000);
      if (newMailBtn) {
        await DOM.cdpClickElement(newMailBtn);
        if (await DOM.waitForElement(toFieldSelector, 3000)) return true;
      }

      DOM.simulateKeyPress('n');
      if (await DOM.waitForElement(toFieldSelector, 2500)) return true;
    } finally {
      if (origZoom) {
        document.body.style.zoom = origZoom;
      } else {
        document.body.style.removeProperty('zoom');
      }
    }

    return false;
  }

  async function executeSend(payload) {
    abortFlag = false;
    const { taskId, recipientEmail, subject, body, attachments = [] } = payload;
    const resolved = TAGS ? TAGS.processTags(recipientEmail, { subject, body }) : { subject, body };

    const report = (status, step, errorMessage) => {
      chrome.runtime.sendMessage({
        action: 'TASK_STATUS_UPDATE',
        taskId,
        email: extractEmailFromDom() || payload.accountId,
        status,
        step,
        errorMessage
      });
    };

    try {
      const composeOpened = await openOutlookCompose();
      if (!composeOpened) throw new Error('Outlook New mail button not found');

      if (abortFlag) return report('ABORTED', 'Aborted');

      const toField = await DOM.waitForElement('div[aria-label="To"][contenteditable="true"], input[aria-label="To"]', 8000);
      if (!toField) throw new Error('Outlook To input not found');
      await DOM.typeOrganic(toField, recipientEmail, { useCdp: true });
      toField.focus();
      await chrome.runtime.sendMessage({ action: 'CDP_ENTER' }).catch(() => {});

      const subjField = await DOM.waitForElement('input[aria-label="Add a subject"], input[placeholder="Add a subject"]', 6000);
      if (!subjField) throw new Error('Outlook subject input not found');
      await DOM.typeOrganic(subjField, resolved.subject, { useCdp: true });

      const bodyField = await DOM.waitForElement('div[aria-label="Message body, press Alt+F10 to exit"], div[role="textbox"][contenteditable="true"]', 6000);
      if (!bodyField) throw new Error('Outlook message body not found');
      DOM.setSafeHtml(bodyField, resolved.body);
      bodyField.dispatchEvent(new Event('input', { bubbles: true }));

      if (Array.isArray(attachments) && attachments.length > 0) {
        const fileInput = document.querySelector('input[type="file"]');
        if (fileInput) {
          fileInput.files = DOM.decodeBase64Files(attachments).files;
          fileInput.dispatchEvent(new Event('change', { bubbles: true }));
          await DOM.sleep(900);
        }
      }

      if (abortFlag) return report('ABORTED', 'Aborted');

      const sendBtn = await DOM.waitForElement('button[aria-label="Send"], button[title="Send"]', 6000);
      if (!sendBtn) throw new Error('Outlook Send button not found');
      await DOM.cdpClickElement(sendBtn);
      await DOM.sleep(1000);
      const folders = scrapeFolderCounts();
      if (folders.isBlocked) {
        return report('BLOCKED', 'Send Limit Reached', 'Outlook daily sending limit reached');
      }
      report('SENT', 'Completed');
    } catch (err) {
      report('FAILED', 'Error', err.message);
    }
  }

  function mountRelaySidebar() {
    if (document.getElementById('ns-relay-sidebar')) return;
    if (!document.body) return;

    const root = document.createElement('aside');
    root.id = 'ns-relay-sidebar';
    Object.assign(root.style, {
      position: 'fixed',
      left: '14px',
      bottom: '16px',
      width: '264px',
      background: '#18181b',
      color: '#e4e4e7',
      border: '1px solid #3f3f46',
      borderRadius: '10px',
      boxShadow: '0 14px 36px rgba(0,0,0,0.45)',
      fontFamily: 'system-ui, -apple-system, sans-serif',
      fontSize: '12px',
      zIndex: '2147483000',
      overflow: 'hidden'
    });

    const header = document.createElement('div');
    Object.assign(header.style, {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: '8px 10px',
      background: '#09090b',
      borderBottom: '1px solid #27272a',
      cursor: 'pointer',
      userSelect: 'none',
      webkitUserSelect: 'none'
    });

    const titleWrap = document.createElement('div');
    Object.assign(titleWrap.style, { display: 'flex', alignItems: 'center', gap: '6px', fontWeight: '700', fontSize: '11px' });
    const dot = document.createElement('span');
    Object.assign(dot.style, { width: '7px', height: '7px', borderRadius: '999px', background: '#22c55e', display: 'inline-block' });
    const emailLabel = extractEmailFromDom() || 'outlook';
    const shortId = Array.from(emailLabel).reduce((a, c) => ((a * 31 + c.charCodeAt(0)) & 0xffffff), 7).toString(16).slice(0, 6);
    const idSpan = document.createElement('span');
    idSpan.id = 'ns-sidebar-id';
    idSpan.textContent = `ID · ${shortId}`;
    titleWrap.append(dot, idSpan);

    const toggleBtn = document.createElement('button');
    toggleBtn.type = 'button';
    toggleBtn.textContent = '+';
    Object.assign(toggleBtn.style, {
      background: 'transparent',
      border: 'none',
      color: '#a1a1aa',
      cursor: 'pointer',
      fontSize: '14px',
      lineHeight: '1',
      pointerEvents: 'none'
    });
    header.append(titleWrap, toggleBtn);

    const bodyWrap = document.createElement('div');
    Object.assign(bodyWrap.style, { padding: '10px', display: 'flex', flexDirection: 'column', gap: '7px' });

    const makeLbl = (txt) => {
      const l = document.createElement('label');
      l.textContent = txt;
      Object.assign(l.style, { fontSize: '10px', fontWeight: '700', color: '#a1a1aa', letterSpacing: '0.04em', display: 'block' });
      return l;
    };

    const recArea = document.createElement('textarea');
    recArea.id = 'ns-sidebar-recipients';
    recArea.placeholder = 'One email per line';
    Object.assign(recArea.style, {
      width: '100%', minHeight: '64px', background: '#09090b', color: '#f4f4f5', border: '1px solid #3f3f46',
      borderRadius: '6px', padding: '6px', fontSize: '11px', boxSizing: 'border-box', resize: 'vertical'
    });

    const subjIn = document.createElement('input');
    subjIn.id = 'ns-sidebar-subject';
    subjIn.type = 'text';
    subjIn.placeholder = 'Subject...';
    Object.assign(subjIn.style, {
      width: '100%', background: '#09090b', color: '#f4f4f5', border: '1px solid #3f3f46',
      borderRadius: '6px', padding: '6px', fontSize: '11px', boxSizing: 'border-box'
    });

    const msgArea = document.createElement('textarea');
    msgArea.id = 'ns-sidebar-message';
    msgArea.placeholder = 'HTML or message text...';
    Object.assign(msgArea.style, {
      width: '100%', minHeight: '58px', background: '#09090b', color: '#f4f4f5', border: '1px solid #3f3f46',
      borderRadius: '6px', padding: '6px', fontSize: '11px', boxSizing: 'border-box', resize: 'vertical'
    });

    const footerRow = document.createElement('div');
    Object.assign(footerRow.style, { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '6px', marginTop: '2px' });

    const statusLine = document.createElement('span');
    statusLine.id = 'ns-sidebar-status';
    statusLine.textContent = 'Ready';
    Object.assign(statusLine.style, { fontSize: '10px', color: '#a1a1aa' });

    const startBtn = document.createElement('button');
    startBtn.id = 'ns-sidebar-start';
    startBtn.type = 'button';
    startBtn.textContent = 'Start';
    Object.assign(startBtn.style, {
      background: '#16a34a', color: '#ffffff', border: 'none', borderRadius: '6px',
      padding: '6px 14px', fontSize: '11px', fontWeight: '700', cursor: 'pointer'
    });

    footerRow.append(statusLine, startBtn);
    bodyWrap.append(makeLbl('RECIPIENTS'), recArea, makeLbl('SUBJECT'), subjIn, makeLbl('MESSAGE'), msgArea, footerRow);
    root.append(header, bodyWrap);

    const STORAGE_KEY = 'ns_sidebar_collapsed';
    let collapsed = true;
    try {
      const saved = sessionStorage.getItem(STORAGE_KEY);
      if (saved !== null) {
        collapsed = saved === 'true';
      }
    } catch {}

    const setCollapsed = (next) => {
      collapsed = Boolean(next);
      try {
        sessionStorage.setItem(STORAGE_KEY, String(collapsed));
      } catch {}
      bodyWrap.style.display = collapsed ? 'none' : 'flex';
      toggleBtn.textContent = collapsed ? '+' : '−';
    };
    setCollapsed(collapsed);

    header.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      setCollapsed(!collapsed);
    });

    let localRunning = false;
    startBtn.addEventListener('click', async () => {
      if (localRunning) {
        abortFlag = true;
        localRunning = false;
        startBtn.textContent = 'Start';
        startBtn.style.background = '#16a34a';
        statusLine.textContent = 'Stopped';
        return;
      }
      const recipients = recArea.value.split(/[\r\n,;]+/).map((s) => s.trim()).filter((s) => s.includes('@'));
      if (recipients.length === 0) {
        statusLine.textContent = 'Add recipients';
        return;
      }
      localRunning = true;
      abortFlag = false;
      startBtn.textContent = 'Stop';
      startBtn.style.background = '#dc2626';
      for (let i = 0; i < recipients.length; i++) {
        if (abortFlag) break;
        statusLine.textContent = `Sending ${i + 1}/${recipients.length}`;
        await executeSend({
          taskId: `local_${Date.now()}_${i}`,
          recipientEmail: recipients[i],
          subject: subjIn.value,
          body: msgArea.value
        });
        await DOM.sleep(1500);
      }
      localRunning = false;
      startBtn.textContent = 'Start';
      startBtn.style.background = '#16a34a';
      if (!abortFlag) statusLine.textContent = `Done (${recipients.length})`;
    });

    document.body.appendChild(root);
    window.__newShooterOutlookSidebar = { setCollapsed, root };
  }

  let inboxAnnounced = false;
  function announceReady() {
    if (inboxAnnounced) return true;
    const url = window.location.href || '';
    const isOutlookPage = url.includes('outlook.live.com') || url.includes('outlook.office.com') || url.includes('outlook.office365.com');
    const hasSearch = !!document.querySelector('input[aria-label*="Search" i], #topSearchInput, input[placeholder*="Search" i]');
    const hasMain = !!document.querySelector('[role="main"], [data-folder-name], #MailList, div[aria-label*="Message list" i], button[aria-label*="New mail" i], button[data-testid="ComposeButton"]');
    if (!isOutlookPage && !hasSearch && !hasMain) return false;

    const email = extractEmailFromDom() || (document.title.match(/[\w.+-]+@[\w.-]+\.[a-zA-Z]{2,}/)?.[0] || '');
    if (!email) return false;

    inboxAnnounced = true;
    mountRelaySidebar();
    const idSpan = document.getElementById('ns-sidebar-id');
    if (idSpan) {
      const shortId = Array.from(email).reduce((a, c) => ((a * 31 + c.charCodeAt(0)) & 0xffffff), 7).toString(16).slice(0, 6);
      idSpan.textContent = `ID · ${shortId}`;
    }
    const f = scrapeFolderCounts();
    chrome.runtime.sendMessage({
      action: 'INBOX_READY',
      email,
      provider: 'outlook',
      inboxCount: f.inbox,
      draftCount: f.draft,
      sentCount: f.sent,
      spamCount: f.spam,
      isBlocked: f.isBlocked
    });
    return true;
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.action === 'EXECUTE_DISPATCH') {
      executeSend(msg.payload);
      sendResponse({ ok: true });
      return true;
    }
    if (msg.action === 'ABORT_DISPATCH') {
      abortFlag = true;
      if (msg.reload) setTimeout(() => window.location.reload(), 200);
      sendResponse({ ok: true });
      return true;
    }
    if (msg.action === 'FETCH_FOLDERS') {
      const f = scrapeFolderCounts();
      chrome.runtime.sendMessage({ action: 'FOLDER_COUNTS_RESULT', email: extractEmailFromDom(), ...f });
      sendResponse({ ok: true, ...f });
      return true;
    }
    return false;
  });

  (async function pollOutlookReady() {
    for (let i = 0; i < 20; i++) {
      await DOM.sleep(i === 0 ? 450 : 1000);
      if (announceReady()) break;
    }
  })();
})();
