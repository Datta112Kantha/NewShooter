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
const { VerificationPool } = require('../src/core/verificationPool');

test('E2E All Features: Drivers (login-driver, support-driver, drive-driver, gds-driver, accept-consent, totp & verification pool)', { timeout: 90000 }, async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-e2e-drivers-'));
  const extDir = path.resolve(__dirname, '../extension');

  // Start controller server
  const app = createServer({
    port: 0,
    dataDir: path.join(tmpDir, 'data'),
    profilesRoot: path.join(tmpDir, 'profiles'),
    headless: true
  });
  const addr = await app.start(0, '127.0.0.1');
  const wsUrl = `ws://127.0.0.1:${addr.port}`;

  // Start mock SMS OTP HTTP server for verification pool tests
  let mockSmsCode = '748291';
  const smsServer = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(`Your Google verification code is G-${mockSmsCode}. Do not share it with anyone.`);
  });
  await new Promise((resolve) => smsServer.listen(0, '127.0.0.1', resolve));
  const smsPort = smsServer.address().port;
  const mockSmsUrl = `http://127.0.0.1:${smsPort}/api/sms-inbox`;

  // Capture WebSocket task status events
  const receivedTaskEvents = [];
  const origOnTaskEvent = app.wsHub.onTaskEvent;
  app.wsHub.onTaskEvent = (evt) => {
    receivedTaskEvents.push(evt);
    if (origOnTaskEvent) origOnTaskEvent(evt);
  };

  // Launch Chromium with the extension loaded
  const profileDir = path.join(tmpDir, 'ext-profile');
  fs.mkdirSync(profileDir, { recursive: true });
  const context = await chromium.launchPersistentContext(profileDir, {
    channel: 'chromium',
    headless: true,
    viewport: { width: 1280, height: 800 },
    ignoreDefaultArgs: ['--disable-extensions'],
    args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`]
  });

  try {
    let sw = context.serviceWorkers()[0];
    if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 15000 });
    const extId = sw.url().split('/')[2];

    // Configure extension settings via popup: set WS URL and instant typing speed
    const configPage = await context.newPage();
    await configPage.goto(`chrome-extension://${extId}/popup/popup.html`, { waitUntil: 'load' });
    await configPage.click('#openSettingsBtn');
    await configPage.fill('#setWsUrl', wsUrl);
    await configPage.selectOption('#setTypingSpeed', 'instant');
    await configPage.click('#settingsForm button[type="submit"]');
    await configPage.waitForFunction(() => !document.getElementById('automationSettingsDialog').open, null, { timeout: 5000 });
    await configPage.close();

    // Trigger explicit connect from SW
    await sw.evaluate(async (url) => {
      try {
        await connectWebSocket(url);
      } catch {}
    }, wsUrl);

    // Wait for extension background service worker to connect to the Controller WebSocket
    for (let i = 0; i < 40; i++) {
      const isConnected = await sw.evaluate(() => Boolean(ws && ws.readyState === WebSocket.OPEN));
      if (isConnected) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const wsReady = await sw.evaluate(() => Boolean(ws && ws.readyState === WebSocket.OPEN));
    assert.ok(wsReady, 'Extension service worker must connect to Controller WebSocket');

    // ─────────────────────────────────────────────────────────────────────────────
    // 1. login-driver.js: Full multi-step login flows (Gmail, Outlook, Yahoo)
    // ─────────────────────────────────────────────────────────────────────────────
    await t.test('1.1 login-driver.js: Gmail multi-step login with identifier, password, and TOTP resolution', async () => {
      const gmailAccount = {
        email: 'alice.e2e@gmail.com',
        password: 'AliceSecretPassword!99',
        twoFa: 'JBSWY3DPEHPK3PXP', // standard Base32 test secret
        recovery: 'alice.recovery@example.com'
      };

      // Set credentials in extension storage for pending login resolution
      await sw.evaluate(async (acc) => {
        await chrome.storage.local.set({
          rpa_email: acc.email,
          rpa_password: acc.password,
          rpa_twoFa: acc.twoFa,
          rpa_recovery: acc.recovery
        });
      }, gmailAccount);

      // Route Google Accounts domain with multi-step interactive mock page
      await context.route('https://accounts.google.com/**', (route) => {
        route.fulfill({
          status: 200,
          contentType: 'text/html',
          body: `<!doctype html><html><head><title>Sign in - Google Accounts</title></head><body>
            <div id="step-identifier" style="display:block; padding:20px;">
              <h2>Sign in</h2>
              <input id="identifierId" type="email" style="width:240px; height:32px; display:block;" placeholder="Email or phone" />
              <button id="identifierNext" type="button" style="width:80px; height:32px; display:block; margin-top:10px;">Next</button>
            </div>

            <div id="step-password" style="display:none; padding:20px;">
              <h2>Welcome</h2>
              <input name="Passwd" type="password" style="width:240px; height:32px; display:block;" placeholder="Enter your password" />
              <button id="passwordNext" type="button" style="width:80px; height:32px; display:block; margin-top:10px;">Next</button>
            </div>

            <div id="step-totp" style="display:none; padding:20px;">
              <h2>2-Step Verification</h2>
              <input id="totpPin" type="text" style="width:240px; height:32px; display:block;" placeholder="Enter code" />
              <button id="totpNext" type="button" style="width:80px; height:32px; display:block; margin-top:10px;">Next</button>
            </div>

            <div id="step-inbox" style="display:none; padding:20px;">
              <div gh="cm" role="button" style="display:block; width:100px; height:36px; background:#1a73e8; color:#fff;">Compose</div>
            </div>

            <script>
              window.__gmailSubmission = {};
              document.getElementById('identifierNext').addEventListener('click', function () {
                window.__gmailSubmission.email = document.getElementById('identifierId').value;
                document.getElementById('step-identifier').style.display = 'none';
                document.getElementById('step-password').style.display = 'block';
              });

              document.getElementById('passwordNext').addEventListener('click', function () {
                window.__gmailSubmission.password = document.querySelector('input[name="Passwd"]').value;
                document.getElementById('step-password').style.display = 'none';
                document.getElementById('step-totp').style.display = 'block';
              });

              document.getElementById('totpNext').addEventListener('click', function () {
                window.__gmailSubmission.totp = document.getElementById('totpPin').value;
                document.getElementById('step-totp').style.display = 'none';
                document.getElementById('step-inbox').style.display = 'block';
              });
            </script>
          </body></html>`
        });
      });

      const gmPage = await context.newPage();
      await gmPage.goto('https://accounts.google.com/signin/v2/identifier', { waitUntil: 'load' });

      // Wait for login-driver to complete all stages and reach the inbox compose button
      await gmPage.waitForFunction(() => Boolean(window.__gmailSubmission && window.__gmailSubmission.totp), null, { timeout: 20000 });
      const submitted = await gmPage.evaluate(() => window.__gmailSubmission);

      assert.equal(submitted.email, 'alice.e2e@gmail.com', 'Username should be typed into #identifierId');
      assert.equal(submitted.password, 'AliceSecretPassword!99', 'Password should be typed into input[name="Passwd"]');

      // Verify that the TOTP code submitted matches RFC 6238 generation from src/core/totp.js
      const expectedTotp = generateTOTP(gmailAccount.twoFa);
      assert.equal(submitted.totp, expectedTotp, 'Submitted TOTP code must match generateTOTP(secret)');

      // Verify INBOX_READY announcement is sent to Controller
      for (let i = 0; i < 40; i++) {
        if (app.store.listOnlineTabs().some((t) => t.email === 'alice.e2e@gmail.com')) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      assert.ok(app.store.listOnlineTabs().some((t) => t.email === 'alice.e2e@gmail.com' && t.provider === 'gmail'));
      await gmPage.close();
    });

    await t.test('1.2 login-driver.js: Outlook multi-step login with user, password, TOTP, and stay signed in', async () => {
      const outAccount = {
        email: 'bob.e2e@outlook.com',
        password: 'BobSecurePassword!88',
        twoFa: 'MFRGGZDFMZTWQ2LK' // RFC Base32 secret
      };

      await sw.evaluate(async (acc) => {
        await chrome.storage.local.set({
          rpa_email: acc.email,
          rpa_password: acc.password,
          rpa_twoFa: acc.twoFa
        });
      }, outAccount);

      await context.route('https://login.live.com/**', (route) => {
        route.fulfill({
          status: 200,
          contentType: 'text/html',
          body: `<!doctype html><html><head><title>Sign in to your Microsoft account</title></head><body>
            <div id="out-step-email" style="display:block; padding:20px;">
              <input id="i0116" name="loginfmt" type="email" style="width:240px; height:32px; display:block;" placeholder="Email, phone, or Skype" />
              <input id="idSIButton9" type="submit" value="Next" style="width:80px; height:32px; display:block; margin-top:10px;" />
            </div>

            <div id="out-step-pass" style="display:none; padding:20px;">
              <input id="i0118" name="passwd" type="password" style="width:240px; height:32px; display:block;" placeholder="Password" />
              <input id="idSIButton9-pass" type="submit" value="Sign in" style="width:80px; height:32px; display:block; margin-top:10px;" />
            </div>

            <div id="out-step-otc" style="display:none; padding:20px;">
              <input id="idTxtBx_SAOTCC_OTC" name="otc" type="text" style="width:240px; height:32px; display:block;" placeholder="Code" />
              <input id="idSubmit_SAOTCC_Continue" type="submit" value="Verify" style="width:80px; height:32px; display:block; margin-top:10px;" />
            </div>

            <div id="out-step-kmsi" style="display:none; padding:20px;">
              <h2>Stay signed in?</h2>
              <button id="acceptButton" type="button" style="width:80px; height:32px; display:block;">Yes</button>
            </div>

            <script>
              window.__outSubmission = {};
              document.getElementById('idSIButton9').addEventListener('click', function (e) {
                e.preventDefault();
                window.__outSubmission.email = document.getElementById('i0116').value;
                document.getElementById('out-step-email').style.display = 'none';
                document.getElementById('out-step-pass').style.display = 'block';
                // Update idSIButton9 to submit the password step
                document.getElementById('idSIButton9-pass').id = 'idSIButton9';
              });

              document.addEventListener('click', function (e) {
                if (e.target && e.target.value === 'Sign in') {
                  e.preventDefault();
                  window.__outSubmission.password = document.getElementById('i0118').value;
                  document.getElementById('out-step-pass').style.display = 'none';
                  document.getElementById('out-step-otc').style.display = 'block';
                }
              });

              document.getElementById('idSubmit_SAOTCC_Continue').addEventListener('click', function (e) {
                e.preventDefault();
                window.__outSubmission.totp = document.getElementById('idTxtBx_SAOTCC_OTC').value;
                document.getElementById('out-step-otc').style.display = 'none';
                document.getElementById('out-step-kmsi').style.display = 'block';
              });

              document.getElementById('acceptButton').addEventListener('click', function (e) {
                e.preventDefault();
                window.__outSubmission.staySignedIn = true;
              });
            </script>
          </body></html>`
        });
      });

      const outPage = await context.newPage();
      await outPage.goto('https://login.live.com/login.srf', { waitUntil: 'load' });

      await outPage.waitForFunction(() => Boolean(window.__outSubmission && window.__outSubmission.staySignedIn), null, { timeout: 20000 });
      const outSubmitted = await outPage.evaluate(() => window.__outSubmission);

      assert.equal(outSubmitted.email, 'bob.e2e@outlook.com', 'Outlook email should be typed into #i0116');
      assert.equal(outSubmitted.password, 'BobSecurePassword!88', 'Outlook password should be typed into #i0118');

      const expectedOutTotp = generateTOTP(outAccount.twoFa);
      assert.equal(outSubmitted.totp, expectedOutTotp, 'Outlook OTC code must match generateTOTP(secret)');
      assert.equal(outSubmitted.staySignedIn, true, 'Outlook stay signed in prompt should be auto-accepted');

      await outPage.close();
    });

    await t.test('1.3 login-driver.js: Yahoo multi-step login with username, password, and post-login prompt dismissal', async () => {
      const yahooAccount = {
        email: 'carol.e2e@yahoo.com',
        password: 'CarolSecurePassword!77'
      };

      await sw.evaluate(async (acc) => {
        await chrome.storage.local.set({
          rpa_email: acc.email,
          rpa_password: acc.password,
          rpa_twoFa: ''
        });
      }, yahooAccount);

      await context.route('https://login.yahoo.com/**', (route) => {
        route.fulfill({
          status: 200,
          contentType: 'text/html',
          body: `<!doctype html><html><head><title>Yahoo Sign in</title></head><body>
            <div id="y-step-user" style="display:block; padding:20px;">
              <input id="login-username" name="username" type="text" style="width:240px; height:32px; display:block;" placeholder="Username, email, or mobile" />
              <button id="login-signin" type="submit" style="width:80px; height:32px; display:block; margin-top:10px;">Next</button>
            </div>

            <div id="y-step-pass" style="display:none; padding:20px;">
              <input id="login-passwd" name="password" type="password" style="width:240px; height:32px; display:block;" placeholder="Password" />
              <button id="login-signin-pass" type="submit" style="width:80px; height:32px; display:block; margin-top:10px;">Next</button>
            </div>

            <div id="y-step-prompt" style="display:none; padding:20px;">
              <h2>Protect your account</h2>
              <button id="remindBtn" type="button" style="width:120px; height:32px; display:block;">Remind me later</button>
            </div>

            <script>
              window.__ySubmission = {};
              document.getElementById('login-signin').addEventListener('click', function (e) {
                e.preventDefault();
                window.__ySubmission.username = document.getElementById('login-username').value;
                document.getElementById('y-step-user').style.display = 'none';
                document.getElementById('y-step-pass').style.display = 'block';
                document.getElementById('login-signin-pass').id = 'login-signin';
              });

              document.addEventListener('click', function (e) {
                if (e.target && e.target.id === 'login-signin' && document.getElementById('login-passwd') && document.getElementById('login-passwd').value) {
                  e.preventDefault();
                  window.__ySubmission.password = document.getElementById('login-passwd').value;
                  document.getElementById('y-step-pass').style.display = 'none';
                  document.getElementById('y-step-prompt').style.display = 'block';
                }
              });

              document.getElementById('remindBtn').addEventListener('click', function (e) {
                e.preventDefault();
                window.__ySubmission.promptDismissed = true;
              });
            </script>
          </body></html>`
        });
      });

      const yPage = await context.newPage();
      await yPage.goto('https://login.yahoo.com/', { waitUntil: 'load' });

      await yPage.waitForFunction(() => Boolean(window.__ySubmission && window.__ySubmission.promptDismissed), null, { timeout: 20000 });
      const ySubmitted = await yPage.evaluate(() => window.__ySubmission);

      assert.equal(ySubmitted.username, 'carol.e2e@yahoo.com', 'Yahoo username should be typed into #login-username');
      assert.equal(ySubmitted.password, 'CarolSecurePassword!77', 'Yahoo password should be typed into #login-passwd');
      assert.equal(ySubmitted.promptDismissed, true, 'Post-login prompt Remind me later should be dismissed');

      await yPage.close();
    });

    // ─────────────────────────────────────────────────────────────────────────────
    // 2. Error classification and suspension detection (fatal severity)
    // ─────────────────────────────────────────────────────────────────────────────
    await t.test('2.1 login-driver.js: Wrong password banner detection generates fatal verification status and TASK_STATUS_UPDATE', async () => {
      const wrongPassAccount = {
        email: 'wrongpass.user@gmail.com',
        password: 'DefectivePassword123!',
        twoFa: ''
      };

      await sw.evaluate(async (acc) => {
        await chrome.storage.local.set({
          rpa_email: acc.email,
          rpa_password: acc.password,
          rpa_twoFa: ''
        });
      }, wrongPassAccount);

      await context.route('https://accounts.google.com/signin/v2/challenge/pwd**', (route) => {
        route.fulfill({
          status: 200,
          contentType: 'text/html',
          body: `<!doctype html><html><head><title>Sign in - Wrong Password</title></head><body>
            <div id="pwdContainer" style="padding:20px;">
              <input name="Passwd" type="password" style="width:240px; height:32px; display:block;" placeholder="Password" />
              <button id="passwordNext" type="button" style="width:80px; height:32px; display:block; margin-top:10px;">Next</button>
              <div id="wrongPassBanner" jsname="B34EJ" role="alert" style="display:none; color:red; margin-top:10px;">
                Wrong password. Try again or click Forgot password to reset it.
              </div>
            </div>
            <script>
              document.getElementById('passwordNext').addEventListener('click', function () {
                document.getElementById('wrongPassBanner').style.display = 'block';
              });
            </script>
          </body></html>`
        });
      });

      const errPage = await context.newPage();
      await errPage.goto('https://accounts.google.com/signin/v2/challenge/pwd', { waitUntil: 'load' });

      // Poll service worker verificationStatuses for fatal error record
      let wrongPassStatus = null;
      for (let i = 0; i < 40; i++) {
        wrongPassStatus = await sw.evaluate(async () => {
          const ses = await getSession(['verificationStatuses']);
          return ses.verificationStatuses?.['wrongpass.user@gmail.com'] || null;
        });
        if (wrongPassStatus) break;
        await new Promise((r) => setTimeout(r, 150));
      }

      assert.ok(wrongPassStatus, 'Expected verification status to be recorded for wrong password account');
      assert.equal(wrongPassStatus.severity, 'fatal', 'Wrong password error must be classified with severity: fatal');
      assert.ok(/gid-err-fatal|wrong password/i.test(wrongPassStatus.statusText || wrongPassStatus.code));

      // Verify TASK_STATUS_UPDATE was sent over WebSocket with status FAILED
      const failedTaskUpdate = receivedTaskEvents.find(
        (e) => (e.email === 'wrongpass.user@gmail.com' || e.accountId === 'wrongpass.user@gmail.com') && e.status === 'FAILED'
      );
      assert.ok(failedTaskUpdate, 'Server must receive TASK_STATUS_UPDATE with status: FAILED');
      assert.match(failedTaskUpdate.errorMessage || failedTaskUpdate.step, /wrong password/i);

      await errPage.close();
    });

    await t.test('2.2 support-driver.js: Account suspended / disabled screen detection reports fatal severity', async () => {
      const suspendedEmail = 'suspended.account@gmail.com';

      await context.route('https://support.google.com/**', (route) => {
        route.fulfill({
          status: 200,
          contentType: 'text/html',
          body: `<!doctype html><html><head><title>Account Disabled - Google Support</title></head><body>
            <div style="padding:30px;">
              <h1>Your account has been disabled</h1>
              <p>It looks like the account ${suspendedEmail} was used in violation of Google policies.</p>
              <p>To try to restore access to your account, submit an appeal.</p>
            </div>
          </body></html>`
        });
      });

      const supPage = await context.newPage();
      await supPage.goto('https://support.google.com/accounts/answer/40695', { waitUntil: 'domcontentloaded' });

      let suspendedRecord = null;
      for (let i = 0; i < 40; i++) {
        suspendedRecord = await sw.evaluate(async (email) => {
          const ses = await getSession(['verificationStatuses']);
          return ses.verificationStatuses?.[email] || null;
        }, suspendedEmail);
        if (suspendedRecord) break;
        await new Promise((r) => setTimeout(r, 150));
      }

      assert.ok(suspendedRecord, 'support-driver.js must record verification status for suspended account');
      assert.equal(suspendedRecord.severity, 'fatal', 'Suspension detection must have severity: fatal');
      assert.match(suspendedRecord.code, /account_suspended|account suspended/i);
      assert.match(suspendedRecord.statusText, /account has been disabled|account suspended/i);

      // Verify TASK_STATUS_UPDATE with status: BLOCKED received on server
      const blockedTaskUpdate = receivedTaskEvents.find(
        (e) => (e.email === suspendedEmail || e.accountId === suspendedEmail) && e.status === 'BLOCKED'
      );
      assert.ok(blockedTaskUpdate, 'Server must receive TASK_STATUS_UPDATE with status: BLOCKED');
      assert.equal(blockedTaskUpdate.step, 'Account Suspended');

      await supPage.close();
    });

    // ─────────────────────────────────────────────────────────────────────────────
    // 3. Verification code handling: SMS challenge & VerificationPool
    // ─────────────────────────────────────────────────────────────────────────────
    await t.test('3. Verification code handling: SMS phone prompt challenge resolution via VerificationPool', async () => {
      const smsAccount = {
        email: 'sms.challenge@gmail.com',
        password: 'SmsSecretPassword!123'
      };

      // Sync SMS phone pool number into extension VerificationPool pointing to our mock SMS server
      const testPhone = '+15550198765';
      mockSmsCode = '918273';
      const syncResult = await sw.evaluate(async (payload) => {
        const result = verificationPool.syncFromString(`${payload.phone}|${payload.url}`);
        await saveVerificationPool();
        return { ok: true, result, stats: verificationPool.getStats(), items: verificationPool.toJSON() };
      }, { phone: testPhone, url: mockSmsUrl });

      assert.ok(syncResult.ok, 'SMS pool sync must succeed');
      assert.equal(syncResult.stats.total, 1);

      await sw.evaluate(async (acc) => {
        await chrome.storage.local.set({
          rpa_email: acc.email,
          rpa_password: acc.password,
          rpa_twoFa: ''
        });
      }, smsAccount);

      // Route Google signin with SMS phone prompt followed by PIN entry
      await context.route('https://accounts.google.com/signin/v2/challenge/selection**', (route) => {
        route.fulfill({
          status: 200,
          contentType: 'text/html',
          body: `<!doctype html><html><head><title>Verify your identity - Google Accounts</title></head><body>
            <div id="sms-phone-stage" style="display:block; padding:20px;">
              <h2>Verify it's you</h2>
              <input id="phoneNumberId" type="tel" name="phoneNumber" style="width:240px; height:32px; display:block;" placeholder="Phone number" />
              <div id="idvanyphonecollectNext">
                <button type="button" style="width:100px; height:32px; display:block; margin-top:10px;">Send code</button>
              </div>
            </div>

            <div id="sms-pin-stage" style="display:none; padding:20px;">
              <h2>Enter 6-digit code</h2>
              <input id="idvAnyPhonePin" type="text" name="idvAnyPhonePin" style="width:240px; height:32px; display:block;" placeholder="G-XXXXXX" />
              <div id="idvanyphoneverifyNext">
                <button type="button" style="width:100px; height:32px; display:block; margin-top:10px;">Verify</button>
              </div>
            </div>

            <div id="sms-success" style="display:none; padding:20px;">
              <div gh="cm" role="button" style="width:80px; height:32px; display:block;">Compose</div>
            </div>

            <script>
              window.__smsChallengeData = {};
              document.querySelector('#idvanyphonecollectNext button').addEventListener('click', function () {
                window.__smsChallengeData.phoneEntered = document.getElementById('phoneNumberId').value;
                document.getElementById('sms-phone-stage').style.display = 'none';
                document.getElementById('sms-pin-stage').style.display = 'block';
              });

              document.querySelector('#idvanyphoneverifyNext button').addEventListener('click', function () {
                window.__smsChallengeData.pinEntered = document.getElementById('idvAnyPhonePin').value;
                document.getElementById('sms-pin-stage').style.display = 'none';
                document.getElementById('sms-success').style.display = 'block';
              });
            </script>
          </body></html>`
        });
      });

      const smsPage = await context.newPage();
      await smsPage.goto('https://accounts.google.com/signin/v2/challenge/selection', { waitUntil: 'load' });

      // Wait for login-driver to detect phone input, claim pool item, fetch OTP, and enter PIN
      await smsPage.waitForFunction(() => Boolean(window.__smsChallengeData && window.__smsChallengeData.pinEntered), null, { timeout: 25000 });
      const challengeOutcome = await smsPage.evaluate(() => window.__smsChallengeData);

      assert.equal(challengeOutcome.phoneEntered, testPhone, 'login-driver must enter the phone claimed from VerificationPool');
      assert.equal(challengeOutcome.pinEntered, mockSmsCode, 'login-driver must fetch and enter the exact SMS OTP received from mock endpoint');

      // Poll VerificationPool state until item transitions to status: verified
      let verifiedItem = null;
      for (let i = 0; i < 30; i++) {
        const poolState = await sw.evaluate(() => {
          return { ok: true, stats: verificationPool.getStats(), items: verificationPool.toJSON() };
        });
        verifiedItem = poolState.items.find((it) => it.phone === testPhone);
        if (verifiedItem && verifiedItem.status === 'verified') break;
        await new Promise((r) => setTimeout(r, 150));
      }

      assert.ok(verifiedItem, 'Claimed phone item must exist in VerificationPool');
      assert.equal(verifiedItem.status, 'verified', 'VerificationPool item must transition to status: verified');

      await smsPage.close();
    });

    // ─────────────────────────────────────────────────────────────────────────────
    // 4. drive-driver.js & gds-driver.js: Drive Link Sharing & Google Docs Workflow
    // ─────────────────────────────────────────────────────────────────────────────
    await t.test('4.1 drive-driver.js: Google Drive & Docs link sharing permissions workflow', async () => {
      const publicSharingUrl = 'https://drive.google.com/file/d/1X9yZ_e2e_doc_shared/view?usp=sharing';

      await context.route('https://drive.google.com/**', (route) => {
        route.fulfill({
          status: 200,
          contentType: 'text/html',
          body: `<!doctype html><html><head><title>Quarterly Report - Google Drive</title></head><body>
            <button id="mainShareBtn" aria-label="Share" type="button" style="width:100px; height:36px; display:block;" onclick="
              document.getElementById('driveShareModal').style.display = 'block';
            ">Share</button>

            <div id="driveShareModal" style="display:none; padding:20px; border:1px solid #ddd;">
              <button id="accessTrigger" role="combobox" type="button" style="width:180px; height:32px; display:block;" onclick="
                document.getElementById('accessOptions').style.display = 'block';
              ">Restricted</button>

              <div id="accessOptions" style="display:none;">
                <div role="option" class="anyone-option" style="padding:8px; cursor:pointer;" onclick="
                  document.getElementById('accessOptions').style.display = 'none';
                  document.getElementById('accessTrigger').textContent = 'Anyone with the link';
                  document.getElementById('shareUrlInput').value = '${publicSharingUrl}';
                ">Anyone with the link</div>
              </div>

              <input id="shareUrlInput" type="url" readonly value="" style="width:300px; height:32px; display:block; margin-top:10px;" />
              <button id="copyShareBtn" type="button" style="width:90px; height:32px; display:inline-block; margin-top:10px;">Copy link</button>
              <button id="doneShareBtn" type="button" style="width:80px; height:32px; display:inline-block; margin-top:10px;">Done</button>
            </div>

            <script>
              window.__driveWorkflow = {};
              document.getElementById('copyShareBtn').addEventListener('click', function () {
                window.__driveWorkflow.copiedUrl = document.getElementById('shareUrlInput').value;
              });
              document.getElementById('doneShareBtn').addEventListener('click', function () {
                window.__driveWorkflow.doneClicked = true;
                document.getElementById('driveShareModal').style.display = 'none';
              });
            </script>
          </body></html>`
        });
      });

      const drivePage = await context.newPage();
      await drivePage.goto('https://drive.google.com/file/d/1X9yZ_e2e_doc_shared/view', { waitUntil: 'load' });
      await drivePage.waitForTimeout(300);

      // Trigger DRIVE_AUTO_SHARE through extension message passing
      const shareResult = await sw.evaluate(async () => {
        const tabs = await chrome.tabs.query({ url: 'https://drive.google.com/*' });
        return chrome.tabs.sendMessage(tabs[0].id, { action: 'DRIVE_AUTO_SHARE' });
      });

      assert.equal(shareResult.ok, true, 'drive-driver.js should succeed auto-sharing');
      assert.equal(shareResult.url, publicSharingUrl, 'Returned link must match the Anyone with the link public sharing URL');

      const driveWorkflowState = await drivePage.evaluate(() => window.__driveWorkflow);
      assert.equal(driveWorkflowState.copiedUrl, publicSharingUrl, 'Copy link button must be clicked with public URL');
      assert.equal(driveWorkflowState.doneClicked, true, 'Done button must be clicked to dismiss modal');

      await drivePage.close();
    });

    await t.test('4.2 gds-driver.js: Google Device Setup auto-skipping and TASK_STATUS_UPDATE', async () => {
      await context.route('https://gds.google.com/**', (route) => {
        route.fulfill({
          status: 200,
          contentType: 'text/html',
          body: `<!doctype html><html><head><title>Google Device Setup</title></head><body>
            <div style="padding:30px;">
              <h1>Device setup</h1>
              <p>Keep your Google Workspace and devices synchronized.</p>
              <button class="VfPpkd-Jh9lGc" role="button" id="gdsSkipButton" style="width:120px; height:36px; display:block;">Not now</button>
            </div>
            <script>
              window.__gdsSkippedClicked = false;
              document.getElementById('gdsSkipButton').addEventListener('click', function () {
                window.__gdsSkippedClicked = true;
              });
            </script>
          </body></html>`
        });
      });

      const gdsPage = await context.newPage();
      await gdsPage.goto('https://gds.google.com/u/0/flow-setup', { waitUntil: 'domcontentloaded' });

      // gds-driver.js automatically executes trySkipGds in a loop
      await gdsPage.waitForFunction(() => window.__gdsSkippedClicked === true, null, { timeout: 12000 });

      // Verify service worker recorded lastGdsSkipped
      let lastGds = null;
      for (let i = 0; i < 30; i++) {
        lastGds = await sw.evaluate(async () => (await getSession(['lastGdsSkipped'])).lastGdsSkipped);
        if (lastGds) break;
        await new Promise((r) => setTimeout(r, 100));
      }

      assert.ok(lastGds, 'Service worker must record lastGdsSkipped entry');
      assert.match(lastGds.url, /gds\.google\.com/);

      // Verify WebSocket TASK_STATUS_UPDATE with status: GDS_SKIPPED was sent to controller
      const gdsTaskUpdate = receivedTaskEvents.find((e) => e.status === 'GDS_SKIPPED');
      assert.ok(gdsTaskUpdate, 'Server must receive TASK_STATUS_UPDATE with status: GDS_SKIPPED');
      assert.equal(gdsTaskUpdate.step, 'GDS Skipped');

      await gdsPage.close();
    });

    // ─────────────────────────────────────────────────────────────────────────────
    // 5. accept-consent.js: Cookie consent detection and auto-acceptance
    // ─────────────────────────────────────────────────────────────────────────────
    await t.test('5.1 accept-consent.js: Consent modal detection and two-step auto-acceptance (#mail-accept-all-2 & done-button)', async () => {
      await context.route('https://consent.yahoo.com/**', (route) => {
        route.fulfill({
          status: 200,
          contentType: 'text/html',
          body: `<!doctype html><html><head><title>Yahoo Cookie Consent</title></head><body>
            <div class="consent-overlay" style="padding:30px;">
              <h2>Before you continue</h2>
              <p>We use cookies to deliver our services and analyze usage.</p>
              <button id="mail-accept-all-2" type="button" style="width:120px; height:36px; display:block;">Accept all</button>
              <div class="actions single" style="margin-top:15px;">
                <button type="submit" class="done-button" disabled style="width:80px; height:32px; display:block;">Done</button>
              </div>
            </div>
            <script>
              window.__consentLog = {};
              document.getElementById('mail-accept-all-2').addEventListener('click', function () {
                window.__consentLog.acceptedAll = true;
                // Enable follow-up submit button as standard consent forms do
                document.querySelector('.done-button').disabled = false;
              });
              document.querySelector('.done-button').addEventListener('click', function (e) {
                e.preventDefault();
                window.__consentLog.doneConfirmed = true;
              });
            </script>
          </body></html>`
        });
      });

      const consentPage = await context.newPage();
      await consentPage.goto('https://consent.yahoo.com/v2/collectConsent', { waitUntil: 'domcontentloaded' });

      // accept-consent.js scans, clicks #mail-accept-all-2, and then triggers .done-button after 700ms
      await consentPage.waitForFunction(() => Boolean(window.__consentLog && window.__consentLog.doneConfirmed), null, { timeout: 10000 });
      const log = await consentPage.evaluate(() => window.__consentLog);

      assert.equal(log.acceptedAll, true, 'accept-consent.js must auto-click #mail-accept-all-2');
      assert.equal(log.doneConfirmed, true, 'accept-consent.js must follow up with .done-button click');

      await consentPage.close();
    });

    await t.test('5.2 accept-consent.js: OAuth consent agreement on guce.yahoo.com (button[name="agree"])', async () => {
      await context.route('https://guce.yahoo.com/**', (route) => {
        route.fulfill({
          status: 200,
          contentType: 'text/html',
          body: `<!doctype html><html><head><title>OAuth Privacy & Consent</title></head><body>
            <div class="oauth-consent" style="padding:30px;">
              <h2>Data Privacy Agreement</h2>
              <button name="agree" value="agree" type="button" style="width:140px; height:36px; display:block;">Agree & Proceed</button>
            </div>
            <script>
              window.__oauthAgreed = false;
              document.querySelector('button[name="agree"]').addEventListener('click', function () {
                window.__oauthAgreed = true;
              });
            </script>
          </body></html>`
        });
      });

      const gucePage = await context.newPage();
      await gucePage.goto('https://guce.yahoo.com/consent', { waitUntil: 'domcontentloaded' });

      await gucePage.waitForFunction(() => window.__oauthAgreed === true, null, { timeout: 10000 });
      assert.equal(await gucePage.evaluate(() => window.__oauthAgreed), true, 'accept-consent.js must auto-click button[name="agree"]');

      await gucePage.close();
    });

  } finally {
    await context.close();
    await app.stop();
    await new Promise((resolve) => smsServer.close(resolve));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
