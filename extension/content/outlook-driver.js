(function () {
  'use strict';

  const DOM = window.NewShooterDOM;
  const TAGS = window.NewShooterTags;
  let abortFlag = false;

  function extractEmailFromDom() {
    const titleMatch = (document.title || '').match(/[\w.+-]+@[\w.-]+\.[a-zA-Z]{2,}/);
    if (titleMatch) return titleMatch[0];
    const me = document.querySelector('#mectrl_currentAccount_secondary, [data-testid="personaEmail"]');
    return me ? (me.innerText || '').trim() : '';
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
      const newMailBtn = await DOM.waitForElement('button[aria-label*="New mail" i], button[data-testid="ComposeButton"]', 8000);
      if (!newMailBtn) throw new Error('Outlook New mail button not found');
      await DOM.cdpClickElement(newMailBtn);

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

  (async function pollOutlookReady() {
    for (let i = 0; i < 16; i++) {
      await DOM.sleep(i === 0 ? 450 : 1000);
      if (document.querySelector('button[aria-label*="New mail" i], button[data-testid="ComposeButton"]')) {
        const f = scrapeFolderCounts();
        chrome.runtime.sendMessage({
          action: 'INBOX_READY',
          email: extractEmailFromDom(),
          provider: 'outlook',
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
