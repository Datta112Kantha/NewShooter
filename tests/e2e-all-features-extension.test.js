'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const crypto = require('node:crypto');
const { chromium } = require('playwright');

const { createServer } = require('../src/server/app');
const { startMockHttpProxy, startMockSocks5Server } = require('./helpers/mockProxies');

const extDir = path.resolve(__dirname, '../extension');

// ── WebSocket Client Helper ──────────────────────────────────────────────────
function encodeMaskedClientFrame(text) {
  const payload = Buffer.from(text, 'utf8');
  const mask = crypto.randomBytes(4);
  let header;
  if (payload.length < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x81;
    header[1] = 0x80 | payload.length;
  } else {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2);
  }
  const masked = Buffer.from(payload);
  for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4];
  return Buffer.concat([header, mask, masked]);
}

function connectRawWs(port, pathName = '/', extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64');
    const sock = net.createConnection({ host: '127.0.0.1', port }, () => {
      const lines = [
        `GET ${pathName} HTTP/1.1`,
        `Host: 127.0.0.1:${port}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${key}`,
        'Sec-WebSocket-Version: 13'
      ];
      for (const [k, v] of Object.entries(extraHeaders)) {
        lines.push(`${k}: ${v}`);
      }
      lines.push('\r\n');
      sock.write(lines.join('\r\n'));
    });

    let buf = Buffer.alloc(0);
    let upgraded = false;
    const msgQueue = [];
    const waiters = [];

    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (!upgraded) {
        const idx = buf.indexOf('\r\n\r\n');
        if (idx !== -1) {
          const respHeader = buf.subarray(0, idx).toString('utf8');
          if (!respHeader.includes('101 Switching Protocols')) {
            reject(new Error(`WebSocket upgrade failed: ${respHeader.split('\r\n')[0]}`));
            sock.destroy();
            return;
          }
          upgraded = true;
          buf = buf.subarray(idx + 4);
        }
      }
      if (upgraded) {
        while (buf.length >= 2) {
          const second = buf[1];
          const hasMask = Boolean(second & 0x80);
          let len = second & 0x7f;
          let offset = 2;
          if (len === 126) {
            if (buf.length < 4) break;
            len = buf.readUInt16BE(2);
            offset = 4;
          } else if (len === 127) {
            if (buf.length < 10) break;
            len = Number(buf.readBigUInt64BE(2));
            offset = 10;
          }
          const maskLen = hasMask ? 4 : 0;
          if (buf.length < offset + maskLen + len) break;

          let payload = buf.subarray(offset + maskLen, offset + maskLen + len);
          if (hasMask) {
            const mask = buf.subarray(offset, offset + 4);
            const unmasked = Buffer.from(payload);
            for (let i = 0; i < unmasked.length; i++) unmasked[i] ^= mask[i % 4];
            payload = unmasked;
          }
          buf = buf.subarray(offset + maskLen + len);

          try {
            const parsed = JSON.parse(payload.toString('utf8'));
            if (waiters.length > 0) {
              const w = waiters.shift();
              w(parsed);
            } else {
              msgQueue.push(parsed);
            }
          } catch {}
        }
      }
    });

    sock.on('error', (err) => {
      if (!upgraded) reject(err);
    });

    sock.on('connect', () => {
      resolve({
        sock,
        sendJson: (obj) => {
          sock.write(encodeMaskedClientFrame(JSON.stringify(obj)));
        },
        nextMessage: (predicate = () => true, timeoutMs = 8000) => {
          const existingIdx = msgQueue.findIndex(predicate);
          if (existingIdx !== -1) {
            return Promise.resolve(msgQueue.splice(existingIdx, 1)[0]);
          }
          return new Promise((res, rej) => {
            const t = setTimeout(() => rej(new Error('nextMessage timed out')), timeoutMs);
            waiters.push((msg) => {
              if (predicate(msg)) {
                clearTimeout(t);
                res(msg);
              }
            });
          });
        },
        close: () => sock.destroy()
      });
    });
  });
}

