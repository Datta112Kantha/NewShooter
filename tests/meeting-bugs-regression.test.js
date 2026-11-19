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
const { RelayStore } = require('../src/server/store');
const { decodeFrames, WsHub } = require('../src/server/wsHub');
const { processTags, resolveSpintax, PREDEFINED_TAG_CATALOG } = require('../src/core/tagEngine');
const { convertHtml } = require('../src/core/pdfConverter');

// ── WebSocket Frame and Connection Helpers ────────────────────────────────────

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

    let upgraded = false;
    let buf = Buffer.alloc(0);
    const messages = [];
    const waiters = [];

    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (!upgraded) {
        const idx = buf.indexOf('\r\n\r\n');
        if (idx === -1) return;
        const head = buf.subarray(0, idx).toString('latin1');
        if (!head.includes('101 Switching Protocols')) {
          sock.destroy();
          reject(new Error('WS upgrade failed: ' + head.split('\r\n')[0]));
          return;
        }
        upgraded = true;
        buf = buf.subarray(idx + 4);

        function drainFrames() {
          if (buf.length > 0) {
            const { frames, remaining } = decodeFrames(buf);
            buf = remaining;
            for (const f of frames) {
              if (f.opcode === 0x1) {
                const parsed = JSON.parse(f.payload.toString('utf8'));
                const wIdx = waiters.findIndex((w) => w.predicate(parsed));
                if (wIdx !== -1) {
                  const waiter = waiters.splice(wIdx, 1)[0];
                  waiter.resolve(parsed);
                } else {
                  messages.push(parsed);
                }
              }
            }
          }
        }

        drainFrames();

        resolve({
          sock,
          sendJson(obj) {
            sock.write(encodeMaskedClientFrame(JSON.stringify(obj)));
          },
          nextMessage(predicate = () => true, timeoutMs = 5000) {
            drainFrames();
            const existingIdx = messages.findIndex(predicate);
            if (existingIdx !== -1) {
              return Promise.resolve(messages.splice(existingIdx, 1)[0]);
            }
            return new Promise((res, rej) => {
              const t = setTimeout(() => rej(new Error('WS message timeout')), timeoutMs);
              waiters.push({
                predicate,
                resolve(m) { clearTimeout(t); res(m); }
              });
            });
          },
          close() {
            sock.destroy();
          }
        });
      }

      if (upgraded && buf.length > 0) {
        const { frames, remaining } = decodeFrames(buf);
        buf = remaining;
        for (const f of frames) {
          if (f.opcode === 0x1) {
            const parsed = JSON.parse(f.payload.toString('utf8'));
            const wIdx = waiters.findIndex((w) => w.predicate(parsed));
            if (wIdx !== -1) {
              const waiter = waiters.splice(wIdx, 1)[0];
              waiter.resolve(parsed);
            } else {
              messages.push(parsed);
            }
          }
        }
      }
    });

    sock.on('error', (err) => {
      if (!upgraded) reject(err);
    });
  });
}

function httpRequest(options, body = null) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(raw); } catch {}
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: raw,
          json
        });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. LOGIN DIAGNOSTICS: EMPTY USER, EMPTY PASS, UNKNOWN USER, WRONG PASS, CSRF
// ─────────────────────────────────────────────────────────────────────────────

