(function () {
  'use strict';

  const DOM = window.NewShooterDOM;
  const TAGS = window.NewShooterTags;
  let abortFlag = false;

  function extractEmailFromDom() {
    const titleMatch = (document.title || '').match(/[\w.+-]+@[\w.-]+\.[a-zA-Z]{2,}/);
    if (titleMatch) return titleMatch[0];
    const profileBtn = document.querySelector('[data-test-id="account-menu-button"], #ybarAccountMenuOpener');
    const m = (profileBtn?.getAttribute('aria-label') || profileBtn?.innerText || '').match(/[\w.+-]+@[\w.-]+\.[a-zA-Z]{2,}/);
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
    const isBlocked = bodyText.includes('sending limit') || bodyText.includes('temporarily blocked');

    return {
      inbox: readCount(['[data-test-folder-name="Inbox"] [data-test-id="folder-count"]', 'a[href*="/folders/1"] span:last-child']),
      draft: readCount(['[data-test-folder-name="Draft"] [data-test-id="folder-count"]', 'a[href*="/folders/3"] span:last-child']),
      sent: readCount(['[data-test-folder-name="Sent"] [data-test-id="folder-count"]', 'a[href*="/folders/2"] span:last-child']),
      spam: readCount(['[data-test-folder-name="Bulk"] [data-test-id="folder-count"]', 'a[href*="/folders/6"] span:last-child']),
      isBlocked
    };
  }

  async function executeSend(payload) {
    abortFlag = false;
    const { taskId, recipientEmail, subject, body, attachments = [] } = payload;
    const resolved = TAGS ? TAGS.processTags(recipientEmail, { subject, body }) : { subject, body };
    const report = (status, step, errorMessage) => {
      chrome.runtime.sendMessage({ action: 'TASK_STATUS_UPDATE', taskId, email: extractEmailFromDom() || payload.accountId, status, step, errorMessage });
    };

    try {
      const composeBtn = await DOM.waitForElement('[data-test-id="compose-button"], a[href*="/compose"]', 8000);
      if (!composeBtn) throw new Error('Yahoo Compose button not found');
      await DOM.cdpClickElement(composeBtn);

      if (abortFlag) return report('ABORTED', 'Aborted');

      const toField = await DOM.waitForElement('#message-to-field, input[aria-label*="To" i]', 8000);
      if (!toField) throw new Error('Yahoo To field not found');
      await DOM.typeOrganic(toField, recipientEmail, { useCdp: true });
      toField.focus();
      await chrome.runtime.sendMessage({ action: 'CDP_ENTER' }).catch(() => {});

      const subjField = await DOM.waitForElement('[data-test-id="compose-subject"], input[placeholder="Subject"]', 6000);
      if (!subjField) throw new Error('Yahoo Subject input not found');
      await DOM.typeOrganic(subjField, resolved.subject, { useCdp: true });

      const bodyField = await DOM.waitForElement('[data-test-id="rte"] [contenteditable="true"], div[aria-label="Message body"][contenteditable="true"]', 6000);
      if (!bodyField) throw new Error('Yahoo body editor not found');
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
      const sendBtn = await DOM.waitForElement('[data-test-id="compose-send-button"], button[title="Send this email"]', 6000);
      if (!sendBtn) throw new Error('Yahoo Send button not found');
      await DOM.cdpClickElement(sendBtn);
      await DOM.sleep(800);
      const folders = scrapeFolderCounts();
      if (folders.isBlocked) {
        return report('BLOCKED', 'Send Limit Reached', 'Yahoo sending limit reached');
      }
      report('SENT', 'Completed');
    } catch (err) {
      report('FAILED', 'Error', err.message);
    }
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.action === 'EXECUTE_DISPATCH') {
      executeSend(msg.payload);
      sendResponse({ ok: true });
      return true;
    }
    if (msg.action === 'ABORT_DISPATCH') {
      abortFlag = true;
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

  (async function pollYahooReady() {
    for (let i = 0; i < 16; i++) {
      await DOM.sleep(i === 0 ? 450 : 1000);
      if (document.querySelector('[data-test-id="compose-button"], a[href*="/compose"]')) {
        const f = scrapeFolderCounts();
        chrome.runtime.sendMessage({
          action: 'INBOX_READY',
          provider: 'yahoo',
          email: extractEmailFromDom() || document.title,
          inboxCount: f.inbox,
          draftCount: f.draft,
          sentCount: f.sent,
          spamCount: f.spam,
          isBlocked: f.isBlocked
        });
        break;
      }
    }
  })();
})();
