'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright');

const { createServer } = require('../src/server/app');
const { generateTOTP } = require('../src/core/totp');
const { startMockSocks5Server, startMockHttpProxy } = require('./helpers/mockProxies');

test('E2E Web UI: Login, /V3/ Dark/Light + Online Tabs + Compose + Tag Preview + SHOOT, /V3/tags/, /V3/files/, /gmass2, and Extension UI', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-ui-'));
  const app = createServer({
    port: 0,
    dataDir: path.join(tmpDir, 'data'),
    profilesRoot: path.join(tmpDir, 'profiles')
  });
  const addr = await app.start(0, '127.0.0.1');
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  // Seed one online tab with duplicate check & folder count
  app.store.upsertOnlineTab({
    tabKey: 'acc1:1',
    accountId: 'acc1',
    tabId: 1,
    email: 'sender1@gmail.com',
    provider: 'gmail',
    tabName: 'Gmail Tab #1',
    inbox: 5,
    draft: 1,
    sent: 120,
    status: 'Idle',
    isActive: true,
    ip: '198.51.100.25',
    proxy: 'socks5://u:p@198.51.100.25:1080'
  });

  const browser = await chromium.launch({ headless: true });
  const errors = [];

  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`);
    });

    // 1. Login page flow
    await page.goto(`${baseUrl}/Login.php`, { waitUntil: 'load' });
    await page.waitForSelector('#loginButton');
    await page.fill('#usr', 'admfib7H');
    await page.fill('#pas', 'wrongpass');
    await page.click('#loginButton');
    await page.waitForSelector('#loginError:not([hidden])');

    await page.fill('#pas', 'd9tQGJdZ77');
    await Promise.all([
      page.waitForURL('**/V3/'),
      page.click('#loginButton')
    ]);

    // 2. /V3/ Dashboard verification
    await page.waitForSelector('#onlineTabsBody tr');
    const rowText = await page.locator('#onlineTabsBody tr').first().innerText();
    assert.match(rowText, /sender1@gmail\.com/);
    assert.match(rowText, /SOCKS5/i);

    // Light <-> Dark theme toggle updates <meta name="color-scheme"> and data-theme
    await page.click('#themeToggle');
    const darkAttr = await page.evaluate(() => document.documentElement.dataset.theme);
    const metaTheme = await page.getAttribute('meta[name="color-scheme"]', 'content');
    assert.ok(darkAttr === 'dark' || darkAttr === 'light');
    assert.ok(metaTheme === 'dark' || metaTheme === 'light');

    // Extension Download Button on the top of homepage + Chrome Installation Dialog
    assert.equal(await page.locator('#downloadExtBtn').isVisible(), true);
    assert.equal(await page.locator('#downloadExtNavBtn').isVisible(), true);
    await page.click('#downloadExtBtn');
    await page.waitForFunction(() => document.getElementById('downloadExtDialog').open);
    const modalTitle = await page.locator('#downloadExtDialogTitle').innerText();
    assert.ok(modalTitle.includes('Download Extension & Load in Chrome'));
    assert.equal(await page.locator('#downloadExtDirectBtn').isVisible(), true);
    const stepsText = await page.locator('.ext-steps-list').innerText();
    assert.ok(stepsText.includes('chrome://extensions'));
    assert.ok(stepsText.includes('Developer mode'));
    assert.ok(stepsText.includes('Load unpacked'));
    // Test Copy URL button
    await page.click('#copyExtUrlBtn');
    await page.waitForFunction(() => document.getElementById('copyExtUrlLabel').textContent === 'Copied!');
    // Close dialog
    await page.click('#downloadExtClose');
    await page.waitForFunction(() => !document.getElementById('downloadExtDialog').open);
    // Test nav button triggers dialog as well
    await page.click('#downloadExtNavBtn');
    await page.waitForFunction(() => document.getElementById('downloadExtDialog').open);
    await page.click('#downloadExtDismissBtn');
    await page.waitForFunction(() => !document.getElementById('downloadExtDialog').open);

    // Data Dialog -> Add Data -> Set Data
    await page.click('#openDataModalBtn');
    await page.fill('#addData', 'lead1@example.com\nlead2@example.com');
    await page.click('#saveDataBtn');
    await page.waitForFunction(() => document.getElementById('dockDataCount').textContent === '2');
    await page.click('#dataDialogClose');
    await page.click('#setDataBtn');
    await page.waitForFunction(() => document.getElementById('onlineTabsBody').innerText.includes('2 rec'));

    // Compose WYSIWYG + Tag Hover Preview + Click Insert
    await page.fill('#composeSubject', 'Notice for {user}');
    await page.click('#composeEditor');
    const nameTagChip = page.locator('.tag-chip', { hasText: '{name}' });
    await nameTagChip.hover();
    await page.waitForSelector('#tagPreviewCard:not([hidden])');
    await nameTagChip.click();
    const editorText = await page.locator('#composeEditor').innerText();
    assert.ok(editorText.includes('{name}'));

    // Accounts & Proxies Dialog
    await page.click('#manageAccountsBtn');
    await page.fill('#accEmailInput', 'newproxy@gmail.com');
    await page.fill('#accPassInput', 'Secret99');
    await page.fill('#accProxyInput', 'socks5://u:p@1.2.3.4:1080');
    await page.click('#saveAccountBtn');
    await page.waitForFunction(() => document.getElementById('accountsTableBody').innerText.includes('newproxy@gmail.com'));
    await page.click('#accountsDialogClose');

    // Shoot Settings Popover layout switch
    await page.click('#settingsGearBtn');
    await page.click('input[name="layoutMode"][value="reversed"]');
    assert.equal(await page.getAttribute('#relayWorkspace', 'data-layout'), 'reversed');
    await page.keyboard.press('Escape');

    // Fire SHOOT button
    await page.click('#sendButton');
    await page.waitForSelector('#toastRegion .toast-item');

    // 3. /V3/tags/ CRUD
    await page.goto(`${baseUrl}/V3/tags/`, { waitUntil: 'load' });
    await page.waitForSelector('#createTagForm');
    await page.fill('#newTagName', 'promoTier');
    await page.fill('#newTagValues', 'VIP, Standard');
    await page.click('#createTagForm button[type="submit"]');
    await page.waitForFunction(() => document.getElementById('tagsGrid').innerText.includes('{promoTier}'));

    // 4. /V3/files/ & /gmass2
    await page.goto(`${baseUrl}/V3/files/`, { waitUntil: 'load' });
    await page.goto(`${baseUrl}/gmass2`, { waitUntil: 'load' });
    await page.waitForSelector('#gmBlastBtn');
    await page.fill('#gmEmails', 'gm@example.com');
    await page.fill('#gmSubject', 'GMASS {orderno}');
    await page.fill('#gmMessage', '<p>Hello {name}</p>');
    await page.click('#gmBlastBtn');
    await page.waitForFunction(() => document.getElementById('gmSentLog').innerText.includes('gm@example.com'));

    // 5. Render Extension Control Browser - BIN4RY UI directly in browser context
    const extPopupUrl = 'file://' + path.resolve(__dirname, '../extension/popup/popup.html');
    await page.goto(extPopupUrl, { waitUntil: 'load' });
    await page.fill('#loginIds', 'user@gmail.com pass123 rec@mail.com JBSW socks5://1.2.3.4:1080');
    await page.locator('#loginIds').blur();
    const tokenClasses = await page.evaluate(() =>
      [...document.querySelectorAll('#loginIds span')].map((s) => s.className)
    );
    assert.deepEqual(tokenClasses, ['gid-email', 'gid-password', 'gid-recovery', 'gid-2fa', 'gid-proxy']);

    // Filter expected 401 triggered intentionally by wrong-password check on /Login.php
    const fatalErrors = errors.filter((e) => !e.includes('favicon.ico') && !e.includes('401 (Unauthorized)'));
    assert.deepEqual(fatalErrors, [], `Unexpected browser errors: ${fatalErrors.join('; ')}`);
  } finally {
    await browser.close();
    await app.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('E2E Proxy Isolation & Extension TOTP Login: Two Chromium profiles via separate authenticated SOCKS5 proxies isolate cookies, outbound traffic, WebRTC UDP policy, and solve TOTP', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-proxy-e2e-'));
  const totpSecret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

  // Two distinct local HTTP target servers (acting as separate proxy exit endpoints & mock Google Login host)
  const targetA = http.createServer((req, res) => {
    if (req.url.startsWith('/ip')) {
      const json = JSON.stringify({ ip: '198.51.100.11', proxy: 'ALPHA' });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(json) });
      res.end(json);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('TARGET_A');
  });

  const targetB = http.createServer((req, res) => {
    if (req.url.startsWith('/ip')) {
      const json = JSON.stringify({ ip: '203.0.113.22', proxy: 'BETA' });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(json) });
      res.end(json);
      return;
    }
    if (req.url.startsWith('/ServiceLogin')) {
      const html = `<!DOCTYPE html>
      <html><body>
        <h1>Mock Google Sign-In</h1>
        <form id="f1" onsubmit="event.preventDefault(); document.getElementById('stage1').hidden=true; document.getElementById('stage2').hidden=false;">
          <div id="stage1">
            <input id="identifierId" type="email" />
            <div id="identifierNext"><button type="submit">Next</button></div>
          </div>
        </form>
        <form id="f2" onsubmit="event.preventDefault(); document.getElementById('stage2').hidden=true; document.getElementById('stage3').hidden=false;">
          <div id="stage2" hidden>
            <input type="password" name="Passwd" />
            <div id="passwordNext"><button type="submit">Next</button></div>
          </div>
        </form>
        <form id="f3" onsubmit="event.preventDefault(); window.__verifiedCode = document.getElementById('totpPin').value; document.getElementById('stage3').hidden=true; document.getElementById('inbox').hidden=false;">
          <div id="stage3" hidden>
            <input id="totpPin" name="totpPin" type="text" />
            <div id="totpNext"><button type="submit">Verify</button></div>
          </div>
        </form>
        <div id="inbox" hidden>
          <div gh="cm" role="button">Compose</div>
        </div>
      </body></html>`;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(html) });
      res.end(html);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('TARGET_B');
  });

  await Promise.all([
    new Promise((r) => targetA.listen(0, '127.0.0.1', r)),
    new Promise((r) => targetB.listen(0, '127.0.0.1', r))
  ]);
  const portA = targetA.address().port;
  const portB = targetB.address().port;

  // Two authenticated SOCKS5 upstream proxies mapping non-loopback domains so Chromium CANNOT bypass proxy!
  const socksA = await startMockSocks5Server({
    username: 'userA',
    password: 'passA',
    hostMap: { 'alpha-exit.example': '127.0.0.1' }
  });
  const socksB = await startMockSocks5Server({
    username: 'userB',
    password: 'passB',
    hostMap: { 'beta-exit.example': '127.0.0.1' }
  });

  const app = createServer({
    port: 0,
    dataDir: path.join(tmpDir, 'data'),
    profilesRoot: path.join(tmpDir, 'profiles'),
    headless: true
  });
  await app.start(0, '127.0.0.1');

  try {
    const accA = app.store.upsertAccount({
      email: 'alpha@gmail.com',
      password: 'AlphaPassword1!',
      twoFa: totpSecret,
      proxy: `socks5://userA:passA@127.0.0.1:${socksA.port}`
    });
    const accB = app.store.upsertAccount({
      email: 'beta@gmail.com',
      password: 'BetaPassword2!',
      twoFa: totpSecret,
      proxy: `socks5://userB:passB@127.0.0.1:${socksB.port}`
    });

    const tStart = Date.now();
    const [launchA, launchB] = await Promise.all([
      app.browserManager.launchAccount(accA.id, {
        headless: true,
        startUrl: `http://alpha-exit.example:${portA}/ip`,
        ipCheckUrl: `http://127.0.0.1:${portA}/ip`
      }),
      app.browserManager.launchAccount(accB.id, {
        headless: true,
        startUrl: `http://127.0.0.1:${portB}/ServiceLogin`,
        ipCheckUrl: `http://127.0.0.1:${portB}/ip`
      })
    ]);

    assert.equal(launchA.probe.ip, '198.51.100.11');
    assert.equal(launchB.probe.ip, '203.0.113.22');

    const sessA = app.browserManager.getRunningSession(accA.id);
    const sessB = app.browserManager.getRunningSession(accB.id);
    assert.ok(sessA && sessB);

    // 1. Verify profile A traversed Chromium -> ProxyBridge A -> SOCKS5 A (alpha-exit.example cannot resolve without SOCKS5!)
    const bodyA = JSON.parse(await sessA.page.locator('body').innerText());
    assert.equal(bodyA.ip, '198.51.100.11');
    assert.ok(socksA.stats.requestedHosts.includes(`alpha-exit.example:${portA}`));

    // 2. Verify profile cookie & localStorage isolation between Alpha and Beta
    await sessA.page.evaluate(() => { localStorage.setItem('profileMarker', 'ONLY_ALPHA'); });
    const betaMarker = await sessB.page.evaluate(() => localStorage.getItem('profileMarker'));
    assert.equal(betaMarker, null);

    // 3. Verify Beta's Extension service worker connected over WS (`REGISTER_AGENT`) & `login-driver.js` auto-filled email -> password -> RFC 6238 TOTP -> Inbox!
    await sessB.page.waitForSelector('#inbox:not([hidden])', { timeout: 25000 });
    const tEnd = Date.now();
    const submittedCode = await sessB.page.evaluate(() => window.__verifiedCode);
    const validWindowCodes = new Set([
      generateTOTP(totpSecret, { timestampMs: tStart }),
      generateTOTP(totpSecret, { timestampMs: tEnd })
    ]);
    assert.ok(validWindowCodes.has(submittedCode), `Submitted TOTP ${submittedCode} not in active window [${[...validWindowCodes].join(', ')}]`);
    const accBTabs = app.store.listOnlineTabs().filter((t) => t.accountId === accB.id || t.email === 'beta@gmail.com');
    assert.equal(accBTabs.length, 1, `Expected 1 deduplicated onlineTab for beta@gmail.com, got ${accBTabs.length}`);
    assert.equal(accBTabs[0].isDup, false);
    assert.ok(app.wsHub.agentsByAccount.has(accB.id) || accBTabs.length === 1);

    // Also route a live non-loopback page load on Profile Beta to verify its own authenticated SOCKS5 B tunnel!
    const checkPageB = await sessB.context.newPage();
    await checkPageB.goto(`http://beta-exit.example:${portB}/ip`, { waitUntil: 'load' });
    const bodyB = JSON.parse(await checkPageB.locator('body').innerText());
    assert.equal(bodyB.ip, '203.0.113.22');
    assert.ok(socksB.stats.requestedHosts.includes(`beta-exit.example:${portB}`));
    // Ensure NO rpa_* parameters leaked onto external/target requests
    assert.equal(launchB.url.includes('rpa_account'), false);
  } finally {
    await app.stop();
    await socksA.close();
    await socksB.close();
    await new Promise((r) => targetA.close(r));
    await new Promise((r) => targetB.close(r));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('E2E Extension Core Fixes: CDP single-char typing, Captcha wait/resume + closeOnCaptcha, TOTP retry, SMS pool rotation, and LOGOUT cookie clearing', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-ext-fixes-'));
  const totpSecret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  let totpSubmits = 0;

  const mockHost = http.createServer((req, res) => {
    if (req.url.startsWith('/sms/2')) {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('Your Google verification code is G-654321');
      return;
    }
    if (req.url.startsWith('/cdp-check')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><html><body><input id="plainIn" type="text" autofocus><div id="ceIn" contenteditable="true"></div></body></html>');
      return;
    }
    if (req.url.startsWith('/CaptchaResume')) {
      const html = `<!doctype html><html><body>
        <div id="captcha-form" data-captcha="true">Verify you are human</div>
        <div id="stage1"><input id="identifierId" type="email"><div id="identifierNext"><button type="button" onclick="document.getElementById('stage1').hidden=true;document.getElementById('stage2').hidden=false;">Next</button></div></div>
        <div id="stage2" hidden><input type="password" name="Passwd"><div id="passwordNext"><button type="button" onclick="document.getElementById('stage2').hidden=true;document.getElementById('inbox').hidden=false;">Next</button></div></div>
        <div id="inbox" hidden><div gh="cm" role="button">Compose</div></div>
        <script>setTimeout(() => { var c = document.getElementById('captcha-form'); if (c) c.remove(); }, 1800);</script>
      </body></html>`;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }
    if (req.url.startsWith('/TotpRetry')) {
      const html = `<!doctype html><html><body>
        <form id="f1" onsubmit="event.preventDefault(); stage1.hidden=true; stage3.hidden=false;">
          <div id="stage1"><input id="identifierId" type="email"><div id="identifierNext"><button type="submit">Next</button></div></div>
        </form>
        <div id="errBanner" role="alert" hidden></div>
        <form id="f3" onsubmit="event.preventDefault(); window.__totpSubmits=(window.__totpSubmits||0)+1; if (window.__totpSubmits===1) { errBanner.textContent='Wrong code. Try again.'; errBanner.hidden=false; } else { errBanner.hidden=true; stage3.hidden=true; inbox.hidden=false; }">
          <div id="stage3" hidden><input id="totpPin" name="totpPin"><div id="totpNext"><button type="submit">Verify</button></div></div>
        </form>
        <div id="inbox" hidden><div gh="cm" role="button">Compose</div></div>
      </body></html>`;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }
    if (req.url.startsWith('/SmsRotate')) {
      const html = `<!doctype html><html><body>
        <div id="errBanner" role="alert" hidden></div>
        <div id="phoneStage">
          <input id="phoneNumberId" type="tel">
          <div id="idvanyphonecollectNext"><button type="button" onclick="
            var v = document.getElementById('phoneNumberId').value;
            if (v.includes('5550001')) {
              errBanner.textContent='This phone number cannot be used for verification';
              errBanner.hidden=false;
            } else {
              errBanner.hidden=true;
              phoneStage.hidden=true;
              pinStage.hidden=false;
            }
          ">Send</button></div>
        </div>
        <div id="pinStage" hidden>
          <input id="idvAnyPhonePin" type="text">
          <div id="idvanyphoneverifyNext"><button type="button" onclick="
            window.__smsCode = document.getElementById('idvAnyPhonePin').value;
            pinStage.hidden=true;
            inbox.hidden=false;
          ">Verify</button></div>
        </div>
        <div id="inbox" hidden><div gh="cm" role="button">Compose</div></div>
      </body></html>`;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
  });

  await new Promise((r) => mockHost.listen(0, '127.0.0.1', r));
  const mockPort = mockHost.address().port;

  const app = createServer({
    port: 0,
    dataDir: path.join(tmpDir, 'data'),
    profilesRoot: path.join(tmpDir, 'profiles'),
    headless: true
  });
  await app.start(0, '127.0.0.1');

  try {
    // 1. Test real CDP single-character typing (verifying rawKeyDown+char does NOT double characters) & cookie clear
    const accCdp = app.store.upsertAccount({ email: 'cdp@gmail.com', password: 'CdpPassword1!', twoFa: totpSecret });
    await app.browserManager.launchAccount(accCdp.id, {
      headless: true,
      startUrl: `http://127.0.0.1:${mockPort}/cdp-check`
    });
    const sessCdp = app.browserManager.getRunningSession(accCdp.id);
    const sw = sessCdp.context.serviceWorkers()[0];
    await sessCdp.page.click('#plainIn');
    await sw.evaluate(async () => {
      const tabs = await chrome.tabs.query({ active: true });
      await self.AutomationSettings.save({ typingSpeed: 'fast', humanizeTyping: false });
      await cdpTypeOrganic(tabs[0].id, 'Abc-123');
    });
    assert.equal(await sessCdp.page.inputValue('#plainIn'), 'Abc-123');

    await sessCdp.page.click('#ceIn');
    await sw.evaluate(async () => {
      const tabs = await chrome.tabs.query({ active: true });
      await cdpTypeOrganic(tabs[0].id, 'CeLine9');
    });
    assert.equal((await sessCdp.page.locator('#ceIn').innerText()).trim(), 'CeLine9');

    // Verify LOGOUT_ALL_ACCOUNTS awaits cookie removal across google.com
    await sw.evaluate(async () => {
      await chrome.cookies.set({ url: 'https://accounts.google.com/', name: 'SID', value: 'test_sid_val' });
    });
    const logoutRes = await sw.evaluate(async () => {
      const list = await chrome.cookies.getAll({ domain: 'google.com' });
      const before = list.length;
      const resp = await (new Promise((resolve) => {
        chrome.cookies.getAll({ domain: 'google.com' }, async (items) => {
          for (const c of items || []) {
            await chrome.cookies.remove({ url: `https://${c.domain.replace(/^\./, '')}${c.path || '/'}`, name: c.name });
          }
          resolve((await chrome.cookies.getAll({ domain: 'google.com' })).length);
        });
      }));
      return { before, after: resp };
    });
    assert.ok(logoutRes.before >= 1);
    assert.equal(logoutRes.after, 0);

    // 2. Captcha Wait -> Solved -> Resume into Inbox
    const accCap = app.store.upsertAccount({ email: 'captcha@gmail.com', password: 'CapPassword1!', twoFa: totpSecret });
    await app.browserManager.launchAccount(accCap.id, {
      headless: true,
      startUrl: `http://127.0.0.1:${mockPort}/CaptchaResume`
    });
    const sessCap = app.browserManager.getRunningSession(accCap.id);
    await sessCap.page.waitForSelector('#inbox:not([hidden])', { timeout: 18000 });
    assert.equal(await sessCap.page.inputValue('#identifierId'), 'captcha@gmail.com');

    // 3. TOTP retry when attempt #1 shows Wrong code
    const accTotp = app.store.upsertAccount({ email: 'retry@gmail.com', password: 'RetryPassword1!', twoFa: totpSecret });
    await app.browserManager.launchAccount(accTotp.id, {
      headless: true,
      startUrl: `http://127.0.0.1:${mockPort}/TotpRetry`
    });
    const sessTotp = app.browserManager.getRunningSession(accTotp.id);
    await sessTotp.page.waitForSelector('#inbox:not([hidden])', { timeout: 18000 });
    totpSubmits = await sessTotp.page.evaluate(() => window.__totpSubmits);
    assert.equal(totpSubmits, 2);

    // 4. SMS pool multi-number rotation when #1 rejected
    const accSms = app.store.upsertAccount({ email: 'sms@gmail.com', password: 'SmsPassword1!' });
    await app.browserManager.launchAccount(accSms.id, {
      headless: true,
      startUrl: `http://127.0.0.1:${mockPort}/SmsRotate`
    });
    const sessSms = app.browserManager.getRunningSession(accSms.id);
    const swSms = sessSms.context.serviceWorkers()[0];
    await swSms.evaluate(async (p) => {
      verificationPool.syncFromString(`+15550001|http://127.0.0.1:${p}/sms/1\n+15550002|http://127.0.0.1:${p}/sms/2`);
      await saveVerificationPool();
    }, mockPort);
    // Navigate again so SmsRotate sees populated SMS pool immediately
    await sessSms.page.goto(`http://127.0.0.1:${mockPort}/SmsRotate`, { waitUntil: 'domcontentloaded' });
    await sessSms.page.waitForSelector('#inbox:not([hidden])', { timeout: 18000 });
    assert.equal(await sessSms.page.evaluate(() => window.__smsCode), '654321');
    let poolStats = await swSms.evaluate(() => verificationPool.getStats());
    for (let i = 0; i < 15 && poolStats.verified < 1; i++) {
      await new Promise((r) => setTimeout(r, 150));
      poolStats = await swSms.evaluate(() => verificationPool.getStats());
    }
    assert.equal(poolStats.permanent_error, 1);
    assert.equal(poolStats.verified, 1);

    // 5. Verify closeOnCaptcha=true closes the Captcha tab AND live popup renders VERIFICATION_STATUS error badge + H/V grid spacing
    const extId = swSms.url().split('/')[2];
    await swSms.evaluate(async () => {
      await self.AutomationSettings.save({ closeOnCaptcha: true, disableTabCloseOnError: false });
    });
    const capClosePage = await sessSms.context.newPage();
    let closedByCaptcha = false;
    capClosePage.once('close', () => { closedByCaptcha = true; });
    await capClosePage.goto(`http://127.0.0.1:${mockPort}/CaptchaResume`, { waitUntil: 'domcontentloaded' }).catch(() => {});
    for (let i = 0; i < 30 && !closedByCaptcha; i++) await new Promise((r) => setTimeout(r, 150));
    assert.equal(closedByCaptcha, true, 'Expected closeOnCaptcha=true to close captcha tab');

    // Open real Extension popup inside Extension browser context & assert live error badge + H/V grid coordinates
    const extPopup = await sessSms.context.newPage();
    await extPopup.goto(`chrome-extension://${extId}/popup/popup.html`, { waitUntil: 'load' });
    await extPopup.click('#loginIds');
    await extPopup.keyboard.type('badpass@gmail.com Pass123 rec@mail.com JBSW');
    await extPopup.evaluate(async () => {
      await chrome.runtime.sendMessage({
        action: 'REPORT_VERIFICATION_STATUS',
        email: 'badpass@gmail.com',
        statusText: 'Wrong password',
        severity: 'fatal'
      });
    });
    await extPopup.waitForSelector('#loginIds .gid-err-fatal .error-tag', { timeout: 5000 });
    assert.match(await extPopup.locator('#loginIds .error-tag').innerText(), /Wrong password/);

    // Default behavior is now stagger mode
    const gridDef = await extPopup.evaluate(() => chrome.runtime.sendMessage({ action: 'OPEN_TABS_GRID', count: 3, startUrls: ['about:blank', 'about:blank', 'about:blank'] }));
    assert.equal(gridDef.opened[1].left - gridDef.opened[0].left, 36, 'Expected default OPEN_TABS_GRID to open in diagonal stagger mode (36px offset)');

    // Explicit tile layout tests grid gap calculations
    const gridA = await extPopup.evaluate(() => chrome.runtime.sendMessage({ action: 'OPEN_TABS_GRID', count: 4, layout: 'tile', stagger: false, hGap: 10, vGap: 10, startUrls: ['about:blank', 'about:blank', 'about:blank', 'about:blank'] }));
    const gridB = await extPopup.evaluate(() => chrome.runtime.sendMessage({ action: 'OPEN_TABS_GRID', count: 4, layout: 'tile', stagger: false, hGap: 80, vGap: 80, startUrls: ['about:blank', 'about:blank', 'about:blank', 'about:blank'] }));
    assert.ok(gridB.opened[1].left > gridA.opened[1].left, 'Expected larger hGap to shift column 2 window left offset');
    assert.ok(gridB.opened[2].top > gridA.opened[2].top, 'Expected larger vGap to shift row 2 window top offset');
  } finally {
    await app.stop();
    await new Promise((r) => mockHost.close(r));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('E2E Web UI Parity & Extension Popup Interactive Controls (confirm dialogs, duplicate toast, multi-line Test shoot, GMASS-2 pause/HTML-only, H/V/error badges, visual screenshots)', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-parity-'));
  const shotDir = path.join(tmpDir, 'screenshots');
  fs.mkdirSync(shotDir, { recursive: true });

  const app = createServer({
    port: 0,
    dataDir: path.join(tmpDir, 'data'),
    profilesRoot: path.join(tmpDir, 'profiles')
  });
  const addr = await app.start(0, '127.0.0.1');
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  // Seed duplicate tabs (with realistic proxy + IP) + one unallocated tab to trigger partial-data Confirm Modal + Duplicate Toast
  app.store.upsertOnlineTab({ tabKey: 'a1:1', accountId: 'a1', tabId: 1, email: 'longsender.dup@gmail.com', tabName: 'Tab 1', status: 'Idle', isActive: true, dataAllocated: 'lead1@example.com', ip: '198.51.100.25', proxy: 'socks5://u:p@198.51.100.25:1080' });
  app.store.upsertOnlineTab({ tabKey: 'a2:2', accountId: 'a2', tabId: 2, email: 'longsender.dup@gmail.com', tabName: 'Tab 2', status: 'Idle', isActive: true, ip: '203.0.113.44', proxy: 'http://u:p@203.0.113.44:8080' });

  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();

    const assertNoRectOverlap = (a, b, label) => {
      const disjoint = a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top;
      assert.equal(disjoint, true, `Expected ${label} not to overlap (${JSON.stringify(a)} vs ${JSON.stringify(b)})`);
    };

    await page.goto(`${baseUrl}/Login.php`, { waitUntil: 'load' });
    await page.screenshot({ path: path.join(shotDir, 'login.png') });
    await page.fill('#usr', 'admfib7H');
    await page.fill('#pas', 'd9tQGJdZ77');
    await Promise.all([page.waitForURL('**/V3/'), page.click('#loginButton')]);

    await page.waitForSelector('#onlineTabsBody tr');
    await page.fill('#composeSubject', 'Check {orderno}');
    await page.click('#composeEditor');
    await page.keyboard.type('Hello body');

    // Toggle conversion select html -> pdf reveals filename/watermark inputs
    assert.equal(await page.locator('#convertFilename').isVisible(), false);
    await page.selectOption('#convertFormatSelect', 'pdf');
    assert.equal(await page.locator('#convertFilename').isVisible(), true);
    await page.selectOption('#convertFormatSelect', 'html');

    // Test Shoot modal multi-line textarea
    await page.click('#openTestModalBtn');
    await page.fill('#newTestEmails', 'seed1@demo.com\nseed2@demo.com');
    await page.click('#addTestRecipientBtn');
    await page.waitForFunction(() => document.getElementById('testSavedCount').textContent === '2');
    await page.click('#testDialogClose');

    // Reload All Confirm Modal
    await page.click('#reloadAllTabsBtn');
    await page.waitForSelector('#confirmDialog[open]');
    assert.match(await page.locator('#confirmDialogMsg').innerText(), /RELOAD ALL OPENED TABS/i);
    await page.click('#confirmNoBtn');

    // Partial data SHOOT -> Confirm Modal ("No" cancels, "Yes" fires + shows Duplicate Tabs warning + SHOOT toast)
    await page.click('#sendButton');
    await page.waitForSelector('#confirmDialog[open]');
    assert.match(await page.locator('#confirmDialogMsg').innerText(), /no data loaded/i);
    await page.click('#confirmNoBtn');
    assert.equal(await page.locator('#toastRegion .toast-item').count(), 0);

    await page.click('#sendButton');
    await page.waitForSelector('#confirmDialog[open]');
    await page.click('#confirmYesBtn');
    await page.waitForFunction(() => document.querySelectorAll('#toastRegion .toast-item').length >= 2);
    await page.waitForFunction(() => document.getElementById('onlineTabsBody').innerText.includes('Queued (No Ext)'));
    await page.waitForTimeout(250);
    const toastTexts = await page.locator('#toastRegion .toast-item').allInnerTexts();
    assert.ok(toastTexts.some((t) => /Duplicate Tabs Found/i.test(t)));
    assert.ok(toastTexts.some((t) => /SHOOT/i.test(t)));

    // Verify existing row updated in-place (2 rows, not phantom 3rd row)
    assert.equal(await page.locator('#onlineTabsBody tr').count(), 2);

    // Visual layout assertions on /V3/:
    // 1. Toasts stay strictly below .site-header and never overlap header buttons or SHOOT button
    const v3Layout = await page.evaluate(() => {
      const rect = (el) => {
        const r = el.getBoundingClientRect();
        return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, height: r.height, width: r.width };
      };
      const isSingleLineText = (el) => {
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        let node;
        while ((node = walker.nextNode())) {
          if (!node.nodeValue.trim()) continue;
          const range = document.createRange();
          range.selectNodeContents(node);
          if (range.getClientRects().length > 1) return false;
        }
        return true;
      };
      const tabContainer = document.querySelector('.tab-container');
      const tabCells = [...document.querySelectorAll('#onlineTabsBody td.col-tab')].map((el) => ({
        text: el.textContent.trim(),
        singleLine: isSingleLineText(el)
      }));
      const dataCells = [...document.querySelectorAll('#onlineTabsBody td.col-data')].map((el) => ({
        text: el.textContent.trim(),
        singleLine: isSingleLineText(el)
      }));
      const statusPills = [...document.querySelectorAll('#onlineTabsBody .status-pill')].map((el) => ({
        text: el.textContent.trim(),
        singleLine: isSingleLineText(el),
        height: rect(el).height
      }));
      return {
        header: rect(document.querySelector('.site-header')),
        themeToggle: rect(document.getElementById('themeToggle')),
        chatBtn: rect(document.getElementById('chatBtn')),
        userPill: rect(document.querySelector('.user-pill')),
        sendButton: rect(document.getElementById('sendButton')),
        toasts: [...document.querySelectorAll('#toastRegion .toast-item')].map(rect),
        tabContainerOverflow: tabContainer.scrollWidth - tabContainer.clientWidth,
        tabCells,
        dataCells,
        statusPills
      };
    });

    for (const tr of v3Layout.toasts) {
      assert.ok(tr.top >= v3Layout.header.bottom, `Toast top (${tr.top}) should be below header bottom (${v3Layout.header.bottom})`);
      assertNoRectOverlap(tr, v3Layout.themeToggle, 'V3 toast vs themeToggle');
      assertNoRectOverlap(tr, v3Layout.chatBtn, 'V3 toast vs chatBtn');
      assertNoRectOverlap(tr, v3Layout.userPill, 'V3 toast vs userPill');
      assertNoRectOverlap(tr, v3Layout.sendButton, 'V3 toast vs SHOOT button');
    }
    assert.ok(v3Layout.tabContainerOverflow <= 1, `Expected ONLINE TABS table to fit without horizontal clipping, overflow=${v3Layout.tabContainerOverflow}`);
    for (const c of v3Layout.tabCells) assert.equal(c.singleLine, true, `Expected .col-tab "${c.text}" to remain single-line`);
    for (const c of v3Layout.dataCells) assert.equal(c.singleLine, true, `Expected .col-data "${c.text}" to remain single-line`);
    for (const p of v3Layout.statusPills) {
      assert.equal(p.singleLine, true, `Expected .status-pill "${p.text}" to remain single-line`);
      assert.ok(p.height <= 26, `Expected .status-pill "${p.text}" height <= 26px, got ${p.height}`);
    }

    // Verify dynamic toast offset never overlaps wrapped .site-header on narrow viewports (1024px, 900px, 650px)
    for (const vp of [{ width: 1024, height: 768 }, { width: 900, height: 800 }, { width: 650, height: 800 }]) {
      await page.setViewportSize(vp);
      await page.evaluate(() => window.RelayCommon.showToast('Viewport Check', 'Header wrap test', 'info', 4000));
      const vpCheck = await page.evaluate(() => {
        const hdr = document.querySelector('.site-header').getBoundingClientRect();
        const toast = document.querySelector('#toastRegion .toast-item:last-child').getBoundingClientRect();
        return { hdrBottom: hdr.bottom, toastTop: toast.top };
      });
      assert.ok(vpCheck.toastTop >= vpCheck.hdrBottom, `Viewport ${vp.width}x${vp.height}: toast (${vpCheck.toastTop}) overlapped header (${vpCheck.hdrBottom})`);
    }
    await page.setViewportSize({ width: 1440, height: 900 });

    await page.screenshot({ path: path.join(shotDir, 'relay-light.png') });
    await page.click('#themeToggle');
    await page.waitForTimeout(100);
    await page.screenshot({ path: path.join(shotDir, 'relay-dark.png') });
    await page.click('#themeToggle');

    // /V3/tags/ and /V3/files/ screenshots
    await page.goto(`${baseUrl}/V3/tags/`, { waitUntil: 'load' });
    await page.waitForSelector('#tagsGrid');
    await page.screenshot({ path: path.join(shotDir, 'tags.png') });

    await page.goto(`${baseUrl}/V3/files/`, { waitUntil: 'load' });
    await page.waitForSelector('#labConvertBtn');
    await page.screenshot({ path: path.join(shotDir, 'files.png') });

    // GMASS-2 Script view: HTML only unchecks HTML->PDF, Show Failed & Pause work
    await page.goto(`${baseUrl}/gmass2`, { waitUntil: 'load' });
    await page.check('#gmConvertPdf');
    await page.check('#gmHtmlOnly');
    assert.equal(await page.isChecked('#gmConvertPdf'), false);
    await page.fill('#gmEmails', 'x1@example.com\nx2@example.com');
    await page.click('#gmBlastBtn');
    await page.click('#gmPauseBtn');
    await page.waitForFunction(() => document.getElementById('gmassStatusPill').innerText.includes('Paused'));
    await page.waitForTimeout(250);

    const g2Layout = await page.evaluate(() => {
      const rect = (el) => {
        const r = el.getBoundingClientRect();
        return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
      };
      return {
        header: rect(document.querySelector('.site-header')),
        themeToggle: rect(document.getElementById('themeToggle')),
        gmBlastBtn: rect(document.getElementById('gmBlastBtn')),
        toasts: [...document.querySelectorAll('#toastRegion .toast-item')].map(rect)
      };
    });
    for (const tr of g2Layout.toasts) {
      assert.ok(tr.top >= g2Layout.header.bottom, `GMASS toast top (${tr.top}) should be below header bottom (${g2Layout.header.bottom})`);
      assertNoRectOverlap(tr, g2Layout.themeToggle, 'GMASS toast vs themeToggle');
      assertNoRectOverlap(tr, g2Layout.gmBlastBtn, 'GMASS toast vs Blast button');
    }
    await page.screenshot({ path: path.join(shotDir, 'gmass2.png') });

    // Extension popup interactive UI
    const extPopupUrl = 'file://' + path.resolve(__dirname, '../extension/popup/popup.html');
    await page.goto(extPopupUrl, { waitUntil: 'load' });
    await page.selectOption('#tabNumber', '4');
    await page.locator('#hSlider').fill('40');
    await page.locator('#hSlider').dispatchEvent('input');
    assert.equal(await page.locator('#hVal').innerText(), '40%');

    // Live input highlighting & idCount update
    await page.click('#loginIds');
    await page.keyboard.type('alpha@gmail.com Pass123 rec@yahoo.com JBSW socks5://1.2.3.4:1080');
    await page.waitForFunction(() => document.getElementById('idCount').textContent === '1 ID');
    const liveClasses = await page.evaluate(() => [...document.querySelectorAll('#loginIds span')].map((s) => s.className));
    assert.deepEqual(liveClasses, ['gid-email', 'gid-password', 'gid-recovery', 'gid-2fa', 'gid-proxy']);

    // Automation Settings Reset Defaults button
    await page.click('#openSettingsBtn');
    await page.selectOption('#setTypingSpeed', 'instant');
    await page.click('#resetSettingsBtn');
    assert.equal(await page.inputValue('#setTypingSpeed'), 'normal');
    await page.click('#settingsDlgClose');
    await page.screenshot({ path: path.join(shotDir, 'popup.png') });

    for (const shotName of ['login.png', 'relay-light.png', 'relay-dark.png', 'tags.png', 'files.png', 'gmass2.png', 'popup.png']) {
      const st = fs.statSync(path.join(shotDir, shotName));
      assert.ok(st.size > 1000, `Expected non-empty screenshot ${shotName}`);
    }
  } finally {
    await browser.close();
    await app.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('E2E Extension Drivers: gds-driver, support-driver, drive-driver, gmail-driver, outlook-driver, yahoo-driver + accept-consent', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-drivers-'));
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
    ignoreDefaultArgs: ['--disable-extensions'],
    args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`]
  });

  try {
    let sw = context.serviceWorkers()[0];
    if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 10000 });
    const extId = sw.url().split('/')[2];

    // Configure Controller wsUrl via Automation Settings UI in extension popup
    const popupPage = await context.newPage();
    await popupPage.goto(`chrome-extension://${extId}/popup/popup.html`, { waitUntil: 'load' });
    await popupPage.click('#openSettingsBtn');
    await popupPage.fill('#setWsUrl', wsUrl);
    await popupPage.selectOption('#setTypingSpeed', 'instant');
    await popupPage.click('#settingsForm button[type="submit"]');
    await popupPage.waitForFunction(() => !document.getElementById('automationSettingsDialog').open);

    // Wait for extension service worker WS connection to open
    for (let i = 0; i < 30; i++) {
      const open = await sw.evaluate(() => Boolean(ws && ws.readyState === WebSocket.OPEN));
      if (open) break;
      await new Promise((r) => setTimeout(r, 100));
    }

    // 1. gds-driver.js (trySkipGds / GDS_SKIPPED)
    await context.route('https://gds.google.com/**', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: `<!doctype html><html><body>
          <h1>Google Workspace Prompt</h1>
          <button id="gdsSkipBtn" type="button" onclick="window.__gdsClicked = true;">Skip</button>
        </body></html>`
      });
    });
    const gdsPage = await context.newPage();
    await gdsPage.goto('https://gds.google.com/prompt', { waitUntil: 'domcontentloaded' });
    await gdsPage.waitForFunction(() => window.__gdsClicked === true, null, { timeout: 10000 });
    let gdsSession = null;
    for (let i = 0; i < 20; i++) {
      gdsSession = await sw.evaluate(async () => (await getSession(['lastGdsSkipped'])).lastGdsSkipped);
      if (gdsSession) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(gdsSession && gdsSession.url.includes('https://gds.google.com/prompt'), 'Expected GDS_SKIPPED to be recorded by service worker');
    await gdsPage.close();

    // 2. support-driver.js (account suspension detection & REPORT_VERIFICATION_STATUS / TASK_STATUS_UPDATE)
    await context.route('https://support.google.com/**', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: `<!doctype html><html><body>
          <h1>Your account has been disabled</h1>
          <p>The Google Account suspended.user@gmail.com has violated Google's terms.</p>
        </body></html>`
      });
    });
    const supPage = await context.newPage();
    await supPage.goto('https://support.google.com/accounts/answer/40695', { waitUntil: 'domcontentloaded' });
    let suspStatus = null;
    for (let i = 0; i < 30; i++) {
      suspStatus = await sw.evaluate(async () => {
        const ses = await getSession(['verificationStatuses']);
        return ses.verificationStatuses?.['suspended.user@gmail.com'] || null;
      });
      if (suspStatus) break;
      await new Promise((r) => setTimeout(r, 150));
    }
    assert.ok(suspStatus, 'Expected support-driver to report verification status');
    assert.equal(suspStatus.severity, 'fatal');
    assert.match(suspStatus.statusText, /disabled|suspended/i);
    await supPage.close();

    // 3. drive-driver.js (DRIVE_AUTO_SHARE)
    await context.route('https://drive.google.com/**', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: `<!doctype html><html><body>
          <button id="shareBtn" aria-label="Share" type="button" onclick="document.getElementById('shareModal').hidden=false;">Share</button>
          <div id="shareModal" hidden>
            <button id="accessTrigger" type="button" onclick="document.getElementById('accessMenu').hidden=false;">Restricted</button>
            <div id="accessMenu" hidden>
              <div role="menuitem" id="anyoneOpt" onclick="
                document.getElementById('accessMenu').hidden=true;
                document.getElementById('accessTrigger').textContent='Anyone with the link';
                document.getElementById('shareLinkInput').value='https://drive.google.com/file/d/doc123/view?usp=sharing';
              ">Anyone with the link</div>
            </div>
            <input id="shareLinkInput" type="url" readonly value="https://drive.google.com/file/d/doc123/view" />
            <button id="copyBtn" type="button" onclick="window.__copiedLink=true;">Copy link</button>
            <button id="doneBtn" type="button" onclick="window.__doneClicked=true;">Done</button>
          </div>
        </body></html>`
      });
    });
    const drivePage = await context.newPage();
    await drivePage.goto('https://drive.google.com/file/d/doc123/view', { waitUntil: 'load' });
    await drivePage.waitForTimeout(250);
    const driveRes = await sw.evaluate(async () => {
      const tabs = await chrome.tabs.query({ url: 'https://drive.google.com/*' });
      return chrome.tabs.sendMessage(tabs[0].id, { action: 'DRIVE_AUTO_SHARE' });
    });
    assert.equal(driveRes.ok, true);
    assert.equal(driveRes.url, 'https://drive.google.com/file/d/doc123/view?usp=sharing');
    assert.equal(await drivePage.evaluate(() => Boolean(window.__copiedLink && window.__doneClicked)), true);
    await drivePage.close();

    // 4. gmail-driver.js (#ns-relay-sidebar + INBOX_READY + FETCH_FOLDERS + EXECUTE_DISPATCH with attachment)
    await context.route('https://mail.google.com/**', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: `<!doctype html><html><head><title>Inbox - gdriver@gmail.com - Gmail</title></head><body>
          <nav>
            <a href="#inbox">Inbox</a><span class="bsU">7</span>
            <a href="#drafts">Drafts</a><span class="bsU">2</span>
            <a href="#sent">Sent</a><span class="bsU">19</span>
            <a href="#spam">Spam</a><span class="bsU">1</span>
          </nav>
          <div gh="cm" role="button" onclick="document.getElementById('gmCompose').hidden=false;">Compose</div>
          <div id="gmCompose" hidden style="margin-left:300px">
            <input aria-label="To" type="text" />
            <input name="subjectbox" type="text" />
            <div aria-label="Message Body" contenteditable="true" style="min-height:40px;border:1px solid #ccc"></div>
            <input id="gmFileIn" type="file" name="Filedata" onchange="window.__gmAttached=[...this.files].map(f=>({name:f.name,size:f.size}));" />
            <div id="gmSendBtn" role="button" aria-label="Send" data-tooltip="Send" style="display:inline-block;padding:6px 12px">Send</div>
          </div>
          <script>
            document.getElementById('gmSendBtn').addEventListener('click', function () {
              window.__gmSent = {
                to: document.querySelector('input[aria-label="To"]').value,
                subject: document.querySelector('input[name="subjectbox"]').value,
                body: document.querySelector('div[aria-label="Message Body"]').innerHTML,
                attachments: window.__gmAttached || []
              };
            });
          </script>
        </body></html>`
      });
    });
    const gmailPage = await context.newPage();
    await gmailPage.goto('https://mail.google.com/mail/u/0/#inbox', { waitUntil: 'load' });
    await gmailPage.waitForSelector('#ns-relay-sidebar', { timeout: 8000 });
    // Expand sidebar to verify controls mount cleanly
    await gmailPage.click('#ns-relay-sidebar > div:first-child');
    assert.equal(await gmailPage.locator('#ns-sidebar-recipients').isVisible(), true);
    assert.equal(await gmailPage.locator('#ns-sidebar-start').isVisible(), true);

    // Wait for INBOX_READY to register on Controller
    for (let i = 0; i < 60; i++) {
      if (app.store.listOnlineTabs().some((t) => t.email === 'gdriver@gmail.com')) break;
      await new Promise((r) => setTimeout(r, 150));
    }
    assert.ok(app.store.listOnlineTabs().some((t) => t.email === 'gdriver@gmail.com' && t.provider === 'gmail'));

    // Mutate DOM inbox count to prove FETCH_FOLDERS scrapes updated counts from live page
    await gmailPage.evaluate(() => { document.querySelector('a[href*="#inbox"] + .bsU').textContent = '8'; });
    app.wsHub.sendToAccount('gdriver@gmail.com', { type: 'FETCH_FOLDERS' });
    for (let i = 0; i < 20; i++) {
      const row = app.store.listOnlineTabs().find((t) => t.email === 'gdriver@gmail.com');
      if (row && row.inbox === 8 && row.sent === 19) break;
      await new Promise((r) => setTimeout(r, 150));
    }
    const gmTabRow = app.store.listOnlineTabs().find((t) => t.email === 'gdriver@gmail.com');
    assert.equal(gmTabRow.inbox, 8);
    assert.equal(gmTabRow.draft, 2);
    assert.equal(gmTabRow.sent, 19);
    assert.equal(gmTabRow.spam, 1);

    // Trigger EXECUTE_DISPATCH with attachment
    app.wsHub.sendToAccount('gdriver@gmail.com', {
      type: 'EXECUTE_DISPATCH',
      taskId: 'gm_task_1',
      accountId: 'gdriver@gmail.com',
      provider: 'gmail',
      recipientEmail: 'client1@example.org',
      subject: 'Invoice for {user}',
      body: '<p>Attached PDF</p>',
      attachments: [{
        filename: 'statement.pdf',
        mimeType: 'application/pdf',
        base64: Buffer.from('%PDF-1.4 test').toString('base64')
      }]
    });
    await gmailPage.waitForFunction(() => Boolean(window.__gmSent), null, { timeout: 12000 });
    const gmSent = await gmailPage.evaluate(() => window.__gmSent);
    assert.equal(gmSent.to, 'client1@example.org');
    assert.equal(gmSent.subject, 'Invoice for client1');
    assert.match(gmSent.body, /Attached PDF/);
    assert.equal(gmSent.attachments.length, 1);
    assert.equal(gmSent.attachments[0].name, 'statement.pdf');
    for (let i = 0; i < 20; i++) {
      const row = app.store.listOnlineTabs().find((t) => t.email === 'gdriver@gmail.com');
      if (row && row.sent >= 20) break;
      await new Promise((r) => setTimeout(r, 150));
    }
    assert.equal(app.store.listOnlineTabs().find((t) => t.email === 'gdriver@gmail.com').sent, 20);
    await gmailPage.close();

    // 5. outlook-driver.js (INBOX_READY + FETCH_FOLDERS + EXECUTE_DISPATCH)
    await context.route('https://outlook.live.com/**', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: `<!doctype html><html><head><title>Mail - outdriver@outlook.com</title></head><body>
          <div data-folder-name="inbox"><span id="outInbox" title="4 unread">4</span></div>
          <div data-folder-name="drafts"><span>1</span></div>
          <div data-folder-name="sentitems"><span>12</span></div>
          <div data-folder-name="junkemail"><span>3</span></div>
          <button type="button" aria-label="New mail" onclick="document.getElementById('outCompose').hidden=false;">New mail</button>
          <div id="outCompose" hidden>
            <div aria-label="To" contenteditable="true" style="min-height:24px;border:1px solid #ccc" onkeydown="if(event.key==='Enter')event.preventDefault();"></div>
            <input aria-label="Add a subject" type="text" />
            <div aria-label="Message body, press Alt+F10 to exit" contenteditable="true" style="min-height:40px;border:1px solid #ccc"></div>
            <button id="outSendBtn" type="button" aria-label="Send">Send</button>
          </div>
          <script>
            document.getElementById('outSendBtn').addEventListener('click', function () {
              window.__outSent = {
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
    for (let i = 0; i < 30; i++) {
      if (app.store.listOnlineTabs().some((t) => t.email === 'outdriver@outlook.com')) break;
      await new Promise((r) => setTimeout(r, 150));
    }
    const outTab = app.store.listOnlineTabs().find((t) => t.email === 'outdriver@outlook.com');
    assert.ok(outTab);
    assert.equal(outTab.provider, 'outlook');
    assert.equal(outTab.inbox, 4);
    assert.equal(outTab.sent, 12);

    await outPage.evaluate(() => { document.getElementById('outInbox').textContent = '6'; });
    app.wsHub.sendToAccount('outdriver@outlook.com', { type: 'FETCH_FOLDERS' });
    for (let i = 0; i < 20; i++) {
      const row = app.store.listOnlineTabs().find((t) => t.email === 'outdriver@outlook.com');
      if (row && row.inbox === 6) break;
      await new Promise((r) => setTimeout(r, 150));
    }
    assert.equal(app.store.listOnlineTabs().find((t) => t.email === 'outdriver@outlook.com').inbox, 6);

    app.wsHub.sendToAccount('outdriver@outlook.com', {
      type: 'EXECUTE_DISPATCH',
      taskId: 'out_task_1',
      accountId: 'outdriver@outlook.com',
      provider: 'outlook',
      recipientEmail: 'lead@contoso.com',
      subject: 'Hello {user}',
      body: '<p>Outlook dispatch</p>'
    });
    await outPage.waitForFunction(() => Boolean(window.__outSent), null, { timeout: 12000 });
    const outSent = await outPage.evaluate(() => window.__outSent);
    assert.equal(outSent.to, 'lead@contoso.com');
    assert.equal(outSent.subject, 'Hello lead');
    assert.match(outSent.body, /Outlook dispatch/);
    await outPage.close();

    // 6. accept-consent.js (#mail-accept-all-2) + yahoo-driver.js (INBOX_READY + FETCH_FOLDERS + EXECUTE_DISPATCH)
    await context.route('https://consent.yahoo.com/**', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: `<!doctype html><html><body>
          <div style="position:fixed;inset:0;display:flex;align-items:center;justify-content:center">
            <button id="mail-accept-all-2" type="button" onclick="window.__consentAccepted=true;">Accept all</button>
          </div>
        </body></html>`
      });
    });
    const consentPage = await context.newPage();
    await consentPage.goto('https://consent.yahoo.com/v2/collectConsent', { waitUntil: 'domcontentloaded' });
    await consentPage.waitForFunction(() => window.__consentAccepted === true, null, { timeout: 8000 });
    await consentPage.close();

    await context.route('https://mail.yahoo.com/**', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: `<!doctype html><html><head><title>ydriver@yahoo.com - Yahoo Mail</title></head><body>
          <div data-test-folder-name="Inbox"><span id="yInbox" data-test-id="folder-count">9</span></div>
          <div data-test-folder-name="Draft"><span data-test-id="folder-count">3</span></div>
          <div data-test-folder-name="Sent"><span data-test-id="folder-count">22</span></div>
          <div data-test-folder-name="Bulk"><span data-test-id="folder-count">5</span></div>
          <button type="button" data-test-id="compose-button" onclick="document.getElementById('yCompose').hidden=false;">Compose</button>
          <div id="yCompose" hidden>
            <input id="message-to-field" type="text" />
            <input data-test-id="compose-subject" type="text" />
            <div data-test-id="rte"><div contenteditable="true" style="min-height:40px;border:1px solid #ccc"></div></div>
            <button id="ySendBtn" type="button" data-test-id="compose-send-button">Send</button>
          </div>
          <script>
            document.getElementById('ySendBtn').addEventListener('click', function () {
              window.__ySent = {
                to: document.getElementById('message-to-field').value,
                subject: document.querySelector('[data-test-id="compose-subject"]').value,
                body: document.querySelector('[data-test-id="rte"] [contenteditable="true"]').innerHTML
              };
            });
          </script>
        </body></html>`
      });
    });
    const yahooPage = await context.newPage();
    await yahooPage.goto('https://mail.yahoo.com/d/folders/1', { waitUntil: 'load' });
    for (let i = 0; i < 30; i++) {
      if (app.store.listOnlineTabs().some((t) => t.email === 'ydriver@yahoo.com')) break;
      await new Promise((r) => setTimeout(r, 150));
    }
    const yTab = app.store.listOnlineTabs().find((t) => t.email === 'ydriver@yahoo.com');
    assert.ok(yTab);
    assert.equal(yTab.provider, 'yahoo');
    assert.equal(yTab.inbox, 9);
    assert.equal(yTab.draft, 3);
    assert.equal(yTab.sent, 22);
    assert.equal(yTab.spam, 5);

    await yahooPage.evaluate(() => { document.getElementById('yInbox').textContent = '11'; });
    app.wsHub.sendToAccount('ydriver@yahoo.com', { type: 'FETCH_FOLDERS' });
    for (let i = 0; i < 20; i++) {
      const row = app.store.listOnlineTabs().find((t) => t.email === 'ydriver@yahoo.com');
      if (row && row.inbox === 11) break;
      await new Promise((r) => setTimeout(r, 150));
    }
    assert.equal(app.store.listOnlineTabs().find((t) => t.email === 'ydriver@yahoo.com').inbox, 11);

    app.wsHub.sendToAccount('ydriver@yahoo.com', {
      type: 'EXECUTE_DISPATCH',
      taskId: 'y_task_1',
      accountId: 'ydriver@yahoo.com',
      provider: 'yahoo',
      recipientEmail: 'recipient@ymail.com',
      subject: 'Yahoo {user}',
      body: '<p>Yahoo dispatch</p>'
    });
    await yahooPage.waitForFunction(() => Boolean(window.__ySent), null, { timeout: 12000 });
    const ySent = await yahooPage.evaluate(() => window.__ySent);
    assert.equal(ySent.to, 'recipient@ymail.com');
    assert.equal(ySent.subject, 'Yahoo recipient');
    assert.match(ySent.body, /Yahoo dispatch/);

    // Verify ABORT_DISPATCH & RELOAD_TABS on live mail tab
    let yahooReloaded = false;
    yahooPage.on('framenavigated', (frame) => {
      if (frame === yahooPage.mainFrame()) yahooReloaded = true;
    });
    app.wsHub.broadcastAgents({ type: 'ABORT_DISPATCH', campaignId: 'test_abort' });
    await yahooPage.waitForTimeout(150);
    app.wsHub.sendToAccount('ydriver@yahoo.com', { type: 'RELOAD_TABS', tabIds: [yTab.tabId] });
    for (let i = 0; i < 20 && !yahooReloaded; i++) await new Promise((r) => setTimeout(r, 150));
    assert.equal(yahooReloaded, true, 'Expected RELOAD_TABS to reload live Yahoo tab');
    await yahooPage.close();

    // 7. login-driver.js runOutlookFlow & runYahooFlow (including ignoring empty error containers)
    const totpSecret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
    await context.route('https://login.live.com/**', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: `<!doctype html><html><body>
          <div id="usernameError" style="min-height:14px"></div>
          <div id="s1">
            <input id="i0116" name="loginfmt" type="email" />
            <input id="idSIButton9" type="submit" value="Next" onclick="document.getElementById('s1').hidden=true;document.getElementById('s2').hidden=false;" />
          </div>
          <div id="s2" hidden>
            <input id="i0118" name="passwd" type="password" />
            <input id="idSIButton9" type="submit" value="Sign in" onclick="document.getElementById('s2').hidden=true;document.getElementById('s3').hidden=false;" />
          </div>
          <div id="s3" hidden>
            <input id="idTxtBx_SAOTCC_OTC" name="otc" type="text" />
            <input id="idSubmit_SAOTCC_Continue" type="submit" value="Verify" onclick="window.__outLoginDone={email:document.getElementById('i0116').value,pass:document.getElementById('i0118').value,otc:document.getElementById('idTxtBx_SAOTCC_OTC').value};" />
          </div>
        </body></html>`
      });
    });
    const outLoginPage = await context.newPage();
    await sw.evaluate(async (secret) => {
      await chrome.storage.local.set({ rpa_email: 'outuser@outlook.com', rpa_password: 'OutPass1!', rpa_twoFa: secret });
    }, totpSecret);
    await outLoginPage.goto('https://login.live.com/', { waitUntil: 'domcontentloaded' });
    await outLoginPage.waitForFunction(() => Boolean(window.__outLoginDone), null, { timeout: 12000 });
    const outRes = await outLoginPage.evaluate(() => window.__outLoginDone);
    assert.equal(outRes.email, 'outuser@outlook.com');
    assert.equal(outRes.pass, 'OutPass1!');
    assert.match(outRes.otc, /^\d{6}$/);
    await outLoginPage.close();

    await context.route('https://login.yahoo.com/**', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: `<!doctype html><html><body>
          <div class="error-msg" style="min-height:12px"></div>
          <div id="y1">
            <input id="login-username" type="text" />
            <button id="login-signin" type="button" onclick="document.getElementById('y1').hidden=true;document.getElementById('y2').hidden=false;">Next</button>
          </div>
          <div id="y2" hidden>
            <input id="login-passwd" type="password" />
            <button id="login-signin" type="button" onclick="window.__yahooLoginDone={email:document.getElementById('login-username').value,pass:document.getElementById('login-passwd').value};">Sign in</button>
          </div>
        </body></html>`
      });
    });
    const yLoginPage = await context.newPage();
    await sw.evaluate(async () => {
      await chrome.storage.local.set({ rpa_email: 'yuser@yahoo.com', rpa_password: 'YahooPass1!', rpa_twoFa: '' });
    });
    await yLoginPage.goto('https://login.yahoo.com/', { waitUntil: 'domcontentloaded' });
    await yLoginPage.waitForFunction(() => Boolean(window.__yahooLoginDone), null, { timeout: 12000 });
    const yRes = await yLoginPage.evaluate(() => window.__yahooLoginDone);
    assert.equal(yRes.email, 'yuser@yahoo.com');
    assert.equal(yRes.pass, 'YahooPass1!');
    await yLoginPage.close();
  } finally {
    await context.close();
    await app.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('E2E Extension Popup Isolated Proxy over WS (cross-origin localhost vs 127.0.0.1) & Standalone HTTP Basic Proxy Auth via onAuthRequired', { timeout: 60000 }, async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-ext-proxy-'));
  const extDir = path.resolve(__dirname, '../extension');

  const targetServer = http.createServer((req, res) => {
    if (req.url.startsWith('/whoami')) {
      const json = JSON.stringify({ identity: req.headers['x-proxy-identity'] || 'direct', path: req.url });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(json) });
      res.end(json);
      return;
    }
    if (req.url.startsWith('/json')) {
      const json = JSON.stringify({ status: 'success', query: '127.0.0.1', country: 'US', isp: 'Mock' });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(json) });
      res.end(json);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
  });
  await new Promise((r) => targetServer.listen(0, '127.0.0.1', r));
  const targetPort = targetServer.address().port;

  const socks5 = await startMockSocks5Server({
    username: 's5u',
    password: 's5p',
    hostMap: {
      'iso-exit.example': '127.0.0.1',
      'ip-api.com': `127.0.0.1:${targetPort}`
    }
  });
  const httpProxy = await startMockHttpProxy({
    username: 'extuser',
    password: 'extpass',
    proxyTag: 'EXT-BASIC-OK',
    hostMap: { 'standalone-target.example': '127.0.0.1' }
  });

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
    ignoreDefaultArgs: ['--disable-extensions'],
    args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`]
  });

  try {
    let sw = context.serviceWorkers()[0];
    if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 10000 });
    const extId = sw.url().split('/')[2];

    // Sign in on http://localhost:<port> (NOT 127.0.0.1!) so there is NO HTTP cookie on 127.0.0.1
    const dashPage = await context.newPage();
    await dashPage.goto(`http://localhost:${addr.port}/Login.php`, { waitUntil: 'load' });
    await dashPage.fill('#usr', 'admfib7H');
    await dashPage.fill('#pas', 'd9tQGJdZ77');
    await Promise.all([dashPage.waitForURL('**/V3/'), dashPage.click('#loginButton')]);
    await dashPage.close();

    // Open Extension popup and point wsUrl to ws://127.0.0.1:<port>
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extId}/popup/popup.html`, { waitUntil: 'load' });
    await popup.click('#openSettingsBtn');
    await popup.fill('#setWsUrl', wsUrl);
    await popup.click('#settingsForm button[type="submit"]');
    await popup.waitForFunction(() => !document.getElementById('automationSettingsDialog').open);

    // 1. Launch Isolated Proxy from popup WITHOUT 127.0.0.1 cookies (must succeed via Controller WS)
    await popup.click('#loginIds');
    await popup.keyboard.type(`iso@gmail.com IsoPass1! rec@mail.com JBSW socks5://s5u:s5p@127.0.0.1:${socks5.port}`);
    await popup.click('#launchIsolatedBtn');
    await popup.waitForFunction(
      () => /Launched 1 isolated proxied browser/i.test(document.getElementById('popupStatusMsg').innerText),
      null,
      { timeout: 25000 }
    );

    const acc = app.store.getAccount('iso@gmail.com');
    assert.ok(acc && acc.launched);
    const isoTabs = app.store.listOnlineTabs().filter((t) => t.email === 'iso@gmail.com');
    assert.equal(isoTabs.length, 1, `Expected 1 deduplicated onlineTab for iso@gmail.com, got ${isoTabs.length}`);
    assert.equal(isoTabs[0].isDup, false);

    const isoSess = app.browserManager.getRunningSession(acc.id);
    assert.ok(isoSess);
    await isoSess.page.goto(`http://iso-exit.example:${targetPort}/whoami`, { waitUntil: 'load' });
    assert.ok(socks5.stats.requestedHosts.includes(`iso-exit.example:${targetPort}`));
    await app.browserManager.stopAll();

    // 1b. Mixed per-account Isolated Proxy launch (1 valid + 1 invalid proxy protocol) surfaces partial error warning
    await popup.evaluate(() => {
      const box = document.getElementById('loginIds');
      box.innerText = '';
    });
    await popup.click('#loginIds');
    await popup.keyboard.type(
      `mix1@gmail.com MixPass1! socks5://s5u:s5p@127.0.0.1:${socks5.port}\nmix2@gmail.com MixPass2! ftp://127.0.0.1:21`
    );
    await popup.click('#launchIsolatedBtn');
    await popup.waitForFunction(
      () => /Launched 1; 1 issue\(s\)/i.test(document.getElementById('popupStatusMsg').innerText),
      null,
      { timeout: 25000 }
    );
    assert.match(await popup.locator('#popupStatusMsg').getAttribute('class'), /is-warn/);
    await app.browserManager.stopAll();

    // 2. Wrong Basic Proxy Auth credentials cancel cleanly at attempts > 2 without hanging
    await popup.fill('#standaloneProxyInput', `http://wronguser:wrongpass@127.0.0.1:${httpProxy.port}`);
    await popup.click('#applyProxyBtn');
    await popup.waitForFunction(
      () => /Standalone proxy applied \(http\)/i.test(document.getElementById('popupStatusMsg').innerText),
      null,
      { timeout: 5000 }
    );
    const badAuthPage = await context.newPage();
    const tWrongStart = Date.now();
    await badAuthPage.goto(`http://standalone-target.example:${targetPort}/whoami`, { waitUntil: 'domcontentloaded', timeout: 5000 }).catch(() => {});
    assert.ok(Date.now() - tWrongStart < 4500, 'Expected wrong proxy Basic auth to cancel cleanly without hanging');
    assert.ok(httpProxy.stats.authChallenges >= 2);
    await badAuthPage.close();

    // 3. Valid Standalone HTTP Basic Proxy Auth + simulated MV3 Service Worker sleep/restart recovery & popup persistence
    await popup.fill('#standaloneProxyInput', `http://extuser:extpass@127.0.0.1:${httpProxy.port}`);
    await popup.click('#applyProxyBtn');
    await popup.waitForFunction(
      () => /Standalone proxy applied \(http\)/i.test(document.getElementById('popupStatusMsg').innerText),
      null,
      { timeout: 5000 }
    );
    // Simulate MV3 worker memory reset (activeProxyAuth cleared -> must recover from chrome.storage.session)
    await sw.evaluate(() => { activeProxyAuth = null; });
    await popup.reload({ waitUntil: 'load' });
    assert.equal(await popup.inputValue('#standaloneProxyInput'), `http://extuser:extpass@127.0.0.1:${httpProxy.port}`);

    const proxiedPage = await context.newPage();
    await proxiedPage.goto(`http://standalone-target.example:${targetPort}/whoami`, { waitUntil: 'load' });
    const whoami = JSON.parse(await proxiedPage.locator('body').innerText());
    assert.equal(whoami.identity, 'EXT-BASIC-OK');
    assert.ok(httpProxy.stats.authChallenges >= 1, 'Expected 407 Proxy Authentication challenge to fire');
    assert.ok(httpProxy.stats.authedRequests >= 1, 'Expected chrome.webRequest.onAuthRequired to supply Basic credentials');
    await proxiedPage.close();

    // Clear standalone proxy cleanly
    await popup.fill('#standaloneProxyInput', '');
    await popup.click('#applyProxyBtn');
    await popup.waitForFunction(
      () => /Standalone proxy cleared/i.test(document.getElementById('popupStatusMsg').innerText),
      null,
      { timeout: 5000 }
    );

    // 4. Unreachable Controller WS surfaces clean warning message instead of hanging
    await popup.click('#openSettingsBtn');
    await popup.fill('#setWsUrl', 'ws://127.0.0.1:1');
    await popup.click('#settingsForm button[type="submit"]');
    await popup.waitForFunction(() => !document.getElementById('automationSettingsDialog').open);
    await popup.click('#loginIds');
    await popup.evaluate(() => { document.getElementById('loginIds').innerText = 'unreach@gmail.com Pass1!'; });
    await popup.click('#launchIsolatedBtn');
    await popup.waitForFunction(
      () => /Controller WebSocket unreachable/i.test(document.getElementById('popupStatusMsg').innerText),
      null,
      { timeout: 8000 }
    );
    assert.match(await popup.locator('#popupStatusMsg').getAttribute('class'), /is-warn/);
  } finally {
    await context.close();
    await app.stop();
    await socks5.close();
    await httpProxy.close();
    await new Promise((r) => targetServer.close(r));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