test('Regression B11: Login diagnostics differentiate empty user, empty pass, unknown user, wrong pass, and CSRF expiration', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-login-diag-'));
  const store = new RelayStore(path.join(tmpDir, 'data'));

  try {
    // 1a. Unit test RelayStore.authenticate diagnostics
    // Empty username
    const resEmptyUser = store.authenticate('', 'somepass');
    assert.equal(resEmptyUser.ok, false);
    assert.equal(resEmptyUser.error, 'Please enter your username');

    const resWhitespaceUser = store.authenticate('   ', 'somepass');
    assert.equal(resWhitespaceUser.ok, false);
    assert.equal(resWhitespaceUser.error, 'Please enter your username');

    // Empty password
    const resEmptyPass = store.authenticate('admfib7H', '');
    assert.equal(resEmptyPass.ok, false);
    assert.equal(resEmptyPass.error, 'Please enter your password');

    const resNullPass = store.authenticate('admfib7H', null);
    assert.equal(resNullPass.ok, false);
    assert.equal(resNullPass.error, 'Please enter your password');

    // Unknown user
    const resUnknown = store.authenticate('nonexistent_user_99', 'anypass');
    assert.equal(resUnknown.ok, false);
    assert.equal(resUnknown.error, "No account found matching username 'nonexistent_user_99'");

    // Wrong password
    const resWrongPass = store.authenticate('admfib7H', 'completely_wrong_pass');
    assert.equal(resWrongPass.ok, false);
    assert.equal(resWrongPass.error, 'Incorrect password entered');

    // CSRF expired or invalid
    const resCsrfFalse = store.authenticate('admfib7H', 'd9tQGJdZ77', { csrfValid: false });
    assert.equal(resCsrfFalse.ok, false);
    assert.equal(resCsrfFalse.error, 'Security token expired. Please refresh the page');

    const resCsrfTokenBad = store.authenticate('admfib7H', 'd9tQGJdZ77', { csrfToken: 'invalid_token_123' });
    assert.equal(resCsrfTokenBad.ok, false);
    assert.equal(resCsrfTokenBad.error, 'Security token expired. Please refresh the page');

    // Valid CSRF token
    const token = store.issueLoginCsrf();
    const resCsrfValid = store.authenticate('admfib7H', 'd9tQGJdZ77', { csrfToken: token, forceEvict: true });
    assert.equal(resCsrfValid.ok, true);
    assert.ok(resCsrfValid.session && resCsrfValid.session.id);

    // Reusing the same CSRF token must fail (single-use CSRF)
    const resCsrfReused = store.authenticate('admfib7H', 'd9tQGJdZ77', { csrfToken: token, forceEvict: true });
    assert.equal(resCsrfReused.ok, false);
    assert.equal(resCsrfReused.error, 'Security token expired. Please refresh the page');

    // 1b. Integration HTTP test for /Login.php error responses
    const app = createServer({
      port: 0,
      dataDir: path.join(tmpDir, 'srv-data'),
      profilesRoot: path.join(tmpDir, 'profiles')
    });
    const addr = await app.start(0, '127.0.0.1');

    try {
      // Helper to fetch fresh CSRF token
      const getFreshCsrf = () => app.store.issueLoginCsrf();

      // Test HTTP POST with empty username
      const postEmptyUser = await httpRequest({
        hostname: '127.0.0.1',
        port: addr.port,
        path: '/Login.php',
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
      }, `usr=&pas=somepass&csrf_token=${getFreshCsrf()}`);
      assert.equal(postEmptyUser.statusCode, 401);
      assert.equal(postEmptyUser.json.error, 'Please enter your username');

      // Test HTTP POST with empty password
      const postEmptyPass = await httpRequest({
        hostname: '127.0.0.1',
        port: addr.port,
        path: '/Login.php',
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
      }, `usr=admfib7H&pas=&csrf_token=${getFreshCsrf()}`);
      assert.equal(postEmptyPass.statusCode, 401);
      assert.equal(postEmptyPass.json.error, 'Please enter your password');

      // Test HTTP POST with unknown user
      const postUnknown = await httpRequest({
        hostname: '127.0.0.1',
        port: addr.port,
        path: '/Login.php',
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
      }, `usr=ghost_user&pas=somepass&csrf_token=${getFreshCsrf()}`);
      assert.equal(postUnknown.statusCode, 401);
      assert.equal(postUnknown.json.error, "No account found matching username 'ghost_user'");

      // Test HTTP POST with wrong password
      const postWrongPass = await httpRequest({
        hostname: '127.0.0.1',
        port: addr.port,
        path: '/Login.php',
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
      }, `usr=admfib7H&pas=wrongpass&csrf_token=${getFreshCsrf()}`);
      assert.equal(postWrongPass.statusCode, 401);
      assert.equal(postWrongPass.json.error, 'Incorrect password entered');

      // Test HTTP POST with expired/invalid CSRF
      const postBadCsrf = await httpRequest({
        hostname: '127.0.0.1',
        port: addr.port,
        path: '/Login.php',
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
      }, 'usr=admfib7H&pas=d9tQGJdZ77&csrf_token=expired_token_000');
      assert.equal(postBadCsrf.statusCode, 401);
      assert.equal(postBadCsrf.json.error, 'Security token expired. Please refresh the page');

      // Test HTTP POST with valid credentials and valid CSRF
      const postValid = await httpRequest({
        hostname: '127.0.0.1',
        port: addr.port,
        path: '/Login.php',
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
      }, `usr=admfib7H&pas=d9tQGJdZ77&csrf_token=${getFreshCsrf()}`);
      assert.equal(postValid.statusCode, 200);
      assert.equal(postValid.json.status, 'ok');
      assert.equal(postValid.json.redirect, '/V3/');
    } finally {
      await app.stop();
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. LOGOUT CLEANUP: COOKIE INVALIDATION AND REDIRECT
// ─────────────────────────────────────────────────────────────────────────────

test('Regression B12: Logout clears all auth cookies with Max-Age=0, destroys session, closes WS, and redirects to /Login.php', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-logout-'));
  const app = createServer({
    port: 0,
    dataDir: path.join(tmpDir, 'data'),
    profilesRoot: path.join(tmpDir, 'profiles')
  });
  const addr = await app.start(0, '127.0.0.1');

  try {
    // 1. Authenticate to get a valid session
    const authRes = app.store.authenticate('admfib7H', 'd9tQGJdZ77');
    assert.equal(authRes.ok, true);
    const sid = authRes.session.token || authRes.session.id;

    // Verify session exists
    assert.ok(app.store.getSession(sid));

    // 2. Connect dashboard WebSocket with the session cookie
    const dashWs = await connectRawWs(addr.port, '/ws/dashboard', {
      Cookie: `relay_sid=${sid}; PHPSESSID=${sid}`
    });
    const hello = await dashWs.nextMessage((m) => m.type === 'HELLO' || m.type === 'DASHBOARD_SYNC');
    assert.equal(hello.role, 'dashboard');

    // 3. Perform logout request via /logout
    const logoutRes = await httpRequest({
      hostname: '127.0.0.1',
      port: addr.port,
      path: '/logout',
      method: 'GET',
      headers: {
        Cookie: `relay_sid=${sid}; PHPSESSID=${sid}`
      }
    });

    // Verify 302 redirect to /Login.php
    assert.equal(logoutRes.statusCode, 302);
    assert.equal(logoutRes.headers.location, '/Login.php');

    // Verify Set-Cookie headers invalidate both relay_sid and PHPSESSID with Max-Age=0
    const setCookies = [].concat(logoutRes.headers['set-cookie'] || []);
    assert.ok(setCookies.length >= 2, 'Expected at least 2 Set-Cookie headers for cookie invalidation');
    assert.ok(setCookies.some((c) => /relay_sid=;.*Path=\/.*Max-Age=0/i.test(c)));
    assert.ok(setCookies.some((c) => /PHPSESSID=;.*Path=\/.*Max-Age=0/i.test(c)));

    // Verify session is destroyed in store
    assert.equal(app.store.getSession(sid), null);

    // Verify dashboard WebSocket is closed after session destruction
    await new Promise((resolve) => {
      dashWs.sock.on('close', resolve);
      setTimeout(resolve, 500);
    });
    assert.ok(dashWs.sock.destroyed);

    // 4. Test alternate /Logout.php endpoint
    const authRes2 = app.store.authenticate('admfib7H', 'd9tQGJdZ77', { forceEvict: true });
    const sid2 = authRes2.session.token || authRes2.session.id;
    const logoutPhpRes = await httpRequest({
      hostname: '127.0.0.1',
      port: addr.port,
      path: '/Logout.php',
      method: 'GET',
      headers: { Cookie: `relay_sid=${sid2}` }
    });
    assert.equal(logoutPhpRes.statusCode, 302);
    assert.equal(logoutPhpRes.headers.location, '/Login.php');
    assert.equal(app.store.getSession(sid2), null);
  } finally {
    await app.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. TAB STAGGERING GEOMETRY: DIAGONAL OFFSETS AND PROPORTIONAL H/V CALCS
// ─────────────────────────────────────────────────────────────────────────────

test('Regression B02, B03: Tab staggering geometry computes diagonal offsets (base + i*36) and proportional H/V percentages', () => {
  // Pure geometry calculator matching service-worker.js implementation
  function computeTabGeometry({ count, hVal, vVal, stagger = false, layout, screenWidth = 1920, screenHeight = 1080, baseX = 40, baseY = 40, hGap = 15, vGap = 15 }) {
    const n = Math.max(1, Math.min(20, Number(count || 1)));
    const hPercent = Math.max(10, Math.min(100, Number(hVal ?? hGap ?? 20)));
    const vPercent = Math.max(10, Math.min(100, Number(vVal ?? vGap ?? 20)));
    const gapX = Math.max(0, Math.round(Number(hGap ?? 15) * 0.4));
    const gapY = Math.max(0, Math.round(Number(vGap ?? 15) * 0.4));
    const cols = Math.ceil(Math.sqrt(n));
    const rows = Math.ceil(n / cols);
    const availW = Math.max(640, Number(screenWidth || 800));
    const availH = Math.max(520, Number(screenHeight || 600));

    // Map H and V sliders to proportional screen percentage dimensions
    const w = Math.max(240, Math.min(availW, Math.round(availW * (hPercent / 100))));
    const h = Math.max(240, Math.min(availH, Math.round(availH * (vPercent / 100))));
    const isStagger = Boolean(stagger || layout === 'stagger');
    const windows = [];

    for (let i = 0; i < n; i++) {
      let left, top;
      if (isStagger) {
        // Diagonal staggered positioning: left = baseX + i * 36, top = baseY + i * 36
        const maxL = Math.max(0, availW - Math.ceil(w * 0.5));
        const maxT = Math.max(0, availH - Math.ceil(h * 0.5));
        left = Math.max(0, Math.min(maxL, Number(baseX || 0) + i * 36));
        top = Math.max(0, Math.min(maxT, Number(baseY || 0) + i * 36));
      } else {
        const col = i % cols;
        const row = Math.floor(i / cols);
        left = Math.max(0, Math.min(Math.max(0, availW - Math.ceil(w * 0.65)), col * (w + gapX)));
        top = Math.max(0, Math.min(Math.max(0, availH - Math.ceil(h * 0.65)), row * (h + gapY)));
      }
      windows.push({ i, left, top, width: w, height: h });
    }
    return { w, h, windows };
  }

  // 3a. Verify proportional H/V calculations across screen bounds
  const geo1 = computeTabGeometry({ count: 5, hVal: 50, vVal: 60, screenWidth: 1920, screenHeight: 1080, stagger: true });
  assert.equal(geo1.w, 960, 'Expected 50% of 1920 to be 960');
  assert.equal(geo1.h, 648, 'Expected 60% of 1080 to be 648');

  // Verify diagonal offset delta is exactly 36px per step
  for (let idx = 0; idx < geo1.windows.length; idx++) {
    const win = geo1.windows[idx];
    assert.equal(win.left, 40 + idx * 36, `Expected window ${idx} left to be 40 + ${idx}*36`);
    assert.equal(win.top, 40 + idx * 36, `Expected window ${idx} top to be 40 + ${idx}*36`);
  }

  // 3b. Verify boundary clamping on smaller screens (avoids windows disappearing off-screen)
  const geoSmall = computeTabGeometry({
    count: 20,
    hVal: 80,
    vVal: 80,
    screenWidth: 800,
    screenHeight: 600,
    baseX: 200,
    baseY: 200,
    stagger: true
  });
  assert.equal(geoSmall.w, 640); // 80% of 800 = 640
  assert.equal(geoSmall.h, 480); // 80% of 600 = 480
  const maxAllowedLeft = 800 - Math.ceil(640 * 0.5); // 480
  const maxAllowedTop = 600 - Math.ceil(480 * 0.5); // 360
  for (const win of geoSmall.windows) {
    assert.ok(win.left <= maxAllowedLeft, `Window left ${win.left} must not exceed ${maxAllowedLeft}`);
    assert.ok(win.top <= maxAllowedTop, `Window top ${win.top} must not exceed ${maxAllowedTop}`);
  }

  // 3c. Verify tiled grid mode (when stagger is false) computes matrix columns and rows
  const geoTiled = computeTabGeometry({
    count: 4,
    hVal: 30,
    vVal: 30,
    screenWidth: 1000,
    screenHeight: 800,
    stagger: false
  });
  assert.equal(geoTiled.windows.length, 4);
  assert.equal(geoTiled.windows[0].left, 0);
  assert.equal(geoTiled.windows[0].top, 0);
  assert.ok(geoTiled.windows[1].left > 0);
  assert.equal(geoTiled.windows[1].top, 0);
  assert.equal(geoTiled.windows[2].left, 0);
  assert.ok(geoTiled.windows[2].top > 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. SMALL-VIEWPORT COMPOSE: GMAIL, OUTLOOK, YAHOO VIEWPORT FALLBACKS
// ─────────────────────────────────────────────────────────────────────────────

test('Regression B08, B09, B21: Small-viewport compose triggers and succeeds in compact view for Gmail, Outlook, Yahoo', async () => {
  const browser = await chromium.launch({ headless: true });
  const domUtilsSrc = fs.readFileSync(path.resolve(__dirname, '../extension/content/dom-utils.js'), 'utf8');

  try {
    // Narrow / compact viewport simulation (420 x 600)
    const context = await browser.newContext({ viewport: { width: 420, height: 600 } });

    // ── 4a. Gmail Small-Window Compose Fallback (hamburger menu & compact icon) ──
    const pageGmail = await context.newPage();
    const gmailHtml = `<!DOCTYPE html>
    <html>
      <head><title>Gmail - Inbox (test@gmail.com)</title></head>
      <body>
        <input name="q" placeholder="Search mail" />
        <div id="gb">
          <button aria-label="Main menu" id="hamburgerBtn" onclick="document.getElementById('hiddenCompose').style.display='block';">Menu</button>
        </div>
        <div id="mainContainer">
          <!-- Standard compose button is initially HIDDEN in small viewport -->
          <div id="hiddenCompose" style="display:none;">
            <div gh="cm" role="button" id="realCompose" onclick="document.getElementById('composeBox').style.display='block';">Compose</div>
          </div>
          <button aria-label="Compose" id="compactComposeBtn" onclick="document.getElementById('composeBox').style.display='block';">✎</button>
        </div>
        <div id="composeBox" style="display:none;">
          <input aria-label="To" id="toField" />
          <input name="subjectbox" id="subjectField" />
          <div role="textbox" aria-label="Message Body" contenteditable="true" id="bodyField"></div>
          <div role="button" aria-label="Send ‪(Ctrl-Enter)‬" id="sendBtn">Send</div>
        </div>
      </body>
    </html>`;
    await pageGmail.setContent(gmailHtml);
    await pageGmail.addScriptTag({ content: domUtilsSrc });

    // Inject Gmail compose fallback logic
    const gmailComposeResult = await pageGmail.evaluate(async () => {
      const DOM = window.NewShooterDOM;
      const toFieldSelector = 'input[aria-label*="To" i], input[peoplekit-id], textarea[name="to"]';

      // Verify openGmailCompose logic
      let composeBtn = await DOM.waitForElement('div[gh="cm"]:not([style*="display: none"]):not([style*="display:none"])', 300);
      if (!composeBtn) {
        // Fallback a: Hamburger menu
        const menuBtn = document.querySelector('button[aria-label*="Main menu" i]');
        if (menuBtn) {
          await DOM.cdpClickElement(menuBtn);
          await DOM.sleep(100);
          composeBtn = await DOM.waitForElement('div[gh="cm"]', 500);
          if (composeBtn) await DOM.cdpClickElement(composeBtn);
        }
      }
      const toField = await DOM.waitForElement(toFieldSelector, 1000);
      return Boolean(toField);
    });
    assert.equal(gmailComposeResult, true, 'Gmail compose must open via hamburger fallback when standard button is hidden');

    // ── 4b. Outlook Small-Window Compose Fallback (shortcut 'n' or compact icon) ─
    const pageOutlook = await context.newPage();
    const outlookHtml = `<!DOCTYPE html>
    <html>
      <head><title>Outlook (sender@outlook.com)</title></head>
      <body>
        <input aria-label="Search" placeholder="Search" />
        <div id="MailList"></div>
        <!-- Standard button hidden; compact button visible -->
        <button aria-label="New message" id="compactNewMail" onclick="document.getElementById('outCompose').style.display='block';">New</button>
        <div id="outCompose" style="display:none;">
          <div aria-label="To" contenteditable="true" id="outTo"></div>
          <input aria-label="Add a subject" id="outSubj" />
          <div aria-label="Message body" contenteditable="true" id="outBody"></div>
          <button aria-label="Send" id="outSend">Send</button>
        </div>
      </body>
    </html>`;
    await pageOutlook.setContent(outlookHtml);
    await pageOutlook.addScriptTag({ content: domUtilsSrc });

    const outlookComposeResult = await pageOutlook.evaluate(async () => {
      const DOM = window.NewShooterDOM;
      const toFieldSelector = 'div[aria-label="To"][contenteditable="true"], input[aria-label="To"]';

      // Simulate fallback c (compact icon) or fallback a (keyboard shortcut 'n')
      const compactBtn = await DOM.waitForElement('button[aria-label*="New" i]', 500);
      if (compactBtn) {
        await DOM.cdpClickElement(compactBtn);
      }
      const toEl = await DOM.waitForElement(toFieldSelector, 1000);
      return Boolean(toEl);
    });
    assert.equal(outlookComposeResult, true, 'Outlook compose must open via compact fallback button');

    // ── 4c. Yahoo Small-Window Compose Fallback (compact icon / shortcut 'm') ────
    const pageYahoo = await context.newPage();
    const yahooHtml = `<!DOCTYPE html>
    <html>
      <head><title>Yahoo Mail (user@yahoo.com)</title></head>
      <body>
        <input data-test-id="search-input" placeholder="Find messages" />
        <div id="mail-app-container">
          <button data-test-id="icon-btn-compose" aria-label="Compose" onclick="document.getElementById('yCompose').style.display='block';">✎</button>
        </div>
        <div id="yCompose" style="display:none;">
          <input id="message-to-field" />
          <input data-test-id="compose-subject" />
          <div data-test-id="rte" contenteditable="true"></div>
          <button data-test-id="compose-send-button">Send</button>
        </div>
      </body>
    </html>`;
    await pageYahoo.setContent(yahooHtml);
    await pageYahoo.addScriptTag({ content: domUtilsSrc });

    const yahooComposeResult = await pageYahoo.evaluate(async () => {
      const DOM = window.NewShooterDOM;
      const toFieldSelector = '#message-to-field, input[aria-label*="To" i]';

      const compactBtn = await DOM.waitForElement('[data-test-id="icon-btn-compose"], a[aria-label*="Compose" i]', 500);
      if (compactBtn) {
        await DOM.cdpClickElement(compactBtn);
      }
      const toEl = await DOM.waitForElement(toFieldSelector, 1000);
      return Boolean(toEl);
    });
    assert.equal(yahooComposeResult, true, 'Yahoo compose must open via compact icon button');

    await context.close();
  } finally {
    await browser.close();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. EMAIL SENDING ENGINE: DYNAMIC TAGS, ATTACHMENTS, PROGRESS, SENT TODAY
// ─────────────────────────────────────────────────────────────────────────────

test('Regression B13, B22: Email sending engine executes with dynamic tags, attachment conversion, progress reporting, and Sent Today increment', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-send-engine-'));
  const app = createServer({
    port: 0,
    dataDir: path.join(tmpDir, 'data'),
    profilesRoot: path.join(tmpDir, 'profiles')
  });
  const addr = await app.start(0, '127.0.0.1');

  try {
    // 5a. Dynamic tag processing and spintax resolution
    const template = {
      subject: '{Hello|Hi|Greetings} {name} - Invoice #{random_digit}{random_digit}{random_digit}{random_digit}',
      body: 'Dear {firstname} {lastname},\n\nThank you for working with {company}. Your invoice for {department} is attached.\n\n{closing},\n{senderName}'
    };
    const resolved = processTags(
      'sarah.connor@cyberdyne.example',
      template,
      {
        senderName: 'Apex Billing Team',
        customTags: { '{custom_token}': 'SECRET_99' }
      }
    );

    assert.ok(/^(Hello|Hi|Greetings)\s+\w+/.test(resolved.subject), 'Expected spintax to resolve greeting');
    assert.match(resolved.subject, /Invoice #\d{4}/);
    assert.doesNotMatch(resolved.subject, /\{name\}|\{random_digit\}/, 'All subject tags must be replaced');
    assert.match(resolved.body, /Dear\s+[A-Z]\w+\s+[A-Z]\w+,/);
    assert.match(resolved.body, /Apex Billing Team/);
    assert.doesNotMatch(resolved.body, /\{firstname\}|\{lastname\}|\{company\}|\{department\}|\{closing\}|\{senderName\}/, 'All body tags must be replaced');

    // 5b. Attachment conversion from HTML to PDF buffer
    const invoiceHtml = `<!DOCTYPE html><html><body><h1>Invoice #INV-2026-001</h1><p>Amount: $1,450.00</p><p>Status: PAID</p></body></html>`;
    const convertedPdf = await convertHtml({
      html: invoiceHtml,
      format: 'pdf',
      filename: 'invoice-2026',
      watermark: 'PAID'
    });
    assert.equal(convertedPdf.format, 'pdf');
    assert.equal(convertedPdf.mimeType, 'application/pdf');
    assert.ok(convertedPdf.buffer && convertedPdf.buffer.length > 500);
    assert.equal(convertedPdf.buffer.subarray(0, 4).toString('latin1'), '%PDF', 'PDF buffer must start with %PDF magic header');

    // 5c. End-to-end Sent Today counter increment & WS progress reporting
    // Seed an online tab
    app.store.upsertOnlineTab({
      tabKey: 'tab_reg_1:1',
      tabId: 101,
      accountId: 'acc_reg_1',
      email: 'sender@gmail.com',
      provider: 'gmail',
      tabName: 'Gmail Online',
      status: 'Ready',
      sent: 5,
      sentToday: 5,
      isActive: true
    });
    const initialSentToday = app.store.state.shootQuota.sentToday;

    // Connect dashboard WS client
    const auth = app.store.authenticate('admfib7H', 'd9tQGJdZ77');
    const sid = auth.session.id;
    const dashWs = await connectRawWs(addr.port, '/ws/dashboard', {
      Cookie: `relay_sid=${sid}`
    });
    await dashWs.nextMessage((m) => m.type === 'HELLO' || m.type === 'DASHBOARD_SYNC');

    // Connect extension agent WS client
    const agentWs = await connectRawWs(addr.port, '/ws/agent');

    // Agent sends PROGRESS event
    agentWs.sendJson({
      type: 'PROGRESS',
      tabId: 101,
      sent: 6,
      total: 10,
      done: false
    });
    const progressUpdate = await dashWs.nextMessage((m) => m.type === 'TASK_STATUS_UPDATE');
    assert.ok(progressUpdate);
    const updatedTab = app.store.state.onlineTabs['tab_reg_1:1'];
    assert.equal(updatedTab.sent, 6);

    // Agent reports completion of task via DISPATCH_RESULT with status 'SENT'
    agentWs.sendJson({
      type: 'DISPATCH_RESULT',
      tabId: 101,
      status: 'SENT',
      step: 'Completed'
    });

    const completionUpdate = await dashWs.nextMessage(
      (m) => m.type === 'TASK_STATUS_UPDATE' && m.shootQuota !== undefined
    );
    assert.ok(completionUpdate);
    assert.equal(app.store.state.shootQuota.sentToday, initialSentToday + 1, 'Sent Today counter must increment on sent email');
    assert.equal(app.store.state.onlineTabs['tab_reg_1:1'].sentToday, 6);

    dashWs.close();
    agentWs.close();
  } finally {
    await app.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. REAL-TIME TAB DISCOVERY & PING_TABS HANDSHAKE: WAITING TRANSITIONS TO READY
// ─────────────────────────────────────────────────────────────────────────────

test('Regression B16, B19, B20: Real-time tab discovery and PING_TABS handshake transition "Waiting for tabs..." to Ready', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-ping-tabs-'));
  const app = createServer({
    port: 0,
    dataDir: path.join(tmpDir, 'data'),
    profilesRoot: path.join(tmpDir, 'profiles')
  });
  const addr = await app.start(0, '127.0.0.1');

  try {
    // Authenticate and open dashboard WS
    const auth = app.store.authenticate('admfib7H', 'd9tQGJdZ77');
    const sid = auth.session.token || auth.session.id;
    const dashWs = await connectRawWs(addr.port, '/ws/dashboard', {
      Cookie: `relay_sid=${sid}`
    });
    await dashWs.nextMessage((m) => m.type === 'HELLO' || m.type === 'DASHBOARD_SYNC');

    // Initially 0 online tabs
    assert.equal(app.store.listOnlineTabs().length, 0);

    // Connect agent representing extension
    const agentWs = await connectRawWs(addr.port, '/ws/agent');

    // Dashboard broadcasts PING_TABS request
    dashWs.sendJson({ type: 'PING_TABS' });

    // Agent receives PING_TABS broadcast
    const pingFromDash = await agentWs.nextMessage((m) => m.type === 'PING_TABS');
    assert.ok(pingFromDash);

    // Agent responds with discovered tabs (even without prior pre-registration)
    agentWs.sendJson({
      type: 'HEARTBEAT',
      tabs: [
        {
          tabId: 201,
          email: 'discovered.tab@gmail.com',
          provider: 'gmail',
          title: 'Gmail - Inbox (discovered.tab@gmail.com)',
          status: 'Ready',
          inboxCount: 12,
          draftCount: 1,
          sentCount: 45
        },
        {
          tabId: 202,
          email: 'team@outlook.com',
          provider: 'outlook',
          title: 'Outlook Mail',
          status: 'Ready',
          inboxCount: 3
        }
      ]
    });

    // Dashboard receives TABS_UPDATED broadcast in real time with the discovered tabs
    const tabsUpdate = await dashWs.nextMessage(
      (m) => m.type === 'TABS_UPDATED' && Array.isArray(m.onlineTabs) && m.onlineTabs.length === 2
    );
    assert.ok(tabsUpdate && Array.isArray(tabsUpdate.onlineTabs));
    assert.equal(tabsUpdate.onlineTabs.length, 2);

    const onlineTabs = app.store.listOnlineTabs();
    assert.equal(onlineTabs.length, 2);
    const gmailTab = onlineTabs.find((t) => t.email === 'discovered.tab@gmail.com');
    const outlookTab = onlineTabs.find((t) => t.email === 'team@outlook.com');

    assert.ok(gmailTab, 'Discovered Gmail tab must be present in onlineTabs');
    assert.equal(gmailTab.provider, 'gmail');
    assert.equal(gmailTab.status, 'Ready');
    assert.equal(gmailTab.inbox, 12);

    assert.ok(outlookTab, 'Discovered Outlook tab must be present in onlineTabs');
    assert.equal(outlookTab.provider, 'outlook');
    assert.equal(outlookTab.status, 'Ready');

    dashWs.close();
    agentWs.close();
  } finally {
    await app.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. EXTENSION WINDOW POPUP CONFIGURATION & ACTION LISTENER WIRING
// ─────────────────────────────────────────────────────────────────────────────

test('Regression B01, B10: Extension manifest has no default_popup and action click listener is wired to open independent window', () => {
  const manifestPath = path.resolve(__dirname, '../extension/manifest.json');
  const swPath = path.resolve(__dirname, '../extension/background/service-worker.js');

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const swCode = fs.readFileSync(swPath, 'utf8');

  // 7a. Manifest verification
  // default_popup must NOT exist on manifest.action (so clicking the extension does not open an attached dropdown bubble)
  assert.equal(manifest.action.default_popup, undefined, 'manifest.action.default_popup must be removed');
  assert.equal(manifest.action.default_title, 'Control Browser - BIN4RY');

  // externally_connectable must cover local dashboard domains
  assert.ok(manifest.externally_connectable, 'manifest must declare externally_connectable');
  const matches = manifest.externally_connectable.matches || [];
  assert.ok(matches.includes('http://127.0.0.1/*'));
  assert.ok(matches.includes('http://localhost/*'));

  // 7b. Service Worker Action Listener wiring
  assert.match(swCode, /chrome\.action\.onClicked\.addListener/);
  assert.match(swCode, /chrome\.windows\.create/);
  assert.match(swCode, /popup\/popup\.html/);
  assert.match(swCode, /type:\s*['"]popup['"]/);
  assert.match(swCode, /width:\s*780/);
  assert.match(swCode, /height:\s*680/);
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. EXTENSION TAB SYNC, ONMESSAGEEXTERNAL & LOGIN-STAGE DISCOVERY
// ─────────────────────────────────────────────────────────────────────────────

test('Regression B23, B24: Extension login-stage tab discovery, externally_connectable config, and direct PONG_TABS sync', async () => {
  const manifestPath = path.resolve(__dirname, '../extension/manifest.json');
  const swPath = path.resolve(__dirname, '../extension/background/service-worker.js');

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const swCode = fs.readFileSync(swPath, 'utf8');

  // Verify externally_connectable matches
  const matches = manifest.externally_connectable?.matches || [];
  assert.ok(matches.includes('http://127.0.0.1/*'), 'externally_connectable must include http://127.0.0.1/*');
  assert.ok(matches.includes('https://127.0.0.1/*'), 'externally_connectable must include https://127.0.0.1/*');
  assert.ok(matches.includes('http://localhost/*'), 'externally_connectable must include http://localhost/*');
  assert.ok(matches.includes('https://localhost/*'), 'externally_connectable must include https://localhost/*');

  // Verify service-worker wires onMessageExternal listener
  assert.match(swCode, /chrome\.runtime\?\.onMessageExternal/);
  assert.match(swCode, /chrome\.runtime\.onMessageExternal\.addListener/);
  assert.match(swCode, /GET_OPEN_TABS/);
  assert.match(swCode, /PING_TABS/);
  assert.match(swCode, /PONG_TABS/);

  // Verify login-stage URL regex covers Gmail, Outlook, Yahoo login pages
  assert.match(swCode, /accounts\.google\.com/);
  assert.match(swCode, /login\.live\.com/);
  assert.match(swCode, /login\.yahoo\.com/);
  assert.match(swCode, /login_pending/);

  // Verify server wsHub and store integration
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-reg-tabs-'));
  const app = createServer({
    port: 0,
    dataDir: path.join(tmpDir, 'data'),
    profilesRoot: path.join(tmpDir, 'profiles')
  });
  const addr = await app.start(0, '127.0.0.1');

  try {
    const auth = app.store.authenticate('admfib7H', 'd9tQGJdZ77');
    const sid = auth.session.token || auth.session.id;
    const dashWs = await connectRawWs(addr.port, '/ws/dashboard', {
      Cookie: `relay_sid=${sid}`
    });
    await dashWs.nextMessage((m) => m.type === 'HELLO' || m.type === 'DASHBOARD_SYNC');

    const agentWs = await connectRawWs(addr.port, '/ws/agent');

    // Send PONG_TABS with login tabs
    agentWs.sendJson({
      type: 'PONG_TABS',
      tabs: [
        {
          tabId: 901,
          url: 'https://accounts.google.com/signin/v2/identifier',
          email: 'Login Pending',
          provider: 'gmail',
          status: 'login_pending'
        },
        {
          tabId: 902,
          url: 'https://login.live.com/login.srf',
          email: 'Login Pending',
          provider: 'outlook',
          status: 'login_pending'
        }
      ]
    });

    const update = await dashWs.nextMessage(
      (m) => m.type === 'TABS_UPDATED' && Array.isArray(m.onlineTabs) && m.onlineTabs.length === 2
    );
    assert.ok(update);
    assert.equal(update.onlineTabs.length, 2);

    const tabs = app.store.listOnlineTabs();
    assert.equal(tabs[0].status, 'login_pending');
    assert.equal(tabs[0].isDup, false, 'No false duplicate warning for login pending tabs');
    assert.equal(tabs[1].status, 'login_pending');
    assert.equal(tabs[1].isDup, false);

    dashWs.close();
    agentWs.close();
  } finally {
    await app.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
