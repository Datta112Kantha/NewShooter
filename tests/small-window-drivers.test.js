'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');
const { createServer } = require('../src/server/app');

test('E2E Small-Window Viewport Compose, Sidebar Parity, and Readiness Announcements (B08, B09, B14, B15, B21)', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-small-window-'));
  const extDir = path.resolve(__dirname, '../extension');
  const app = createServer({
    port: 0,
    dataDir: path.join(tmpDir, 'data'),
    profilesRoot: path.join(tmpDir, 'profiles'),
    headless: true
  });
  const addr = await app.start(0, '127.0.0.1');
  const wsUrl = `ws://127.0.0.1:${addr.port}`;

  const profileDir = path.join(tmpDir, 'ext-profile');
  fs.mkdirSync(profileDir, { recursive: true });
  const context = await chromium.launchPersistentContext(profileDir, {
    channel: 'chromium',
    headless: true,
    viewport: { width: 480, height: 420 },
    ignoreDefaultArgs: ['--disable-extensions'],
    args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`]
  });

  try {
    let sw = context.serviceWorkers()[0];
    if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 10000 });
    const extId = sw.url().split('/')[2];

    const popupPage = await context.newPage();
    await popupPage.goto(`chrome-extension://${extId}/popup/popup.html`, { waitUntil: 'load' });
    await popupPage.click('#openSettingsBtn');
    await popupPage.fill('#setWsUrl', wsUrl);
    await popupPage.selectOption('#setTypingSpeed', 'instant');
    await popupPage.click('#settingsForm button[type="submit"]');
    await popupPage.waitForFunction(() => !document.getElementById('automationSettingsDialog').open);
    await popupPage.close();

    for (let i = 0; i < 30; i++) {
      const open = await sw.evaluate(() => Boolean(ws && ws.readyState === WebSocket.OPEN));
      if (open) break;
      await new Promise((r) => setTimeout(r, 100));
    }

    // 1. Gmail Small Window:
    // - div[gh="cm"] is NOT present initially (hidden navigation drawer)
    // - Readiness announced because URL contains #inbox and search box input[name="q"] is present
    // - Sidebar mounts and persists collapse state in sessionStorage
    // - Hamburger menu fallback reveals compose button, allowing EXECUTE_DISPATCH to succeed
    await context.route('https://mail.google.com/**', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: `<!doctype html><html><head><title>Inbox - smallgm@gmail.com - Gmail</title></head><body>
          <input name="q" type="text" placeholder="Search mail" />
          <button type="button" aria-label="Main menu" onclick="
            document.getElementById('navDrawer').style.display='block';
          ">Menu</button>
          <div id="navDrawer" style="display:none">
            <div gh="cm" role="button" onclick="document.getElementById('gmSmallCompose').hidden=false;">Compose</div>
          </div>
          <div id="gmSmallCompose" hidden>
            <input aria-label="To" type="text" />
            <input name="subjectbox" type="text" />
            <div aria-label="Message Body" contenteditable="true" style="min-height:30px"></div>
            <div id="gmSendBtn" role="button" aria-label="Send">Send</div>
          </div>
          <script>
            document.getElementById('gmSendBtn').addEventListener('click', function () {
              window.__smallGmSent = {
                to: document.querySelector('input[aria-label="To"]').value,
                subject: document.querySelector('input[name="subjectbox"]').value,
                body: document.querySelector('div[aria-label="Message Body"]').innerHTML
              };
            });
          </script>
        </body></html>`
      });
    });

    const gmPage = await context.newPage();
    gmPage.on('console', (msg) => console.log('PAGE LOG:', msg.text()));
    await gmPage.goto('https://mail.google.com/mail/u/0/#inbox', { waitUntil: 'load' });

    // Wait for INBOX_READY decoupled from div[gh="cm"]
    for (let i = 0; i < 40; i++) {
      if (app.store.listOnlineTabs().some((t) => t.email === 'smallgm@gmail.com')) break;
      await new Promise((r) => setTimeout(r, 150));
    }
    assert.ok(app.store.listOnlineTabs().some((t) => t.email === 'smallgm@gmail.com'), 'Expected Gmail decoupled INBOX_READY');

    // Sidebar mounted
    await gmPage.waitForSelector('#ns-relay-sidebar', { timeout: 6000 });
    // Verify sessionStorage persistence of collapsed state
    const initCollapsed = await gmPage.evaluate(() => sessionStorage.getItem('ns_sidebar_collapsed'));
    assert.equal(initCollapsed, 'true');

    // Click header to expand
    await gmPage.click('#ns-relay-sidebar > div:first-child');
    await gmPage.waitForFunction(() => document.getElementById('ns-sidebar-recipients').offsetParent !== null);
    const expandedVal = await gmPage.evaluate(() => sessionStorage.getItem('ns_sidebar_collapsed'));
    assert.equal(expandedVal, 'false');

    // Click header again to collapse
    await gmPage.click('#ns-relay-sidebar > div:first-child');
    await gmPage.waitForFunction(() => document.getElementById('ns-sidebar-recipients').offsetParent === null);
    const reCollapsedVal = await gmPage.evaluate(() => sessionStorage.getItem('ns_sidebar_collapsed'));
    assert.equal(reCollapsedVal, 'true');

    // Dispatch send: compose button is initially hidden; fallback clicks hamburger menu
    app.wsHub.sendToAccount('smallgm@gmail.com', {
      type: 'EXECUTE_DISPATCH',
      taskId: 'gm_small_task_1',
      accountId: 'smallgm@gmail.com',
      provider: 'gmail',
      recipientEmail: 'target1@domain.com',
      subject: 'Small window test',
      body: '<p>Small window compose success</p>'
    });
    await gmPage.waitForFunction(() => Boolean(window.__smallGmSent), null, { timeout: 12000 });
    const gmSent = await gmPage.evaluate(() => window.__smallGmSent);
    assert.equal(gmSent.to, 'target1@domain.com');
    assert.equal(gmSent.subject, 'Small window test');
    await gmPage.close();

    // 2. Outlook Small Window:
    // - New mail button is NOT in DOM initially
    // - Inbox readiness announced decoupled from New mail button (has #MailList container)
    // - Floating sidebar parity: #ns-relay-sidebar is mounted
    // - Keyboard shortcut 'n' fallback opens compose dialog
    await context.route('https://outlook.live.com/**', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: `<!doctype html><html><head><title>Mail - smallout@outlook.com</title></head><body>
          <div id="MailList" data-folder-name="inbox"><span title="0 unread">0</span></div>
          <div id="outSmallCompose" hidden>
            <div aria-label="To" contenteditable="true" style="min-height:24px;border:1px solid #ccc" onkeydown="if(event.key==='Enter')event.preventDefault();"></div>
            <input aria-label="Add a subject" type="text" />
            <div aria-label="Message body, press Alt+F10 to exit" contenteditable="true" style="min-height:30px"></div>
            <button id="outSendBtn" type="button" aria-label="Send">Send</button>
          </div>
          <script>
            // Listen for keyboard shortcut 'n'
            window.addEventListener('keydown', function (e) {
              if (e.key === 'n' || e.key === 'N') {
                document.getElementById('outSmallCompose').hidden = false;
              }
            });
            document.getElementById('outSendBtn').addEventListener('click', function () {
              window.__smallOutSent = {
                to: document.querySelector('div[aria-label="To"]').textContent.trim(),
                subject: document.querySelector('input[aria-label="Add a subject"]').value,
                body: document.querySelector('div[aria-label*="Message body"]').innerHTML
              };
            });
          </script>
        </body></html>`
      });
    });

    const outPage = await context.newPage();
    await outPage.goto('https://outlook.live.com/mail/0/', { waitUntil: 'load' });

    // Wait for decoupled readiness
    for (let i = 0; i < 40; i++) {
      if (app.store.listOnlineTabs().some((t) => t.email === 'smallout@outlook.com')) break;
      await new Promise((r) => setTimeout(r, 150));
    }
    assert.ok(app.store.listOnlineTabs().some((t) => t.email === 'smallout@outlook.com'), 'Expected Outlook decoupled INBOX_READY');

    // Sidebar mounted on Outlook (parity)
    await outPage.waitForSelector('#ns-relay-sidebar', { timeout: 6000 });
    assert.equal(await outPage.locator('#ns-relay-sidebar').count(), 1);

    // Send via shortcut 'n' fallback
    app.wsHub.sendToAccount('smallout@outlook.com', {
      type: 'EXECUTE_DISPATCH',
      taskId: 'out_small_task_1',
      accountId: 'smallout@outlook.com',
      provider: 'outlook',
      recipientEmail: 'outtarget@domain.com',
      subject: 'Outlook small test',
      body: '<p>Outlook shortcut compose</p>'
    });
    await outPage.waitForFunction(() => Boolean(window.__smallOutSent), null, { timeout: 12000 });
    const outSent = await outPage.evaluate(() => window.__smallOutSent);
    assert.equal(outSent.to, 'outtarget@domain.com');
    assert.equal(outSent.subject, 'Outlook small test');
    await outPage.close();

    // 3. Yahoo Small Window:
    // - compose button is NOT present initially
    // - Compact compose icon [data-test-id="icon-btn-compose"] is present
    // - Readiness announced decoupled from compose button
    // - Floating sidebar parity mounted
    // - EXECUTE_DISPATCH succeeds via compact icon fallback
    await context.route('https://mail.yahoo.com/**', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: `<!doctype html><html><head><title>smallyahoo@yahoo.com - Yahoo Mail</title></head><body>
          <div data-test-id="mail-reader">
            <div data-test-folder-name="Inbox"><span data-test-id="folder-count">2</span></div>
          </div>
          <button type="button" data-test-id="icon-btn-compose" aria-label="Compose" onclick="
            document.getElementById('ySmallCompose').hidden = false;
          ">IconCompose</button>
          <div id="ySmallCompose" hidden>
            <input id="message-to-field" type="text" />
            <input data-test-id="compose-subject" type="text" />
            <div data-test-id="rte"><div contenteditable="true" style="min-height:30px"></div></div>
            <button id="ySendBtn" type="button" data-test-id="compose-send-button">Send</button>
          </div>
          <script>
            document.getElementById('ySendBtn').addEventListener('click', function () {
              window.__smallYSent = {
                to: document.getElementById('message-to-field').value,
                subject: document.querySelector('[data-test-id="compose-subject"]').value,
                body: document.querySelector('[data-test-id="rte"] [contenteditable="true"]').innerHTML
              };
            });
          </script>
        </body></html>`
      });
    });

    const yPage = await context.newPage();
    await yPage.goto('https://mail.yahoo.com/d/folders/1', { waitUntil: 'load' });

    // Wait for decoupled readiness
    for (let i = 0; i < 40; i++) {
      if (app.store.listOnlineTabs().some((t) => t.email === 'smallyahoo@yahoo.com')) break;
      await new Promise((r) => setTimeout(r, 150));
    }
    assert.ok(app.store.listOnlineTabs().some((t) => t.email === 'smallyahoo@yahoo.com'), 'Expected Yahoo decoupled INBOX_READY');

    // Sidebar mounted on Yahoo (parity)
    await yPage.waitForSelector('#ns-relay-sidebar', { timeout: 6000 });
    assert.equal(await yPage.locator('#ns-relay-sidebar').count(), 1);

    // Send via compact compose button fallback
    app.wsHub.sendToAccount('smallyahoo@yahoo.com', {
      type: 'EXECUTE_DISPATCH',
      taskId: 'y_small_task_1',
      accountId: 'smallyahoo@yahoo.com',
      provider: 'yahoo',
      recipientEmail: 'ytarget@domain.com',
      subject: 'Yahoo compact test',
      body: '<p>Yahoo compact compose</p>'
    });
    await yPage.waitForFunction(() => Boolean(window.__smallYSent), null, { timeout: 12000 });
    const ySent = await yPage.evaluate(() => window.__smallYSent);
    assert.equal(ySent.to, 'ytarget@domain.com');
    assert.equal(ySent.subject, 'Yahoo compact test');
    await yPage.close();

  } finally {
    await context.close();
    await app.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