// ── Test 1: Standalone extension popup window launch via chrome.action.onClicked ─
test('1. Extension Popup: Standalone window launch via chrome.action.onClicked', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-e2e-action-'));
  const profileDir = path.join(tmpDir, 'profile');
  fs.mkdirSync(profileDir, { recursive: true });

  // Verify manifest specifies no default_popup
  const manifest = JSON.parse(fs.readFileSync(path.join(extDir, 'manifest.json'), 'utf8'));
  assert.equal(manifest.action.default_popup, undefined, 'manifest.action.default_popup must not be defined');
  assert.equal(manifest.action.default_title, 'Control Browser - BIN4RY');

  const context = await chromium.launchPersistentContext(profileDir, {
    channel: 'chromium',
    headless: true,
    ignoreDefaultArgs: ['--disable-extensions'],
    args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`]
  });

  try {
    let sw = context.serviceWorkers()[0];
    if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 10000 });
    const extId = sw.url().split('/')[2];
    const expectedPopupUrl = `chrome-extension://${extId}/popup/popup.html`;

    // 1. Verify action listener is registered in service worker
    const hasListeners = await sw.evaluate(() => chrome.action.onClicked.hasListeners());
    assert.equal(hasListeners, true, 'chrome.action.onClicked must have registered listener');

    // 2. Dispatch chrome.action.onClicked and verify dedicated popup window opens
    const pagePromise = context.waitForEvent('page', { timeout: 8000 });
    await sw.evaluate(() => chrome.action.onClicked.dispatch({ id: 1 }));
    const popupPage = await pagePromise;
    await popupPage.waitForLoadState('load');

    assert.equal(popupPage.url(), expectedPopupUrl, 'Popup page URL must match popup/popup.html');

    // Check window type is popup
    const popupWin = await sw.evaluate(async (url) => {
      const wins = await chrome.windows.getAll({ populate: true });
      return wins.find((w) => w.tabs && w.tabs.some((t) => t.url && t.url.startsWith(url)));
    }, expectedPopupUrl);
    assert.ok(popupWin, 'Popup window must exist in chrome.windows');
    assert.equal(popupWin.type, 'popup', 'Window type must be popup');

    // 3. Dispatching onClicked again must focus existing window, NOT duplicate
    const pagesBefore = context.pages().length;
    await sw.evaluate(() => chrome.action.onClicked.dispatch({ id: 1 }));
    await new Promise((r) => setTimeout(r, 600));
    const pagesAfter = context.pages().length;
    assert.equal(pagesAfter, pagesBefore, 'Second onClicked must not open duplicate popup window');

    // Verify popup header elements exist
    await popupPage.waitForSelector('.ext-brand__title');
    const brandTitle = await popupPage.locator('.ext-brand__title').innerText();
    assert.equal(brandTitle, 'Control Browser - BIN4RY');
  } finally {
    await context.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── Test 2: Settings modal dialog (#automationSettingsDialog) ────────────────
test('2. Extension Settings: Modal dialog #automationSettingsDialog, form updates & chrome.storage.local persistence', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-e2e-settings-'));
  const profileDir = path.join(tmpDir, 'profile');
  fs.mkdirSync(profileDir, { recursive: true });

  const context = await chromium.launchPersistentContext(profileDir, {
    channel: 'chromium',
    headless: true,
    ignoreDefaultArgs: ['--disable-extensions'],
    args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`]
  });

  try {
    let sw = context.serviceWorkers()[0];
    if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 10000 });
    const extId = sw.url().split('/')[2];

    const popupPage = await context.newPage();
    await popupPage.goto(`chrome-extension://${extId}/popup/popup.html`, { waitUntil: 'load' });

    // 1. Initial state: settings dialog is closed
    const isInitiallyOpen = await popupPage.evaluate(() => document.getElementById('automationSettingsDialog').open);
    assert.equal(isInitiallyOpen, false, 'Dialog must be closed initially');

    // 2. Open dialog via gear button
    await popupPage.click('#openSettingsBtn');
    await popupPage.waitForFunction(() => document.getElementById('automationSettingsDialog').open);

    // Verify default values
    const defaultWsUrl = await popupPage.inputValue('#setWsUrl');
    const defaultTyping = await popupPage.inputValue('#setTypingSpeed');
    const defaultHumanize = await popupPage.isChecked('#setHumanize');
    assert.equal(defaultWsUrl, 'ws://127.0.0.1:8080');
    assert.equal(defaultTyping, 'normal');
    assert.equal(defaultHumanize, true);

    // 3. Update all settings: WS URL, typing speed, jitter, delays, timeouts
    const customWsUrl = 'ws://127.0.0.1:9876';
    await popupPage.fill('#setWsUrl', customWsUrl);
    await popupPage.fill('#setCaptchaTimeout', '450');
    await popupPage.selectOption('#setTypingSpeed', 'instant');
    await popupPage.uncheck('#setHumanize');
    await popupPage.fill('#setTotpRetries', '5');
    await popupPage.check('#setCloseCaptcha');
    await popupPage.uncheck('#setNotifyCaptcha');
    await popupPage.check('#setDisableCloseErr');

    // 4. Save settings
    await popupPage.click('#settingsForm button[type="submit"]');
    await popupPage.waitForFunction(() => !document.getElementById('automationSettingsDialog').open);

    // 5. Verify values persisted in chrome.storage.local
    const stored = await sw.evaluate(() => chrome.storage.local.get(['automationSettings']));
    const cfg = stored.automationSettings;
    assert.ok(cfg, 'automationSettings must be saved in storage');
    assert.equal(cfg.wsUrl, customWsUrl);
    assert.equal(cfg.captchaTimeoutSec, 450);
    assert.equal(cfg.typingSpeed, 'instant');
    assert.equal(cfg.humanizeTyping, false);
    assert.equal(cfg.totpMaxRetries, 5);
    assert.equal(cfg.closeOnCaptcha, true);
    assert.equal(cfg.notifyOnCaptcha, false);
    assert.equal(cfg.disableTabCloseOnError, true);

    // 6. Test Reset Defaults button
    await popupPage.click('#openSettingsBtn');
    await popupPage.waitForFunction(() => document.getElementById('automationSettingsDialog').open);
    await popupPage.click('#resetSettingsBtn');

    // Verify fields reverted in the open dialog
    assert.equal(await popupPage.inputValue('#setWsUrl'), 'ws://127.0.0.1:8080');
    assert.equal(await popupPage.inputValue('#setTypingSpeed'), 'normal');
    assert.equal(await popupPage.isChecked('#setHumanize'), true);
    assert.equal(await popupPage.inputValue('#setCaptchaTimeout'), '300');

    // Close dialog
    await popupPage.click('#settingsDlgClose');
    await popupPage.waitForFunction(() => !document.getElementById('automationSettingsDialog').open);
  } finally {
    await context.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── Test 3: Multi-account bulk table paste parsing (#loginIds) & Syntax Highlighting
test('3. Extension IDs: Multi-account bulk table paste parsing (#loginIds), tokens & syntax error highlighting', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-e2e-creds-'));
  const profileDir = path.join(tmpDir, 'profile');
  fs.mkdirSync(profileDir, { recursive: true });

  const context = await chromium.launchPersistentContext(profileDir, {
    channel: 'chromium',
    headless: true,
    ignoreDefaultArgs: ['--disable-extensions'],
    args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`]
  });

  try {
    let sw = context.serviceWorkers()[0];
    if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 10000 });
    const extId = sw.url().split('/')[2];

    const popupPage = await context.newPage();
    await popupPage.goto(`chrome-extension://${extId}/popup/popup.html`, { waitUntil: 'load' });

    // Initial counter is 0 IDs
    assert.equal(await popupPage.locator('#idCount').innerText(), '0 IDs');

    // 1. Simulate HTML table paste (e.g. from Excel/Sheets with tabs/cells)
    const tableHtml = `
      <table>
        <tr>
          <td>acc1@gmail.com</td>
          <td>PassGmail1!</td>
          <td>rec1@recovery.com</td>
          <td>JBSWY3DPEHPK3PXP</td>
          <td>socks5://u:p@198.51.100.1:1080</td>
        </tr>
        <tr>
          <td>acc2@outlook.com</td>
          <td>PassOutlook2!</td>
          <td>rec2@recovery.com</td>
          <td>2FASECRETKEY32</td>
          <td>http://proxyuser:proxypass@198.51.100.2:8080</td>
        </tr>
        <tr>
          <td>acc3@yahoo.com</td>
          <td>PassYahoo3!</td>
          <td></td>
          <td></td>
          <td>direct</td>
        </tr>
      </table>
    `;

    await popupPage.evaluate((html) => {
      const box = document.getElementById('loginIds');
      const dt = new DataTransfer();
      dt.setData('text/html', html);
      const pasteEvt = new ClipboardEvent('paste', {
        clipboardData: dt,
        bubbles: true,
        cancelable: true
      });
      box.dispatchEvent(pasteEvt);
    }, tableHtml);

    // 2. Verify #idCount badge updates to '3 IDs'
    await popupPage.waitForFunction(() => document.getElementById('idCount').textContent === '3 IDs');

    // 3. Verify classified segment spans (.gid-email, .gid-password, .gid-recovery, .gid-2fa, .gid-proxy)
    const emails = await popupPage.$$eval('.gid-email', (els) => els.map((e) => e.textContent));
    assert.deepEqual(emails, ['acc1@gmail.com', 'acc2@outlook.com', 'acc3@yahoo.com']);

    const passwords = await popupPage.$$eval('.gid-password', (els) => els.map((e) => e.textContent));
    assert.deepEqual(passwords, ['PassGmail1!', 'PassOutlook2!', 'PassYahoo3!']);

    const recoveries = await popupPage.$$eval('.gid-recovery', (els) => els.map((e) => e.textContent));
    assert.deepEqual(recoveries, ['rec1@recovery.com', 'rec2@recovery.com']);

    const twoFas = await popupPage.$$eval('.gid-2fa', (els) => els.map((e) => e.textContent));
    assert.ok(twoFas.includes('JBSWY3DPEHPK3PXP'));
    assert.ok(twoFas.includes('2FASECRETKEY32'));

    const proxies = await popupPage.$$eval('.gid-proxy', (els) => els.map((e) => e.textContent));
    assert.ok(proxies.some((p) => p.includes('socks5://')));
    assert.ok(proxies.some((p) => p.includes('http://')));

    // 4. Test Error Status Highlighting: fatal error vs action error
    await sw.evaluate(async () => {
      await recordVerificationStatus({
        email: 'acc1@gmail.com',
        statusText: 'Wrong password',
        severity: 'fatal'
      });
      await recordVerificationStatus({
        email: 'acc2@outlook.com',
        statusText: 'Add recovery mail',
        severity: 'action'
      });
    });

    await popupPage.waitForSelector('.gid-err-fatal', { timeout: 5000 });
    const fatalBadge = await popupPage.locator('.gid-err-fatal .error-tag').innerText();
    assert.equal(fatalBadge, 'Wrong password');

    await popupPage.waitForSelector('.gid-err-action', { timeout: 5000 });
    const actionBadge = await popupPage.locator('.gid-err-action .error-tag').innerText();
    assert.equal(actionBadge, 'Add recovery mail');

    // 5. Test direct plain text editing & input events
    await popupPage.evaluate(() => {
      const box = document.getElementById('loginIds');
      box.innerText = 'typed@gmail.com TypedPass1! rec@mail.com\n';
      box.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await popupPage.waitForFunction(() => document.getElementById('idCount').textContent === '1 ID');
    const typedEmail = await popupPage.locator('.gid-email').first().innerText();
    assert.equal(typedEmail, 'typed@gmail.com');
  } finally {
    await context.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── Test 4: Per-account proxy routing and standalone proxy auth via onAuthRequired
test('4. Extension Proxy: Per-account routing and standalone proxy auth via chrome.webRequest.onAuthRequired', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-e2e-proxy-'));
  const profileDir = path.join(tmpDir, 'profile');
  fs.mkdirSync(profileDir, { recursive: true });

  // 1. Target HTTP server returning auth verification
  const targetServer = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, path: req.url, client: req.socket.remoteAddress }));
  });
  await new Promise((r) => targetServer.listen(0, '127.0.0.1', r));
  const targetPort = targetServer.address().port;

  // 2. Start mock HTTP proxy requiring Basic Auth
  const mockProxy = await startMockHttpProxy({
    username: 'authuser123',
    password: 'authpass456',
    hostMap: {
      'proxied-domain.test': `127.0.0.1:${targetPort}`
    }
  });

  const context = await chromium.launchPersistentContext(profileDir, {
    channel: 'chromium',
    headless: true,
    ignoreDefaultArgs: ['--disable-extensions'],
    args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`]
  });

  try {
    let sw = context.serviceWorkers()[0];
    if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 10000 });
    const extId = sw.url().split('/')[2];

    const popupPage = await context.newPage();
    await popupPage.goto(`chrome-extension://${extId}/popup/popup.html`, { waitUntil: 'load' });

    // 3. Set Standalone Proxy via popup UI with username and password
    const proxyInputVal = `http://authuser123:authpass456@127.0.0.1:${mockProxy.port}`;
    await popupPage.fill('#standaloneProxyInput', proxyInputVal);
    await popupPage.click('#applyProxyBtn');

    await popupPage.waitForFunction(() =>
      document.getElementById('popupStatusMsg').textContent.includes('Standalone proxy applied (http)')
    );

    // Verify session storage in service worker has active proxy auth credentials
    const activeAuth = await sw.evaluate(async () => {
      const ses = await (chrome.storage.session ? chrome.storage.session.get(['standaloneProxyAuth']) : chrome.storage.local.get(['standaloneProxyAuth']));
      return ses.standaloneProxyAuth;
    });
    assert.ok(activeAuth, 'standaloneProxyAuth must be stored in session');
    assert.equal(activeAuth.username, 'authuser123');
    assert.equal(activeAuth.password, 'authpass456');

    // 4. Navigate through proxy to target domain: must challenge 407 and be automatically answered by onAuthRequired
    const testPage = await context.newPage();
    const resp = await testPage.goto('http://proxied-domain.test/auth-check', { waitUntil: 'load' });
    assert.equal(resp.status(), 200);
    const body = JSON.parse(await resp.text());
    assert.equal(body.ok, true);
    assert.equal(body.path, '/auth-check');

    // Verify proxy statistics confirm 407 challenge and subsequent authenticated request
    assert.ok(mockProxy.stats.authChallenges > 0, 'Proxy must have issued 407 auth challenge');
    assert.ok(mockProxy.stats.authedRequests > 0, 'Proxy must have received authenticated request');
    assert.ok(mockProxy.stats.requestedHosts.includes('proxied-domain.test'), 'Target domain must be logged in proxy stats');
    await testPage.close();

    // 5. Test Per-Account Proxy configuration in Service Worker
    const s5Server = await startMockSocks5Server({ username: 's5u', password: 's5p' });
    const s5Config = await sw.evaluate(async (port) => {
      return await applyStandaloneProxy(`socks5://s5u:s5p@127.0.0.1:${port}`);
    }, s5Server.port);

    assert.equal(s5Config.scheme, 'socks5');
    assert.equal(s5Config.hasAuth, true);
    assert.equal(s5Config.requiresBridge, true);
    assert.ok(s5Config.warning.includes('SOCKS5'));

    await s5Server.close();

    // 6. Clear Standalone Proxy via popup UI
    await popupPage.fill('#standaloneProxyInput', '');
    await popupPage.click('#applyProxyBtn');
    await popupPage.waitForFunction(() =>
      document.getElementById('popupStatusMsg').textContent.includes('Standalone proxy cleared (direct)')
    );

    const clearedMode = await sw.evaluate(async () => {
      const cur = await new Promise((r) => chrome.proxy.settings.get({ incognito: false }, r));
      return cur.value.mode;
    });
    assert.ok(
      ['direct', 'system'].includes(clearedMode),
      `Proxy mode must revert to direct or system when cleared, got ${clearedMode}`
    );
  } finally {
    await context.close();
    await mockProxy.close();
    await new Promise((r) => targetServer.close(r));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── Test 5: Batch controls (Reorder Tabs, Reload All Tabs, Logout All, Maximize)
test('5. Extension Batch Controls: Reorder tabs, Reload all tabs, Logout all, and individual tab Maximize (⤢)', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-e2e-batch-'));
  const profileDir = path.join(tmpDir, 'profile');
  fs.mkdirSync(profileDir, { recursive: true });

  const context = await chromium.launchPersistentContext(profileDir, {
    channel: 'chromium',
    headless: true,
    ignoreDefaultArgs: ['--disable-extensions'],
    args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`]
  });

  try {
    let sw = context.serviceWorkers()[0];
    if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 10000 });
    const extId = sw.url().split('/')[2];

    // Mock responses for provider mail URLs
    await context.route('https://mail.google.com/**', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: '<!doctype html><html><head><title>Gmail - Inbox (charlie@gmail.com)</title></head><body><h1>Gmail</h1></body></html>'
      });
    });
    await context.route('https://outlook.live.com/**', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: '<!doctype html><html><head><title>Outlook Mail (alice@outlook.com)</title></head><body><h1>Outlook</h1></body></html>'
      });
    });
    await context.route('https://mail.yahoo.com/**', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: '<!doctype html><html><head><title>Yahoo Mail (bob@yahoo.com)</title></head><body><h1>Yahoo</h1></body></html>'
      });
    });
    await context.route('https://accounts.google.com/**', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: '<!doctype html><html><head><title>Google Sign In</title></head><body><h1>Sign In</h1></body></html>'
      });
    });
    await context.route('https://login.live.com/**', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: '<!doctype html><html><head><title>Microsoft Sign In</title></head><body><h1>Sign In</h1></body></html>'
      });
    });
    await context.route('https://login.yahoo.com/**', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: '<!doctype html><html><head><title>Yahoo Sign In</title></head><body><h1>Sign In</h1></body></html>'
      });
    });

    // Seed mock cookies to test Logout All clearing
    await context.addCookies([
      { name: 'SSID', value: 'secret1', domain: '.google.com', path: '/' },
      { name: 'MSID', value: 'secret2', domain: '.live.com', path: '/' },
      { name: 'YSID', value: 'secret3', domain: '.yahoo.com', path: '/' }
    ]);

    // Open mock mail pages
    const pageGmail = await context.newPage();
    await pageGmail.goto('https://mail.google.com/mail/u/0/#inbox', { waitUntil: 'load' });

    const pageOutlook = await context.newPage();
    await pageOutlook.goto('https://outlook.live.com/mail/0/', { waitUntil: 'load' });

    const pageYahoo = await context.newPage();
    await pageYahoo.goto('https://mail.yahoo.com/d/', { waitUntil: 'load' });

    // Open extension popup in standalone window
    const popupPagePromise = context.waitForEvent('page');
    await sw.evaluate(async (url) => {
      await chrome.windows.create({ url, type: 'popup', width: 780, height: 680, focused: true });
    }, `chrome-extension://${extId}/popup/popup.html`);
    const popupPage = await popupPagePromise;
    await popupPage.waitForLoadState('load');

    // Refresh tabs list
    await popupPage.click('#openExistingBtn');
    await popupPage.waitForFunction(() => document.querySelectorAll('#tabList .tab-row').length >= 3);

    const initialRows = await popupPage.locator('#tabList .tab-row').count();
    assert.ok(initialRows >= 3, `Expected at least 3 tab rows, got ${initialRows}`);

    // Verify provider badges ('M', 'O', 'Y')
    const badges = await popupPage.$$eval('#tabList .tab-badge', (els) => els.map((e) => e.textContent));
    assert.ok(badges.includes('M'), 'Gmail badge M must be present');
    assert.ok(badges.includes('O'), 'Outlook badge O must be present');
    assert.ok(badges.includes('Y'), 'Yahoo badge Y must be present');

    // 1. Test Individual Tab Maximize (⤢)
    const maxBtn = popupPage.locator('#tabList .tab-row button[title="Maximize tab window"]').first();
    await maxBtn.click();
    // Allow window update to process
    await new Promise((r) => setTimeout(r, 400));
    const winStates = await sw.evaluate(async () => {
      const wins = await chrome.windows.getAll();
      return wins.map((w) => w.state);
    });
    assert.ok(winStates.includes('maximized'), 'One of the windows must be maximized');

    // 2. Test 'Reorder Tabs' button
    await popupPage.click('#reorderTabsBtn');
    const reorderRes = await popupPage.evaluate(async () => {
      return await chrome.runtime.sendMessage({ action: 'REORDER_TABS', screenWidth: 1440, screenHeight: 900 });
    });
    assert.equal(reorderRes.ok, true);
    assert.ok(reorderRes.reordered >= 3, 'Reordered count must be at least 3');

    // 3. Test 'Reload All Tabs' button
    let reloadsTriggered = 0;
    pageGmail.on('load', () => { reloadsTriggered += 1; });
    await popupPage.click('#reloadTabsBtn');
    const reloadRes = await popupPage.evaluate(async () => {
      return await chrome.runtime.sendMessage({ action: 'RELOAD_ALL_TABS' });
    });
    assert.equal(reloadRes.ok, true);
    assert.ok(reloadRes.reloaded >= 3);

    // 4. Test 'Logout All' button
    await popupPage.click('#logoutAllBtn');
    await popupPage.waitForTimeout(600);

    // Verify mail tabs redirected to their login pages
    const gmailUrl = pageGmail.url();
    const outlookUrl = pageOutlook.url();
    const yahooUrl = pageYahoo.url();

    assert.ok(gmailUrl.includes('accounts.google.com'), `Gmail tab must redirect to accounts.google.com, got ${gmailUrl}`);
    assert.ok(outlookUrl.includes('login.live.com'), `Outlook tab must redirect to login.live.com, got ${outlookUrl}`);
    assert.ok(yahooUrl.includes('login.yahoo.com'), `Yahoo tab must redirect to login.yahoo.com, got ${yahooUrl}`);

    // Verify cookies were removed
    const remainingCookies = await context.cookies();
    assert.equal(
      remainingCookies.filter((c) => /google\.com|live\.com|yahoo\.com/.test(c.domain)).length,
      0,
      'Provider authentication cookies must be cleared on logout'
    );
  } finally {
    await context.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── Test 6: Real-time PING_TABS handshake and dynamic quota chip updates ─────
test('6. Real-Time Extension Handshake: PING_TABS handshake and dynamic quota chip updates', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-e2e-handshake-'));
  const profileDir = path.join(tmpDir, 'profile');
  fs.mkdirSync(profileDir, { recursive: true });

  const app = createServer({
    port: 0,
    dataDir: path.join(tmpDir, 'data'),
    profilesRoot: path.join(tmpDir, 'profiles')
  });
  const addr = await app.start(0, '127.0.0.1');
  const wsUrl = `ws://127.0.0.1:${addr.port}`;

  const context = await chromium.launchPersistentContext(profileDir, {
    channel: 'chromium',
    headless: true,
    ignoreDefaultArgs: ['--disable-extensions'],
    args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`]
  });

  try {
    let sw = context.serviceWorkers()[0];
    if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 10000 });
    const extId = sw.url().split('/')[2];

    // Connect extension service worker to Controller WS URL
    await sw.evaluate(async (url) => {
      await chrome.storage.local.set({ wsUrl: url });
      await connectWebSocket(url);
    }, wsUrl);

    // Wait for WS to be connected in service worker
    for (let i = 0; i < 30; i++) {
      const isConnected = await sw.evaluate(() => Boolean(ws && ws.readyState === WebSocket.OPEN));
      if (isConnected) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const swConnected = await sw.evaluate(() => Boolean(ws && ws.readyState === WebSocket.OPEN));
    assert.equal(swConnected, true, 'Extension service worker must connect to Controller WebSocket');

    // Authenticate dashboard user
    const auth = app.store.authenticate('admfib7H', 'd9tQGJdZ77');
    const sid = auth.session.token || auth.session.id;

    // Open Web Dashboard in browser context
    await context.addCookies([
      { name: 'relay_sid', value: sid, domain: '127.0.0.1', path: '/' }
    ]);
    const dashPage = await context.newPage();
    await dashPage.goto(`http://127.0.0.1:${addr.port}/V3/`, { waitUntil: 'load' });

    // Initial quota chips on dashboard
    await dashPage.waitForSelector('#metricLimit');
    const initLimit = await dashPage.locator('#metricLimit').innerText();
    const initSent = await dashPage.locator('#metricSent').innerText();
    assert.equal(initLimit, '60000');
    assert.equal(initSent, '0 / 60000');

    // Verify initial actionStatusChip state
    await dashPage.waitForSelector('#actionStatusChip');

    // 1. Test PING_TABS Handshake via Dashboard WebSocket broadcast
    const dashWs = await connectRawWs(addr.port, '/ws/dashboard', {
      Cookie: `relay_sid=${sid}`
    });
    await dashWs.nextMessage((m) => m.type === 'HELLO' || m.type === 'DASHBOARD_SYNC');

    // Open a mock mail page in browser context so extension discovers it
    await context.route('https://mail.google.com/**', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: '<!doctype html><html><head><title>Gmail - Inbox (live.discovered@gmail.com)</title></head><body><h1>Discovered Tab</h1></body></html>'
      });
    });
    const discoveredTab = await context.newPage();
    await discoveredTab.goto('https://mail.google.com/mail/u/0/#inbox', { waitUntil: 'load' });

    // Dashboard broadcasts PING_TABS request
    dashWs.sendJson({ type: 'PING_TABS' });

    // Extension SW responds with PONG_TABS, which wsHub processes into onlineTabs
    for (let i = 0; i < 40; i++) {
      const tabs = app.store.listOnlineTabs();
      if (tabs.length > 0) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const onlineTabs = app.store.listOnlineTabs();
    assert.ok(onlineTabs.length > 0, 'Online tabs must be registered following PONG_TABS handshake');
    assert.ok(
      onlineTabs.some((t) => t.email.includes('live.discovered@gmail.com') || t.provider === 'gmail'),
      'Discovered tab must be registered in store'
    );

    // Dashboard transitions from "Waiting for tabs..." to "Ready · N tabs online"
    await dashPage.waitForFunction(() => {
      const chip = document.getElementById('actionStatusChip');
      return chip && chip.classList.contains('is-ready');
    }, null, { timeout: 10000 });
    const actionLabel = await dashPage.locator('#actionStatusChip').innerText();
    assert.match(actionLabel, /Ready/i);

    // 2. Dynamic Quota Chip Updates
    // Update store shootQuota and broadcast to dashboard
    app.store.state.shootQuota.sentToday = 42;
    app.store.state.shootQuota.dailyLimit = 50000;
    app.store.state.shootQuota.expiryHours = 2;

    app.wsHub.broadcastDashboards({
      type: 'STATUS_UPDATE',
      shootState: app.store.state.shootState,
      shootQuota: app.store.state.shootQuota
    });

    // Check that dashboard metric chips updated dynamically without page reload
    await dashPage.waitForFunction(() => {
      const sentEl = document.getElementById('metricSent');
      return sentEl && sentEl.textContent === '42 / 50000';
    });
    const updatedLimit = await dashPage.locator('#metricLimit').innerText();
    const updatedSent = await dashPage.locator('#metricSent').innerText();

    assert.equal(updatedLimit, '50000');
    assert.equal(updatedSent, '42 / 50000');

    // 3. Test Quota Exhaustion visually triggers is-limit-reached
    app.store.state.shootQuota.sentToday = 50000;
    app.wsHub.broadcastDashboards({
      type: 'STATUS_UPDATE',
      shootState: app.store.state.shootState,
      shootQuota: app.store.state.shootQuota
    });
    await dashPage.waitForFunction(() => {
      const btn = document.getElementById('sendButton');
      return btn && btn.classList.contains('is-limit-reached');
    });

    // 4. Verify Extension Popup WS Status Chip reflects 'Active'
    const popupPage = await context.newPage();
    await popupPage.goto(`chrome-extension://${extId}/popup/popup.html`, { waitUntil: 'load' });
    await popupPage.waitForFunction(() => {
      const chip = document.getElementById('wsChip');
      return chip && chip.textContent.includes('Active');
    });
    const chipText = await popupPage.locator('#wsChip').innerText();
    assert.match(chipText, /Active/);

    dashWs.close();
  } finally {
    await context.close();
    await app.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
